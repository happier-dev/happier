import { isDocument, stringify, type Document } from 'yaml';

/**
 * A stored Compose definition as people read it. Some producers store the normalized document as JSON, which is
 * valid Compose but unreadable on one line; it reads as YAML. Authored YAML stays verbatim (comments, order).
 */
export function storedComposeDocumentText(document: string | Document): string {
  // Edited documents keep their comments and aliases, but never inherit JSON flow style or fold interpolation tokens.
  if (isDocument(document)) return stringify(document, { collectionStyle: 'block', lineWidth: 0 });
  if (!document.trimStart().startsWith('{')) return document;
  try {
    return stringify(JSON.parse(document), { lineWidth: 0 });
  } catch {
    return document;
  }
}
