import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  PI_THINKING_LEVEL_ENV,
  applyPiThinkingLevelEnv,
  normalizePiThinkingLevel,
  resolvePiThinkingLevelFromEnv,
} from './thinking.js';

describe('pi protocol thinking', () => {
  it('is published through a narrow plugin protocol subpath', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { exports?: Record<string, unknown> };

    expect(packageJson.exports).toHaveProperty('./protocol/thinking', {
      types: './dist/protocol/thinking.d.ts',
      default: './dist/protocol/thinking.js',
    });
  });

  it('normalizes thinking level environment values', () => {
    expect(normalizePiThinkingLevel(' HIGH ')).toBe('high');
    expect(normalizePiThinkingLevel('definitely-not-valid')).toBeNull();
    expect(applyPiThinkingLevelEnv({ EXISTING: '1' }, 'minimal')).toEqual({
      EXISTING: '1',
      [PI_THINKING_LEVEL_ENV]: 'minimal',
    });
    expect(resolvePiThinkingLevelFromEnv({ [PI_THINKING_LEVEL_ENV]: ' xhigh ' })).toBe('xhigh');
  });
});
