import { describe, expect, it } from 'vitest';
import { storedComposeDocumentText } from './storedComposeDocumentText';

describe('stored Compose document text', () => {
  it('reads a document stored as normalized JSON as the YAML it is', () => {
    const text = storedComposeDocumentText(JSON.stringify({ services: { web: { image: 'example/web:1', restart: 'on-failure' } } }));
    expect(text).toBe('services:\n  web:\n    image: example/web:1\n    restart: on-failure\n');
  });

  it('keeps authored YAML verbatim, comments and order included', () => {
    const authored = '# production\nservices:\n  web:\n    image: example/web:1\n';
    expect(storedComposeDocumentText(authored)).toBe(authored);
  });
});
