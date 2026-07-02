import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  doesPiSessionFileNameMatchSessionId,
  encodePiSessionDirectoryCwd,
  formatPiSessionDirectoryForCwd,
  resolvePiSessionIdFromResumeReference,
} from './sessionFiles.js';

describe('pi session-file layout', () => {
  it('is published through a narrow plugin agent subpath', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { exports?: Record<string, unknown> };

    expect(packageJson.exports).toHaveProperty('./agent/sessionFiles', {
      types: './dist/agent/sessionFiles.d.ts',
      default: './dist/agent/sessionFiles.js',
    });
  });

  it('matches the vendor cwd encoding used by pi-coding-agent session directories', () => {
    expect(encodePiSessionDirectoryCwd('/Users/leeroy/Documents/Development/happier/dev')).toBe(
      'Users-leeroy-Documents-Development-happier-dev',
    );
    expect(formatPiSessionDirectoryForCwd('/Users/leeroy/Documents/Development/happier/dev')).toBe(
      '--Users-leeroy-Documents-Development-happier-dev--',
    );
    expect(encodePiSessionDirectoryCwd('/Users/a b/proj')).toBe('Users-a b-proj');
    expect(encodePiSessionDirectoryCwd('/srv/a--b/proj')).toBe('srv-a--b-proj');
    expect(encodePiSessionDirectoryCwd('/Users/José/proj')).toBe('Users-José-proj');
    expect(encodePiSessionDirectoryCwd('/Users/x/../y/proj')).toBe('Users-y-proj');
  });

  it('matches provider session file names and resolves resume references', () => {
    const id = '019e461b-24e2-73a9-acf4-19bc50210729';

    expect(doesPiSessionFileNameMatchSessionId(`2026-05-20T15-57-24-578Z_${id}.jsonl`, id)).toBe(true);
    expect(doesPiSessionFileNameMatchSessionId(`${id}.jsonl`, id)).toBe(true);
    expect(doesPiSessionFileNameMatchSessionId(`session-${id}.jsonl`, id)).toBe(true);
    expect(doesPiSessionFileNameMatchSessionId(`2026-05-20T15-57-24-578Z_other.jsonl`, id)).toBe(false);
    expect(doesPiSessionFileNameMatchSessionId(`${id}.txt`, id)).toBe(false);

    expect(resolvePiSessionIdFromResumeReference(id)).toBe(id);
    expect(resolvePiSessionIdFromResumeReference(`/p/--cwd--/2026-05-20T15-57-24-578Z_${id}.jsonl`)).toBe(id);
    expect(resolvePiSessionIdFromResumeReference('')).toBeNull();
  });
});
