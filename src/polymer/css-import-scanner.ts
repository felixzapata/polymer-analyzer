/**
 * @license
 * Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
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

import * as dom5 from 'dom5';
import {resolve as resolveUrl} from 'url';

import {HtmlVisitor, ParsedHtmlDocument} from '../html/html-document';
import {HtmlScanner} from '../html/html-scanner';
import {ScannedImport} from '../model/model';

const p = dom5.predicates;

const isCssImportNode = p.AND(
    p.hasTagName('link'), p.hasSpaceSeparatedAttrValue('rel', 'import'),
    p.hasAttr('href'), p.hasAttrValue('type', 'css'),
    p.parentMatches(p.hasTagName('dom-module')));

export class CssImportScanner implements HtmlScanner {
  async scan(
      document: ParsedHtmlDocument,
      visit: (visitor: HtmlVisitor) => Promise<void>):
      Promise<ScannedImport[]> {
    const imports: ScannedImport[] = [];

    await visit((node) => {
      if (isCssImportNode(node)) {
        const href = dom5.getAttribute(node, 'href')!;
        const importUrl = resolveUrl(document.url, href);
        imports.push(new ScannedImport(
            'css-import', importUrl, document.sourceRangeForNode(node)!,
            document.sourceRangeForAttributeValue(node, 'href')!, node));
      }
    });
    return imports;
  }
}
