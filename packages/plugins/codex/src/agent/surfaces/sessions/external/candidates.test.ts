import { describe, expect, it } from 'vitest';

import {
  decodeCodexExternalSessionIndexCursor,
  encodeCodexExternalSessionIndexCursor,
  resolveCodexExternalSessionAppServerListBudgetMs,
} from './candidates.js';

describe('Codex external-session candidate helpers', () => {
  it('round-trips candidate index cursors and clamps invalid offsets', () => {
    const cursor = encodeCodexExternalSessionIndexCursor(42.8);

    expect(decodeCodexExternalSessionIndexCursor(cursor)).toBe(42);
    expect(decodeCodexExternalSessionIndexCursor('')).toBe(0);
    expect(decodeCodexExternalSessionIndexCursor('not-base64-json')).toBe(0);
    expect(
      decodeCodexExternalSessionIndexCursor(
        Buffer.from(JSON.stringify({ v: 1, kind: 'index', offset: -7 }), 'utf8').toString('base64url'),
      ),
    ).toBe(0);
  });

  it('resolves app-server listing budget from Codex external-session env', () => {
    expect(resolveCodexExternalSessionAppServerListBudgetMs({})).toBe(3_000);
    expect(resolveCodexExternalSessionAppServerListBudgetMs({
      HAPPIER_CODEX_EXTERNAL_SESSIONS_APP_SERVER_LIST_TIMEOUT_MS: '1250',
    })).toBe(1250);
    expect(resolveCodexExternalSessionAppServerListBudgetMs({
      HAPPIER_CODEX_EXTERNAL_SESSIONS_APP_SERVER_LIST_TIMEOUT_MS: '-1',
    })).toBe(3_000);
  });
});
