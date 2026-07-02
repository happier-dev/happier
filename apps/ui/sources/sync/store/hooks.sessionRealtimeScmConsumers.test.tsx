import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';
import type { ScmWorkingSnapshot, Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import { readMountedSessionRealtimeScmConsumerScopes } from '@/sync/runtime/sessionRealtimeScmConsumers';
import { sync } from '@/sync/sync';

const initialStorageState = storage.getState();

type ExplicitScmConsumerHook = (sessionId: string | null, snapshot: ScmWorkingSnapshot | null) => void;

function buildSession(sessionId: string): Session {
  return {
    id: sessionId,
    seq: 1,
    createdAt: 1_000,
    updatedAt: 1_000,
    active: true,
    activeAt: 1_000,
    metadata: { path: '/repo/app', machineId: 'machine-a', host: 'test-host' },
    metadataVersion: 1,
    agentState: null,
    agentStateVersion: 0,
    thinking: false,
    thinkingAt: 0,
    presence: 'online',
    optimisticThinkingAt: null,
    encryptionMode: 'plain',
  };
}

function buildSnapshot(): ScmWorkingSnapshot {
  return {
    projectKey: 'machine-a:/repo',
    fetchedAt: 1_500,
    repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
    capabilities: {
      readStatus: true,
      readDiffFile: true,
      readDiffCommit: true,
      readLog: true,
      writeInclude: true,
      writeExclude: true,
      writeCommit: true,
      writeBackout: true,
      writeRemoteFetch: true,
      writeRemotePull: true,
      writeRemotePush: true,
      worktreeCreate: true,
    },
    branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
    stashCount: 0,
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
  };
}

describe('session realtime SCM consumer hooks', () => {
  afterEach(() => {
    storage.setState(initialStorageState, true);
    standardCleanup();
  });

  it('exposes an explicit realtime SCM transcript consumer hook', async () => {
    const hooks = await import('./hooks') as typeof import('./hooks') & {
      useSessionRealtimeScmTranscriptConsumer?: unknown;
    };

    expect(typeof hooks.useSessionRealtimeScmTranscriptConsumer).toBe('function');
  });

  it('registers a same-session fallback scope before the SCM snapshot hydrates', async () => {
    const sessionId = 'session-explicit-scm-consumer';
    storage.getState().applySessions([buildSession(sessionId)]);
    const hooks = await import('./hooks') as typeof import('./hooks') & {
      useSessionRealtimeScmTranscriptConsumer?: ExplicitScmConsumerHook;
    };
    const useSessionRealtimeScmTranscriptConsumer = hooks.useSessionRealtimeScmTranscriptConsumer;
    expect(typeof useSessionRealtimeScmTranscriptConsumer).toBe('function');
    if (typeof useSessionRealtimeScmTranscriptConsumer !== 'function') return;

    const hook = await renderHook(() => {
      const snapshot = hooks.useSessionProjectScmSnapshot(sessionId);
      useSessionRealtimeScmTranscriptConsumer(sessionId, snapshot);
      return snapshot;
    });

    try {
      expect(hook.getCurrent()).toBeNull();
      expect(readMountedSessionRealtimeScmConsumerScopes()).toEqual([
        {
          sessionId,
          needsMutationTranscript: true,
        },
      ]);
    } finally {
      await hook.unmount();
    }
  });

  it('re-registers a still-mounted fallback scope after a server-scoped runtime reset', async () => {
    const sessionId = 'session-reset-fallback-scm-consumer';
    storage.getState().applySessions([buildSession(sessionId)]);
    const hooks = await import('./hooks') as typeof import('./hooks') & {
      useSessionRealtimeScmTranscriptConsumer?: ExplicitScmConsumerHook;
    };
    const useSessionRealtimeScmTranscriptConsumer = hooks.useSessionRealtimeScmTranscriptConsumer;
    expect(typeof useSessionRealtimeScmTranscriptConsumer).toBe('function');
    if (typeof useSessionRealtimeScmTranscriptConsumer !== 'function') return;

    const hook = await renderHook(() => {
      const snapshot = hooks.useSessionProjectScmSnapshot(sessionId);
      useSessionRealtimeScmTranscriptConsumer(sessionId, snapshot);
      return snapshot;
    });

    try {
      expect(readMountedSessionRealtimeScmConsumerScopes()).toEqual([
        {
          sessionId,
          needsMutationTranscript: true,
        },
      ]);

      await act(async () => {
        (sync as any).resetServerScopedRuntimeState();
      });

      expect(hook.getCurrent()).toBeNull();
      expect(readMountedSessionRealtimeScmConsumerScopes()).toEqual([
        {
          sessionId,
          needsMutationTranscript: true,
        },
      ]);
    } finally {
      await hook.unmount();
    }
  });
});
