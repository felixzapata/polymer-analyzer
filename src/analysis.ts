/**
 * @license
 * Copyright (c) 2015 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at
 * http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at
 * http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 */

import * as fs from 'fs';
import * as jsonschema from 'jsonschema';
import * as path from 'path';
import * as util from 'util';

import {Descriptor, DocumentDescriptor, ElementDescriptor, ImportDescriptor, InlineDocumentDescriptor, Property} from './ast/ast';
import {Elements} from './elements-format';
import {JsonDocument} from './json/json-document';
import {BehaviorDescriptor} from './polymer/behavior-descriptor';
import {PolymerElementDescriptor} from './polymer/element-descriptor';

const validator = new jsonschema.Validator();
const schema = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'analysis.schema.json'), 'utf-8'));

export class ValidationError extends Error {
  errors: jsonschema.ValidationError[];
  constructor(result: jsonschema.ValidationResult) {
    const message = `Unable to validate serialized Polymer analysis. ` +
        `Got ${result.errors.length} errors: ` +
        `${result.errors.map(err => '    ' + (err.message || err)).join('\n')}`;
    super(message);
    this.errors = result.errors;
  }
}


export class Analysis {
  private _descriptors: DocumentDescriptor[];
  private _elementsByTagName = new Map<string, ElementDescriptor>();
  private _elementsByPackageDir = new Map<string, ElementDescriptor[]>();
  private _behaviorsByIdentifierName = new Map<string, BehaviorDescriptor>();
  private _documentsByLocalPath = new Map<string, DocumentDescriptor>();

  constructor(descriptors: DocumentDescriptor[]) {
    this._descriptors = descriptors;
    const packageGatherer = new PackageGatherer();
    const elementsGatherer = new ElementGatherer();
    new AnalysisWalker(this._descriptors).walk([
      packageGatherer, elementsGatherer
    ]);

    for (const behavior of elementsGatherer.behaviorDescriptors) {
      if (behavior.className) {
        this._behaviorsByIdentifierName.set(behavior.className, behavior);
      }
    }

    // Index the elements that we found by their tag names and package names.
    for (const originalElement of elementsGatherer.elementDescriptors) {
      const element = resolveElement(originalElement, this);
      if (element.tagName) {
        this._elementsByTagName.set(element.tagName, element);
      }
      let elementPath = elementsGatherer.elementPaths.get(originalElement);
      const matchingPackageDirs =
          Array.from(packageGatherer.packageDirs)
              .filter(dir => elementPath.startsWith(dir));
      const longestMatchingPackageDir =
          max(matchingPackageDirs,
              (a, b) => a != null && a.length - b.length || -1) ||
          '';

      const elementsInPackage =
          this._elementsByPackageDir.get(longestMatchingPackageDir) || [];
      elementsInPackage.push(element);
      this._elementsByPackageDir.set(
          longestMatchingPackageDir, elementsInPackage);
    }

    for (const dd of this._descriptors) {
      this._documentsByLocalPath.set(dd.url, dd);
    }
  }

  getElement(tag: string): ElementDescriptor|undefined {
    return this._elementsByTagName.get(tag);
  }

  getElements(): ElementDescriptor[] {
    return Array.from(this._elementsByTagName.values());
  }

  getElementsForPackage(dirName: string): ElementDescriptor[]|undefined {
    return this._elementsByPackageDir.get(dirName);
  }

  /**
   * Get the behavior corresponding to the given name.
   *
   * e.g. this would be identified as 'My.Behavior'
   * /* @polymerBehavior \*\/
   * var My.Behavior = {...};
   *
   * and this would be identifier as 'AwesomeBehavior'
   * /* @polymerBehavior AwesomeBehavior \*\/
   * var My.Behavior = {...};
   */
  getBehavior(name: string): BehaviorDescriptor|undefined {
    return this._behaviorsByIdentifierName.get(name);
  }

  getDocument(path: string): DocumentDescriptor|undefined {
    return this._documentsByLocalPath.get(path);
  }

  /**
   * Throws if the given object isn't a valid AnalyzedPackage according to
   * the JSON schema.
   */
  static validate(analyzedPackage: Elements|null|undefined) {
    const result = validator.validate(analyzedPackage, schema);
    if (result.throwError) {
      throw result.throwError;
    }
    if (result.errors.length > 0) {
      throw new ValidationError(result);
    }
    if (!/^1\.\d+\.\d+$/.test(analyzedPackage!.schema_version)) {
      throw new Error(
          `Invalid schema_version in AnalyzedPackage. ` +
          `Expected 1.x.x, got ${analyzedPackage!.schema_version}`);
    }
  }
}

const packageFileNames = new Set(['package.json', 'bower.json']);
class PackageGatherer implements AnalysisVisitor {
  packageDirs = new Set<string>();
  visitDocumentDescriptor(dd: DocumentDescriptor): void {
    if (dd.document instanceof JsonDocument &&
        packageFileNames.has(path.basename(dd.document.url))) {
      const dirname = path.dirname(dd.document.url);
      if (!this.packageDirs.has(dirname)) {
        this.packageDirs.add(dirname);
      }
    }
  }
}

/**
 * Visit the descriptor forest and gather up all elements and behaviors, as
 * well as their resolved urls.
 */
class ElementGatherer implements AnalysisVisitor {
  elementDescriptors: ElementDescriptor[] = [];
  elementPaths = new Map<ElementDescriptor, string>();

  behaviorDescriptors: BehaviorDescriptor[] = [];
  behaviorPaths = new Map<BehaviorDescriptor, string>();
  visitElement(elementDescriptor: ElementDescriptor, ancestors: Descriptor[]):
      void {
    const elementPath = this._getPathFromAncestors(ancestors);
    if (!elementPath) {
      throw new Error(
          `Unable to determine path to element: ${elementDescriptor}`);
    }
    if (this.elementPaths.has(elementDescriptor)) {
      if (this.elementPaths.get(elementDescriptor) !== elementPath) {
        throw new Error(
            `Found element ${elementDescriptor} at distinct paths: ` +
            `${elementPath} and ${this.elementPaths.get(elementDescriptor)}`);
      }
      return;
    }

    this.elementPaths.set(elementDescriptor, elementPath);
    this.elementDescriptors.push(elementDescriptor);
  }

  visitBehavior(
      behaviorDescriptor: BehaviorDescriptor, ancestors: Descriptor[]): void {
    const path = this._getPathFromAncestors(ancestors);
    if (!path) {
      throw new Error(
          `Unable to determine path to behavior: ${behaviorDescriptor}`);
    }
    if (this.behaviorPaths.has(behaviorDescriptor)) {
      if (this.behaviorPaths.get(behaviorDescriptor) !== path) {
        throw new Error(
            `Found element ${behaviorDescriptor} at distinct paths: ` +
            `${path} and ${this.behaviorPaths.get(behaviorDescriptor)}`);
      }
      return;
    }

    this.behaviorPaths.set(behaviorDescriptor, path);
    this.behaviorDescriptors.push(behaviorDescriptor);
  }

  /**
   * The path of an element is the path of the closest containing document
   * parent that has a url.
   */
  _getPathFromAncestors(ancestors: Descriptor[]): string|undefined {
    const documentAncestors = <DocumentDescriptor[]>ancestors.filter(
        d => d instanceof DocumentDescriptor && d.url);
    const nearestDocument = documentAncestors[documentAncestors.length - 1];
    return nearestDocument && nearestDocument.url;
  }
}

abstract class AnalysisVisitor {
  visitDocumentDescriptor?
      (dd: DocumentDescriptor, ancestors: Descriptor[]): void;
  visitInlineDocumentDescriptor?
      (dd: InlineDocumentDescriptor<any>, ancestors: Descriptor[]): void;
  visitElement?(element: ElementDescriptor, ancestors: Descriptor[]): void;
  visitBehavior?(behavior: BehaviorDescriptor, ancestors: Descriptor[]): void;
  visitImportDescriptor?
      (importDesc: ImportDescriptor<any>, ancestors: Descriptor[]): void;
  done?(): void;
}

/**
 * Walks the descriptor forest and calls into any visitors it's given.
 *
 * Keeps track of the ancestors of the current node.
 */
class AnalysisWalker {
  private _documents: DocumentDescriptor[];
  private _ancestors: Descriptor[] = [];

  constructor(descriptors: DocumentDescriptor[]) {
    this._documents = descriptors;
  }
  walk(visitors: AnalysisVisitor[]) {
    this._ancestors.length = 0;
    for (const descriptor of this._documents) {
      this._walkDocumentDescriptor(descriptor, visitors);
    }
    for (const visitor of visitors) {
      if (visitor.done) {
        visitor.done();
      }
    }
  }

  private _walkDocumentDescriptor(
      dd: DocumentDescriptor, visitors: AnalysisVisitor[]) {
    this._ancestors.push(dd);

    for (const visitor of visitors) {
      if (visitor.visitDocumentDescriptor) {
        visitor.visitDocumentDescriptor(dd, this._ancestors);
      }
    }

    for (const entity of dd.entities) {
      this._walkEntity(entity, visitors);
    }
    for (const dependency of dd.dependencies) {
      this._walkEntity(dependency, visitors);
    }
    this._ancestors.pop();
  }

  private _walkInlineDocumentDescriptor(
      dd: InlineDocumentDescriptor<any>, visitors: AnalysisVisitor[]) {
    for (const visitor of visitors) {
      if (visitor.visitInlineDocumentDescriptor) {
        visitor.visitInlineDocumentDescriptor(dd, this._ancestors);
      }
    }
  }

  private _walkEntity(entity: Descriptor, visitors: AnalysisVisitor[]) {
    if (entity == null) {
      return;
    }
    if (entity instanceof DocumentDescriptor) {
      return this._walkDocumentDescriptor(entity, visitors);
    } else if (entity instanceof InlineDocumentDescriptor) {
      return this._walkInlineDocumentDescriptor(entity, visitors);
    } else if (entity instanceof BehaviorDescriptor) {
      return this._walkBehavior(entity, visitors);
    } else if (entity instanceof ElementDescriptor) {
      return this._walkElement(entity, visitors);
    } else if (entity instanceof ImportDescriptor) {
      return this._walkImportDescriptor(entity, visitors);
    }
    throw new Error(`Unknown kind of descriptor: ${util.inspect(entity)}`);
  }

  private _walkElement(
      element: ElementDescriptor, visitors: AnalysisVisitor[]) {
    for (const visitor of visitors) {
      if (visitor.visitElement) {
        visitor.visitElement(element, this._ancestors);
      }
    }
  }

  private _walkBehavior(
      behavior: BehaviorDescriptor, visitors: AnalysisVisitor[]) {
    for (const visitor of visitors) {
      if (visitor.visitBehavior) {
        visitor.visitBehavior(behavior, this._ancestors);
      }
    }
  }

  private _walkImportDescriptor(
      importDesc: ImportDescriptor<any>, visitors: AnalysisVisitor[]) {
    for (const visitor of visitors) {
      if (visitor.visitImportDescriptor) {
        visitor.visitImportDescriptor(importDesc, this._ancestors);
      }
    }
  }
}

function max<T>(arr: T[], comparison: (t1: T | undefined, t2: T) => number): T|
    undefined {
  return arr.reduce((prev, cur) => {
    return comparison(prev, cur) > 0 ? prev : cur;
  }, undefined);
}

function resolveElement(
    elementDescriptor: ElementDescriptor, analysis: Analysis) {
  let properties = elementDescriptor.properties;
  let attributes = elementDescriptor.attributes;
  let events = elementDescriptor.events;
  if (elementDescriptor instanceof PolymerElementDescriptor) {
    const behaviors = Array.from(getFlattenedAndResolvedBehaviors(
        elementDescriptor.behaviors, analysis));
    ;
    properties = mergeByName(
        properties,
        behaviors.map(b => ({name: b.className, vals: b.properties})));
    attributes = mergeByName(
        attributes,
        behaviors.map(b => ({name: b.className, vals: b.attributes})));
    events = mergeByName(
        events, behaviors.map(b => ({name: b.className, vals: b.events})));
  }

  const clone = <ElementDescriptor>{};
  for (const key in elementDescriptor) {
    clone[key] = elementDescriptor[key];
  }
  clone.properties = properties;
  clone.attributes = attributes;
  clone.events = events;
  return clone;
}

function getFlattenedAndResolvedBehaviors(
    behaviors: (string | BehaviorDescriptor)[], analysis: Analysis) {
  const resolvedBehaviors = new Set<BehaviorDescriptor>();
  _getFlattenedAndResolvedBehaviors(behaviors, analysis, resolvedBehaviors);
  return resolvedBehaviors;
}

function _getFlattenedAndResolvedBehaviors(
    behaviors: (string | BehaviorDescriptor)[], analysis: Analysis,
    resolvedBehaviors: Set<BehaviorDescriptor>) {
  const toLookup = behaviors.slice();
  for (let behavior of toLookup) {
    if (typeof behavior === 'string') {
      const behaviorName = behavior;
      behavior = analysis.getBehavior(behavior);
      if (!behavior) {
        throw new Error(
            `Unable to resolve behavior \`${behaviorName}\` ` +
            `Did you import it? Is it annotated with @polymerBehavior?`);
      }
    }
    if (resolvedBehaviors.has(behavior)) {
      continue;
    }
    resolvedBehaviors.add(behavior);
    _getFlattenedAndResolvedBehaviors(
        behavior.behaviors, analysis, resolvedBehaviors);
  }
}

function mergeByName<T extends{name: string, inheritedFrom?: string}>(
    base: T[], inheritFrom: {name: string, vals: T[]}[]): T[] {
  const byName = new Map<string, T>();
  for (const initial of base) {
    byName.set(initial.name, initial);
  }
  for (const source of inheritFrom) {
    for (const item of source.vals) {
      if (!byName.has(item.name)) {
        const copy = Object.assign({}, item);
        copy.inheritedFrom = source.name;
        byName.set(copy.name, copy);
      }
    }
  }
  return Array.from(byName.values());
}
