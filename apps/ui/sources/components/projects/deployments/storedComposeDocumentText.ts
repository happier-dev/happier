import { isDocument, stringify, type Document } from 'yaml';

/**
 * A stored Compose definition as people read it. Some producers store the normalized document as JSON, which is
 * valid Compose but unreadable on one line; it reads as YAML. Authored YAML stays verbatim (comments, order).
 */
export function storedComposeDocumentText(document: string | Document): string {
  const options = { collectionStyle: 'block' as const, lineWidth: 0,
    defaultKeyType: 'PLAIN' as const, defaultStringType: 'PLAIN' as const };
  // Edited documents keep their comments and aliases, but never inherit JSON flow style or fold interpolation tokens.
  if (isDocument(document)) return stringify(document, options);
  if (!document.trimStart().startsWith('{')) return document;
  try {
    return stringify(JSON.parse(document), options);
  } catch {
    return document;
  }
}
