import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { resolveReviewNarratorPolicy } from './reviewEngines.js';

describe('reviewEngines', () => {
  it('selects the first enabled capable selected engine and requires a separate narrator only for fanout or missing capability', () => {
    const engines = [
      { value: 'third-party-findings', capabilities: { structuredNarration: false } },
      { value: 'third-party-narrator', capabilities: { structuredNarration: true } },
      { value: 'another-narrator', capabilities: { structuredNarration: true } },
      { value: 'disabled-narrator', enabled: false, capabilities: { structuredNarration: true } },
    ];
    expect(resolveReviewNarratorPolicy({ selectedEngineIds: ['third-party-narrator'], engines })).toEqual({
      requiresSeparateNarrator: false, defaultNarratorEngineId: 'third-party-narrator',
    });
    expect(resolveReviewNarratorPolicy({ selectedEngineIds: ['another-narrator', 'third-party-narrator'], engines })).toEqual({
      requiresSeparateNarrator: true, defaultNarratorEngineId: 'another-narrator',
    });
    expect(resolveReviewNarratorPolicy({ selectedEngineIds: ['third-party-findings'], engines })).toEqual({
      requiresSeparateNarrator: true, defaultNarratorEngineId: null,
    });
    expect(resolveReviewNarratorPolicy({ selectedEngineIds: ['missing', 'disabled-narrator'], engines })).toEqual({
      requiresSeparateNarrator: true, defaultNarratorEngineId: null,
    });
    expect(resolveReviewNarratorPolicy({ selectedEngineIds: ['undeclared'], engines: [{ value: 'undeclared' }] })).toEqual({
      requiresSeparateNarrator: true, defaultNarratorEngineId: null,
    });
  });

  it('does not expose a host-native review engine fallback API', () => {
    const source = readFileSync(new URL('./reviewEngines.ts', import.meta.url), 'utf8');

    expect(source).not.toContain(['Native', 'ReviewEngine'].join(''));
    expect(source).not.toContain(['list', 'Native', 'ReviewEngines'].join(''));
    expect(source).not.toContain(['get', 'Native', 'ReviewEngine'].join(''));
  });
});
