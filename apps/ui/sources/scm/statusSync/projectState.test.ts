import { describe, expect, it, vi } from 'vitest';

import { getRepoScopeSessionIds } from './projectState';

const getStateMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/domains/state/storage', () => ({
  storage: {
    getState: getStateMock,
  },
}));

describe('getRepoScopeSessionIds', () => {
  it('groups repo sessions by host scope when machineId is missing', () => {
    getStateMock.mockReturnValue({
      sessions: {
        s1: { id: 's1', metadata: { host: 'devbox', path: '/repo' } },
        s2: { id: 's2', metadata: { host: 'devbox', path: '/repo/apps/ui' } },
        s3: { id: 's3', metadata: { host: 'other', path: '/repo/apps/ui' } },
        s4: { id: 's4', metadata: { machineId: 'machine-a', path: '/repo/apps/ui' } },
      },
    });

    const scoped = getRepoScopeSessionIds('s1', '/repo').sort();
    expect(scoped).toEqual(['s1', 's2']);
  });

  it('returns only the reference session when scope is unknown', () => {
    getStateMock.mockReturnValue({
      sessions: {
        s1: { id: 's1', metadata: { path: '/repo' } },
        s2: { id: 's2', metadata: { host: '', path: '/repo/apps/ui' } },
      },
    });

    expect(getRepoScopeSessionIds('s1', '/repo')).toEqual(['s1']);
  });
});

