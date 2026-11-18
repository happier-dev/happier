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

  it('reads a legacy shared PostgreSQL definition with quoted JSON nodes as readable Compose', () => {
    const stored = '"services":\n  "database":\n    "image": "postgres:17"\n    # Keep the private publication.\n    "ports":\n      - target: 5432\n        published: "15433"\n        host_ip: 127.0.0.1\n        protocol: tcp\n';
    const text = storedComposeDocumentText(stored);
    expect(text).toContain('services:\n  database:\n    image: postgres:17');
    expect(text).toContain('# Keep the private publication.');
    expect(parseDocument(text).toJS()).toEqual(parseDocument(stored).toJS());
  });
});
