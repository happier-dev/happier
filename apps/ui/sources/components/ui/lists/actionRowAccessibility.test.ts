import { describe, expect, it } from 'vitest';

import { buildActionRowAccessibilityLabel } from './actionRowAccessibility';

describe('buildActionRowAccessibilityLabel', () => {
  it('reads a row as one sentence per part', () => {
    expect(
      buildActionRowAccessibilityLabel(['Overview', '1 needs a look']),
    ).toBe('Overview. 1 needs a look');
  });

  // A description is often a whole sentence already: the joint must not read it twice ("machine.. Checking…").
  it('does not add a second stop after a part that already ends a sentence', () => {
    expect(
      buildActionRowAccessibilityLabel([
        'Lima',
        'A lightweight Linux machine.',
        'Checking…',
      ]),
    ).toBe('Lima. A lightweight Linux machine. Checking…');
    expect(
      buildActionRowAccessibilityLabel(['Ready?', 'Waiting…', 'Not installed']),
    ).toBe('Ready? Waiting… Not installed');
  });

  it('skips empty and non-text parts', () => {
    expect(
      buildActionRowAccessibilityLabel([' ', null, 'Docker', undefined]),
    ).toBe('Docker');
    expect(buildActionRowAccessibilityLabel([])).toBeUndefined();
  });
});
