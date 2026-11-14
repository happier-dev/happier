import { load } from 'cheerio';
import type { CssNode } from 'css-tree';
import generate from 'css-tree/generator';
import parse from 'css-tree/parser';
import walk from 'css-tree/walker';
import { ident } from 'css-tree/utils';
import TurndownService from 'turndown';

import type { EmailContentOptions } from './parse.js';

const signatureSelector = '#Signature, .gmail_signature, .AppleMailSignature, .moz-signature';
const historySelector = '.gmail_quote, blockquote, .moz-cite-prefix, #divRplyFwdMsg, #appendonsend';
const forwardMarker = /-{2,}\s*(?:Forwarded message|Message transf[\u00E9e]r[\u00E9e]|Weitergeleitete Nachricht)|Begin forwarded message\s*:|D\u00E9but du message (?:transf\u00E9r\u00E9|r\u00E9exp\u00E9di\u00E9)\s*:|(?:Weitergeleitete Nachricht|Message transf\u00E9r\u00E9)\s*:/i;
const forwardedSubject = /^\s*(?:fwd?|tr|wg)\s*:/i;
const replyLine = /^\s*(?:On\b.+\bwrote\s*:|Le\b.+\ba \u00E9crit\s*:|Am\b.+\bschrieb\b.*:|[- ]*(?:Original Message|Message d'origine|Urspr\u00FCngliche Nachricht)[- ]*)\s*$/i;
const outlookHeaderLine = /^\s*(?:\*\*|__)?(?:(From|De|Von)|(Sent|Envoy\u00E9|Gesendet|Date|Datum)|(To|Cc|\u00C0|An|Subject|Objet|Betreff))\s*:/i;
const mobileSignatureLine = /^(?:Sent from my (?:iPhone|iPad)|Envoy\u00E9 (?:de|depuis) mon (?:iPhone|iPad)|Von meinem (?:iPhone|iPad) gesendet|Envoy\u00E9 \u00E0 partir de Outlook pour iOS(?:<https?:\/\/[^>]+>)?)\s*$/i;

function normalizeText(text: string) {
  return text.replace(/\r\n?/g, '\n').replace(/[\t ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function outlookHeaderIndex(lines: readonly string[]) {
  let start = -1;
  let hasFrom = false;
  let hasTimestamp = false;
  for (const [index, line] of lines.entries()) {
    const header = outlookHeaderLine.exec(line);
    if (!header) {
      start = -1;
      hasFrom = false;
      hasTimestamp = false;
      continue;
    }
    if (start < 0) start = index;
    hasFrom ||= header[1] !== undefined;
    hasTimestamp ||= header[2] !== undefined;
    if (hasFrom && hasTimestamp) return start;
  }
  return -1;
}

function removePlainHistory(text: string) {
  const lines = text.split('\n');
  const outlookIndex = outlookHeaderIndex(lines);
  return (outlookIndex < 0 ? lines : lines.slice(0, outlookIndex))
    .filter((line) => !/^\s*>/.test(line) && !replyLine.test(line)).join('\n');
}

function removePlainSignature(text: string) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^-- $/.test(line) || mobileSignatureLine.test(line));
  if (start < 0) return text;
  // A retained conversation may follow the author's signature. Do not consume it.
  const history = lines.findIndex((line, index) => index > start && (replyLine.test(line) || outlookHeaderLine.exec(line)?.[1] !== undefined || /^\s*>/.test(line)));
  return [...lines.slice(0, start), ...(history < 0 ? [] : lines.slice(history))].join('\n');
}

function shapePlain(text: string, options: EmailContentOptions, forwarded: boolean) {
  const normalized = text.replace(/\r\n?/g, '\n');
  const marker = forwardMarker.exec(normalized);
  const lines = normalized.split('\n');
  const outlookIndex = forwarded ? outlookHeaderIndex(lines) : -1;
  const forwardStart = marker?.index ?? (outlookIndex < 0 ? null : lines.slice(0, outlookIndex).join('\n').length + (outlookIndex > 0 ? 1 : 0));
  // Without a structural marker there is no safe boundary inside a forward.
  if (forwarded && forwardStart === null) return normalizeText(normalized);
  let ownText = forwardStart === null ? normalized : normalized.slice(0, forwardStart);
  if (options.stripSignatures !== false) ownText = removePlainSignature(ownText);
  if (options.quotedHistory === 'always' || (options.quotedHistory !== 'never' && options.knownThread === true)) {
    ownText = removePlainHistory(ownText);
  }
  return normalizeText([ownText, forwardStart === null ? '' : normalized.slice(forwardStart)].filter(Boolean).join('\n\n'));
}

function cssDeclarations(ast: CssNode) {
  const declarations = new Map<string, string>();
  walk(ast, (node) => {
    if (node.type !== 'Declaration') return;
    walk(node.value, (part) => {
      if (part.type === 'Identifier') part.name = ident.decode(part.name);
      if (part.type === 'Dimension') part.unit = ident.decode(part.unit);
      if ((part.type === 'Dimension' || part.type === 'Number' || part.type === 'Percentage') && Number(part.value) === 0) part.value = '0';
    });
    declarations.set(ident.decode(node.property).toLowerCase(), generate(node.value).toLowerCase());
  });
  return declarations;
}

function hasHiddenDeclaration(declarations: ReadonlyMap<string, string>) {
  return [...declarations].some(([property, value]) => {
    if ((property === 'display' && value === 'none') ||
      (property === 'visibility' && (value === 'hidden' || value === 'collapse')) ||
      (property === 'font-size' && /^0(?:[a-z%]+)?$/.test(value)) ||
      (property === 'mso-hide' && value === 'all')) return true;
    return false;
  });
}

function pixelSize(value: string | undefined) {
  if (value === undefined || !/^\d+(?:\.\d+)?(?:px)?$/i.test(value)) return null;
  return Number.parseFloat(value);
}

function imageContentId(source: string | undefined) {
  if (source === undefined || !/^cid:/i.test(source)) return null;
  try {
    // RFC 2392 maps URL-escaped cid values to the opaque Content-ID header.
    return decodeURIComponent(source.slice(4));
  } catch {
    return null;
  }
}

// Turndown's table rule supplies native or Domino DOM elements. Its ambient
// HTMLElement type is empty in Node hosts; name only the DOM members we use.
interface TurndownTableElement {
  readonly nodeName: string;
  readonly innerHTML: string;
  readonly children: ArrayLike<TurndownTableElement>;
  querySelectorAll(selector: string): ArrayLike<TurndownTableElement>;
  querySelector(selector: string): TurndownTableElement | null;
}

function markdownFromHtml(html: string) {
  const converter = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' });
  // Turndown's core handles links/lists; this consumed rule retains mail tables.
  converter.addRule('emailTables', {
    filter: 'table',
    replacement: (_content, node) => {
      const rows = Array.from((node as TurndownTableElement).querySelectorAll('tr')).map((row) => Array.from(row.children)
        .filter((cell) => cell.nodeName === 'TD' || cell.nodeName === 'TH')
        .map((cell) => converter.turndown(cell.innerHTML).replace(/\|/g, '\\|').replace(/\n/g, ' ')));
      if (!rows.length) return '';
      const firstRow = rows[0] ?? [];
      const hasHeading = (node as TurndownTableElement).querySelector('tr th') !== null;
      const headings = hasHeading ? firstRow : firstRow.map(() => '');
      const body = hasHeading ? rows.slice(1) : rows;
      return `\n\n${[headings, headings.map(() => '---'), ...body].map((row) => `| ${row.join(' | ')} |`).join('\n')}\n\n`;
    },
  });
  return converter.turndown(html);
}

export function shapeEmailBody(body: { html: string | null; text: string; subject: string }, options: EmailContentOptions) {
  if (body.html === null) {
    const forwarded = forwardedSubject.test(body.subject) || forwardMarker.test(body.text);
    return { text: shapePlain(body.text, options, forwarded), forwarded, signatureOnlyCids: new Set<string>() };
  }

  const $ = load(body.html);
  const elementStyles = new WeakMap<object, ReadonlyMap<string, string>>();
  // Parse CSS rather than interpreting CSS grammar with string splitting. These
  // static hidden declarations are removed before style tags disappear; this is
  // content shaping, not a browser layout/cascade implementation.
  $('style').each((_index, element) => {
    walk(parse($(element).text()), (node) => {
      if (node.type !== 'Rule' || !node.prelude) return;
      const declarations = cssDeclarations(node.block);
      try {
        const matching = $(generate(node.prelude));
        matching.each((_matchIndex, match) => {
          elementStyles.set(match, new Map([...(elementStyles.get(match) ?? []), ...declarations]));
        });
        if (hasHiddenDeclaration(declarations)) matching.remove();
      } catch {
        // Unsupported/invalid selectors do not match content in this DOM.
      }
    });
  });
  $('[style]').each((_index, element) => {
    const declarations = cssDeclarations(parse($(element).attr('style') ?? '', { context: 'declarationList' }));
    const effective = new Map([...(elementStyles.get(element) ?? []), ...declarations]);
    elementStyles.set(element, effective);
    if (hasHiddenDeclaration(effective)) $(element).remove();
  });
  $('script, style, head, template, [hidden], input[type="hidden"]').remove();
  $('*').add($.root()).contents().filter((_index, node) => node.type === 'comment').remove();
  $('img').each((_index, element) => {
    const image = $(element);
    const styles = elementStyles.get(element);
    const width = pixelSize(styles?.get('width') ?? image.attr('width'));
    const height = pixelSize(styles?.get('height') ?? image.attr('height'));
    if (width !== null && height !== null && width <= 1 && height <= 1) image.remove();
  });

  const forwarded = forwardedSubject.test(body.subject) || forwardMarker.test($.root().text());
  if (forwarded) {
    $(historySelector).each((_index, element) => {
      const quote = $(element);
      if (forwardedSubject.test(body.subject) || forwardMarker.test(quote.text())) {
        quote.attr('data-email-forwarded', 'true');
        if (quote.is('#divRplyFwdMsg, #appendonsend')) quote.nextAll().attr('data-email-forwarded', 'true');
      }
    });
    // Some clients put the forward delimiter outside their quote wrapper.
    $('p, div').each((_index, element) => {
      const block = $(element);
      if (forwardMarker.test(block.text()) && !block.children().toArray().some((child) => forwardMarker.test($(child).text()))) {
        block.attr('data-email-forwarded', 'true').nextAll().attr('data-email-forwarded', 'true');
      }
    });
  }
  const signatureCids = new Set<string>();
  if (options.stripSignatures !== false) {
    $(signatureSelector).each((_index, element) => {
      const signature = $(element);
      if (signature.closest('[data-email-forwarded]').length) return;
      signature.find('img').each((_imageIndex, image) => {
        const cid = imageContentId($(image).attr('src'));
        if (cid !== null) signatureCids.add(cid);
      });
      signature.remove();
    });
  }
  const bodyCids = new Set($('img').toArray().map((element) => imageContentId($(element).attr('src'))));
  const signatureOnlyCids = new Set([...signatureCids].filter((cid) => !bodyCids.has(cid)));

  if (options.quotedHistory === 'always' || (options.quotedHistory !== 'never' && options.knownThread === true)) {
    $(historySelector).each((_index, element) => {
      const history = $(element);
      if (history.closest('[data-email-forwarded]').length || history.find('[data-email-forwarded]').length) return;
      if (history.is('#divRplyFwdMsg, #appendonsend')) history.nextAll().not('[data-email-forwarded]').remove();
      history.remove();
    });
  }
  $('img').each((_index, element) => {
    const image = $(element);
    if (imageContentId(image.attr('src')) === null) return;
    image.replaceWith($('<span>').text(`[Inline image: ${image.attr('alt') || 'attached image'}]`));
  });

  let converted: string;
  if (options.bodyFormat === 'text') {
    $('br').replaceWith('\n');
    $('p, div, li, tr, blockquote, h1, h2, h3, h4, h5, h6').append('\n');
    $('td, th').append('\t');
    converted = $.root().text();
  } else converted = markdownFromHtml($.html());
  return { text: shapePlain(converted, options, forwarded), forwarded, signatureOnlyCids };
}
