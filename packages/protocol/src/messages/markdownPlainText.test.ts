import { describe, expect, it } from 'vitest';

import { firstMarkdownProse, stripMarkdown } from './markdownPlainText.js';

describe('stripMarkdown', () => {
  // Golden outputs from ce7442f571's apps/ui/sources/utils/sessions/messageUtils.ts#stripMarkdown.
  it('preserves literal role prefixes in preview text', () => {
    expect(stripMarkdown('User: # Question\n- **Check** `scope`\nAssistant: ## Answer\n[Keep access](https://example.test)'))
      .toBe('User: # Question Check scope Assistant: ## Answer Keep access');
  });

  it('removes ordered-list markers and retains table values in previews', () => {
    expect(stripMarkdown('1. First\n\n| Name | State |\n| --- | :---: |\n| Grant | Ready |'))
      .toBe('First Name State Grant Ready');
  });

  it('formats conversation search text without erasing numbered matches or literal code', () => {
    const text = 'User: # Question\n554. **Keep** issue #42 and C# literal\nAssistant: ## Answer\n`User: # literal` and `554. literal`';
    expect(stripMarkdown(text, { omitRolePrefixes: true, preserveOrderedListNumbers: true }))
      .toBe('Question 554. Keep issue #42 and C# literal Answer User: # literal and 554. literal');
  });

  it('preserves literal inline code while flattening a real table', () => {
    const markdown = [
      'Changing `&&` to `||` keeps `left|right` and `__scope__` literal.',
      '',
      '| Expression | Meaning |',
      '| --- | :---: |',
      '| `a|b` | **Either** |',
    ].join('\n');

    expect(stripMarkdown(markdown)).toBe(
      'Changing && to || keeps left|right and __scope__ literal. Expression Meaning a|b Either',
    );
    expect(firstMarkdownProse(`## Authorization implications\n\n${markdown}`)).toBe(
      'Changing && to || keeps left|right and __scope__ literal.',
    );
  });

  it('keeps Markdown-looking code literal within surrounding emphasis and links', () => {
    expect(stripMarkdown('**Use `*literal*`** and [read `a|b`](https://example.test), then ``a`b|c`` and `[x](y)`.'))
      .toBe('Use *literal* and read a|b, then a`b|c and [x](y).');
  });

  it('keeps underscores inside words, as CommonMark does, while removing underscore emphasis', () => {
    expect(stripMarkdown('Reply exactly PROBE_OK_2 from snake_case_name; _this_ and __that__ are emphasis.'))
      .toBe('Reply exactly PROBE_OK_2 from snake_case_name; this and that are emphasis.');
  });

  it('does not confuse answer text with protected code or consume unmatched delimiters', () => {
    expect(stripMarkdown('\u00000\u0000 `a|b` and ``unclosed`'))
      .toBe('\u00000\u0000 a|b and ``unclosed`');
    expect(stripMarkdown('\u0000`a\u0000|b`\u0000'))
      .toBe('\u0000a\u0000|b\u0000');
  });

  it.each([
    ['', '\u0000\u00000\u0000\u0000'],
    [' `literal`', '\u0000\u00000\u0000\u0000 literal'],
  ])('preserves literal text when formatting joins control characters%s', (suffix, expected) => {
    const prefix = '\u0000**\u0000**0\u0000**\u0000**';
    expect(stripMarkdown(prefix + suffix)).toBe(expected);
  });
});
