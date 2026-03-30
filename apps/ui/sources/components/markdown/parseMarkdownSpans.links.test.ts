import { describe, expect, it } from 'vitest';

import { parseMarkdownSpans } from './parseMarkdownSpans';

function plainSpanTexts(res: ReturnType<typeof parseMarkdownSpans>) {
  return res.map((s) => ({ text: s.text, url: s.url, styles: s.styles }));
}

describe('parseMarkdownSpans (explicit links)', () => {
  it('renders javascript: links as plain text (not clickable)', () => {
    const spans = plainSpanTexts(parseMarkdownSpans('[x](javascript:alert(1))', false));
    expect(spans).toEqual([
      { text: 'x', url: null, styles: [] },
      { text: ')', url: null, styles: [] },
    ]);
  });

  it('allows https:// links', () => {
    const spans = plainSpanTexts(parseMarkdownSpans('[site](https://example.com)', false));
    expect(spans).toEqual([{ text: 'site', url: 'https://example.com', styles: [] }]);
  });

  it('normalizes www. links to https', () => {
    const spans = plainSpanTexts(parseMarkdownSpans('[site](www.example.com)', false));
    expect(spans).toEqual([{ text: 'site', url: 'https://www.example.com', styles: [] }]);
  });

  it('allows mailto: links', () => {
    const spans = plainSpanTexts(parseMarkdownSpans('[email](mailto:test@example.com)', false));
    expect(spans).toEqual([{ text: 'email', url: 'mailto:test@example.com', styles: [] }]);
  });
});
