import { describe, expect, it } from 'vitest';

import { resolveHappierCodeBlockLayout } from './CodeBlock.js';

describe('shared code-block presentation', () => {
  it('normalizes the language and chooses one header/overlay placement', () => {
    expect(resolveHappierCodeBlockLayout({
      language: ' TypeScript ',
      showHeaderRow: true,
      showCopyButton: true,
      hasHeaderLeft: false,
      hasHeaderRight: false,
    })).toEqual({
      language: 'typescript',
      shouldRenderHeaderRow: true,
      shouldOverlayCopyButton: false,
    });

    expect(resolveHappierCodeBlockLayout({
      language: null,
      showHeaderRow: true,
      showCopyButton: true,
      hasHeaderLeft: false,
      hasHeaderRight: false,
    }).shouldOverlayCopyButton).toBe(true);
  });
});
