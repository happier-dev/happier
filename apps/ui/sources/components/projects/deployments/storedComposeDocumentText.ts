import { isDocument, isMap, parseDocument, Scalar, stringify, visit, type Document } from 'yaml';

/**
 * A stored Compose definition as people read it. Some producers store the normalized document as JSON, which is
 * valid Compose but unreadable on one line; it reads as YAML. Ordinary authored YAML stays verbatim.
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
  if (document.trimStart().startsWith('{')) {
    try {
      return stringify(JSON.parse(document), options);
    } catch {
      return document;
    }
  }
  // Older private exports wrote JSON-derived nodes as block YAML while retaining their JSON quotes.
  if (!/^"services":\s*$/m.test(document)) return document;
  const stored = parseDocument(document);
  if (stored.errors.length > 0 || !isMap(stored.contents)) return document;
  const services = stored.get('services', true);
  if (!isMap(services) || services.items.length === 0 || !services.items.every(({ key }) =>
    key instanceof Scalar && key.type === Scalar.QUOTE_DOUBLE)) return document;
  visit(stored, { Scalar(_key, node) {
    if (node.type === Scalar.QUOTE_DOUBLE && typeof node.value === 'string') node.type = undefined;
  } });
  return stringify(stored, options);
}
