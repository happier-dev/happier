import { stringify } from 'yaml';

/**
 * A stored Compose definition as people read it. Some producers store the normalized document as JSON, which is
 * valid Compose but unreadable on one line; it reads as YAML. Authored YAML stays verbatim (comments, order).
 */
export function storedComposeDocumentText(document: string): string {
  if (!document.trimStart().startsWith('{')) return document;
  try {
    return stringify(JSON.parse(document));
  } catch {
    return document;
  }
}
