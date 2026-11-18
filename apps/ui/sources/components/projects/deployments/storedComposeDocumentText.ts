import { isDocument, stringify, type Document } from 'yaml';

/**
 * A stored Compose definition as people read it. Some producers store the normalized document as JSON, which is
 * valid Compose but unreadable on one line; it reads as YAML. Authored YAML stays verbatim (comments, order).
 */
export function storedComposeDocumentText(document: string | Document): string {
  const options = { collectionStyle: 'block' as const, lineWidth: 0,
    defaultKeyType: 'PLAIN' as const, defaultStringType: 'PLAIN' as const };
  // Edited YAML documents keep their comments and aliases. A JSON-shaped Document is normalized from its value so
  // its flow-style node metadata cannot force every key to be quoted in the stored Compose text.
  if (isDocument(document)) {
    const source = document.toString();
    return source.trimStart().startsWith('{') ? stringify(document.toJSON(), options) : stringify(document, options);
  }
  if (!document.trimStart().startsWith('{')) return document;
  try {
    return stringify(JSON.parse(document), options);
  } catch {
    return document;
  }
}
