import { describe, expect, it } from 'vitest';

import { parseMarkdownSpans } from './parseMarkdownSpans';

function plainSpanTexts(res: ReturnType<typeof parseMarkdownSpans>) {
  return res.map((s) => ({ text: s.text, url: s.url, styles: s.styles }));
}

describe('parseMarkdownSpans (auto-link)', () => {
  it('auto-links plain https:// URLs in text', () => {
    const spans = plainSpanTexts(parseMarkdownSpans('see https://example.com now', false));
    expect(spans).toEqual([
      { text: 'see ', url: null, styles: [] },
      { text: 'https://example.com', url: 'https://example.com', styles: [] },
      { text: ' now', url: null, styles: [] },
    ]);
  });

  it('auto-links plain www. URLs and normalizes to https', () => {
    const spans = plainSpanTexts(parseMarkdownSpans('go to www.example.com', false));
    expect(spans).toEqual([
      { text: 'go to ', url: null, styles: [] },
      { text: 'www.example.com', url: 'https://www.example.com', styles: [] },
    ]);
  });

  it('trims trailing punctuation from auto-links', () => {
    const spans = plainSpanTexts(parseMarkdownSpans('see (https://example.com), ok', false));
    expect(spans).toEqual([
      { text: 'see (', url: null, styles: [] },
      { text: 'https://example.com', url: 'https://example.com', styles: [] },
      { text: '),', url: null, styles: [] },
      { text: ' ok', url: null, styles: [] },
    ]);
  });

  it('does not auto-link inside inline code spans', () => {
    const spans = plainSpanTexts(parseMarkdownSpans('`https://example.com`', false));
    expect(spans).toEqual([
      { text: 'https://example.com', url: null, styles: ['code'] },
    ]);
  });
});
