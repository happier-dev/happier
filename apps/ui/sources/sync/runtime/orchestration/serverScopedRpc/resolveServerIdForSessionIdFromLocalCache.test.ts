import { describe, expect, it } from 'vitest';

import {
  resolveServerIdForSessionIdFromLocalState,
  resolveServerIdForSessionIdFromSessionListCache,
} from './resolveServerIdForSessionIdFromLocalCache';

describe('resolveServerIdForSessionIdFromSessionListCache', () => {
  it('returns the matching serverId when the session appears in the cached list', () => {
    const cache: any = {
      'server-a': [
        { type: 'header', title: 'x' },
        { type: 'session', session: { id: 's1' } },
      ],
      'server-b': [{ type: 'session', session: { id: 's2' } }],
    };

    expect(resolveServerIdForSessionIdFromSessionListCache(cache, 's1')).toBe('server-a');
    expect(resolveServerIdForSessionIdFromSessionListCache(cache, 's2')).toBe('server-b');
  });

  it('returns null when the cache is empty or the session id is not found', () => {
    expect(resolveServerIdForSessionIdFromSessionListCache({}, 's1')).toBeNull();
    expect(resolveServerIdForSessionIdFromSessionListCache({ 'server-a': null } as any, 's1')).toBeNull();
  });
});

describe('resolveServerIdForSessionIdFromLocalState', () => {
  it('prefers the session map serverId when available', () => {
    const state: any = {
      sessions: {
        s1: { id: 's1', serverId: 'server-a' },
      },
      sessionListViewDataByServerId: {
        'server-b': [{ type: 'session', session: { id: 's1' } }],
      },
    };

    expect(resolveServerIdForSessionIdFromLocalState(state, 's1')).toBe('server-a');
  });

  it('falls back to the session list cache when the session map is missing', () => {
    const state: any = {
      sessions: {},
      sessionListViewDataByServerId: {
        'server-b': [{ type: 'session', session: { id: 's2' } }],
      },
    };

    expect(resolveServerIdForSessionIdFromLocalState(state, 's2')).toBe('server-b');
  });
});
