import { describe, expect, it } from 'vitest';

import * as protocol from '../index.js';

type ZodLikeSchema<TValue = unknown> = {
  parse: (value: unknown) => TValue;
  safeParse: (value: unknown) => { success: boolean };
};

function readProtocolSchema<TValue = unknown>(name: string): ZodLikeSchema<TValue> {
  const value = (protocol as Record<string, unknown>)[name];
  expect(value).toMatchObject({
    parse: expect.any(Function),
    safeParse: expect.any(Function),
  });
  return value as ZodLikeSchema<TValue>;
}

describe('SCM freshness protocol', () => {
  it('exports the shared VCS freshness schema and refresh policy schema', () => {
    const freshnessSchema = readProtocolSchema<protocol.VcsFreshness>('VcsFreshnessSchema');
    const refreshPolicySchema = readProtocolSchema<protocol.ProviderRefreshPolicy>(
      'ProviderRefreshPolicySchema',
    );

    expect(freshnessSchema.parse({
      source: 'cached-remote',
      observedAt: 123,
      expiresAt: 456,
    })).toEqual({
      source: 'cached-remote',
      observedAt: 123,
      expiresAt: 456,
    });
    expect(refreshPolicySchema.parse('stale-while-revalidate')).toBe('stale-while-revalidate');
  });

  it('rejects unknown freshness sources and negative timestamps', () => {
    const schema = readProtocolSchema('VcsFreshnessSchema');

    expect(schema.safeParse({
      source: 'local-cache',
      observedAt: 123,
    }).success).toBe(false);
    expect(schema.safeParse({
      source: 'live-local',
      observedAt: -1,
    }).success).toBe(false);
    expect(schema.safeParse({
      source: 'cached-local',
      observedAt: 20,
      expiresAt: 10,
    }).success).toBe(false);
  });

  it('keeps refresh policies on the canonical four-value contract', () => {
    const schema = readProtocolSchema('ProviderRefreshPolicySchema');

    expect(schema.parse('cache-first')).toBe('cache-first');
    expect(schema.parse('stale-while-revalidate')).toBe('stale-while-revalidate');
    expect(schema.parse('force-refresh')).toBe('force-refresh');
    expect(schema.parse('local-only')).toBe('local-only');
    expect(schema.safeParse('remote-only').success).toBe(false);
  });

  it('validates freshness metadata on local SCM status responses without dropping the snapshot', () => {
    const responseSchema = readProtocolSchema<protocol.ScmStatusSnapshotResponse>(
      'ScmStatusSnapshotResponseSchema',
    );

    const parsed = responseSchema.parse({
      success: true,
      freshness: {
        source: 'cached-local',
        observedAt: 100,
        expiresAt: 200,
      },
      refreshPolicy: 'stale-while-revalidate',
      snapshot: {
        projectKey: 'machine-1:/repo',
        fetchedAt: 90,
        repo: {
          isRepo: true,
          rootPath: '/repo',
          backendId: 'git',
          mode: '.git',
        },
        capabilities: {
          readStatus: true,
          readDiffFile: true,
          readDiffCommit: true,
          readLog: true,
          writeInclude: true,
          writeExclude: true,
          writeCommit: true,
          writeCommitPathSelection: true,
          writeCommitLineSelection: true,
          writeBackout: true,
          writeRemoteFetch: true,
          writeRemotePull: true,
          writeRemotePush: true,
          worktreeCreate: true,
          changeSetModel: 'index',
          supportedDiffAreas: ['included', 'pending', 'both'],
        },
        branch: {
          head: 'feature/freshness',
          upstream: 'origin/main',
          ahead: 1,
          behind: 0,
          detached: false,
        },
        hasConflicts: false,
        entries: [],
        totals: {
          includedFiles: 0,
          pendingFiles: 0,
          untrackedFiles: 0,
          includedAdded: 0,
          includedRemoved: 0,
          pendingAdded: 0,
          pendingRemoved: 0,
        },
      },
    });

    expect(parsed.freshness).toEqual({
      source: 'cached-local',
      observedAt: 100,
      expiresAt: 200,
    });
    expect(parsed.refreshPolicy).toBe('stale-while-revalidate');
    expect(parsed.snapshot?.branch.head).toBe('feature/freshness');

    expect(responseSchema.safeParse({
      success: true,
      freshness: {
        source: 'cached-remote',
        observedAt: 100,
      },
      snapshot: parsed.snapshot,
    }).success).toBe(false);
  });
});
