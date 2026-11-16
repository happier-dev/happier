import { describe, expect, it } from 'vitest';
import { isMap, parseDocument } from 'yaml';
import { storedComposeDocumentText } from './storedComposeDocumentText';

describe('stored Compose document text', () => {
  it('reads a document stored as normalized JSON as the YAML it is', () => {
    const document = { services: { web: { image: 'example/web:1', restart: 'on-failure' } } };
    const text = storedComposeDocumentText(JSON.stringify(document));
    const yaml = parseDocument(text);
    expect(yaml.errors).toEqual([]);
    expect(yaml.toJS()).toEqual(document);
    expect(isMap(yaml.contents) && yaml.contents.flow !== true).toBe(true);
    expect(text.trim()).toContain('\n');
  });

  it('keeps authored YAML verbatim, comments and order included', () => {
    const authored = '# production\nservices:\n  web:\n    image: example/web:1\n';
    expect(storedComposeDocumentText(authored)).toBe(authored);
  });
});
