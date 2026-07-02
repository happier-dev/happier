import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiUpdateContainer } from '@/sync/api/types/apiTypes';
import type { Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import { handleUpdateContainer } from './socket';

const invalidateScmSpy = vi.hoisted(() => vi.fn());
const invalidateScmMutationSpy = vi.hoisted(() => vi.fn());
const handleNewMessageSocketUpdateSpy = vi.hoisted(() => vi.fn());

vi.mock('@/scm/scmStatusSync', () => ({
  scmStatusSync: {
    invalidate: (...args: any[]) => invalidateScmSpy(...args),
    invalidateFromMutation: (...args: any[]) => invalidateScmMutationSpy(...args),
  },
}));

vi.mock('@/sync/engine/sessions/syncSessions', () => ({
  buildUpdatedSessionFromSocketUpdate: vi.fn(async ({ session }: { session: Session }) => ({
    nextSession: session,
    agentState: session.agentState,
  })),
  handleDeleteSessionSocketUpdate: vi.fn(),
  handleNewMessageSocketUpdate: (...args: any[]) => handleNewMessageSocketUpdateSpy(...args),
}));

const initialStorageState = storage.getState();

function buildSession(sessionId: string): Session {
  return {
    id: sessionId,
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
    active: true,
    activeAt: 1,
    metadata: null,
    metadataVersion: 0,
    agentState: { controlledByUser: false, requests: {}, completedRequests: {} } as any,
    agentStateVersion: 0,
    thinking: false,
    thinkingAt: 0,
    presence: 'online',
  };
}

describe('socket scm invalidation', () => {
  beforeEach(() => {
    storage.setState(initialStorageState, true);
    invalidateScmSpy.mockClear();
    invalidateScmMutationSpy.mockClear();
    handleNewMessageSocketUpdateSpy.mockReset();
  });

  it('does not invalidate scm status on agentState socket updates', async () => {
    const sessionId = 's1';
    storage.getState().applySessions([buildSession(sessionId)]);

    const updateData: ApiUpdateContainer = {
      id: 'u1',
      seq: 2,
      createdAt: 10,
      body: {
        t: 'update-session',
        id: sessionId,
        agentState: { controlledByUser: false, requests: {}, completedRequests: {} },
      },
    } as any;

    await handleUpdateContainer({
      updateData,
      encryption: {
        getSessionEncryption: () => ({ encryptRaw: async (v: any) => v, decryptRaw: async (v: any) => v }),
        getMachineEncryption: () => null,
        removeSessionEncryption: () => {},
      } as any,
      artifactDataKeys: new Map<string, Uint8Array>(),
      applySessions: vi.fn(),
      fetchSessions: vi.fn(),
      applyMessages: vi.fn(),
      onSessionVisible: vi.fn(),
      isSessionMessagesLoaded: vi.fn(() => false),
      getSessionMaterializedMaxSeq: vi.fn(() => 0),
      markSessionMaterializedMaxSeq: vi.fn(),
      onMessageGapDetected: vi.fn(),
      assumeUsers: vi.fn(async () => {}),
      applyTodoSocketUpdates: vi.fn(async () => {}),
      invalidateMachines: vi.fn(),
      invalidateSessions: vi.fn(),
      invalidateArtifacts: vi.fn(),
      invalidateFriends: vi.fn(),
      invalidateFriendRequests: vi.fn(),
      invalidateFeed: vi.fn(),
      invalidateAutomations: vi.fn(),
      invalidateTodos: vi.fn(),
      log: { log: vi.fn() },
    });

    expect(invalidateScmSpy).not.toHaveBeenCalled();
  });

  it('routes mutable-tool socket scm invalidations through the mutation path', async () => {
    const sessionId = 's1';
    storage.getState().applySessions([buildSession(sessionId)]);
    handleNewMessageSocketUpdateSpy.mockImplementationOnce(async (params: { invalidateScmStatus: (sessionId: string) => void }) => {
      params.invalidateScmStatus(sessionId);
    });

    const updateData: ApiUpdateContainer = {
      id: 'u1',
      seq: 2,
      createdAt: 10,
      body: {
        t: 'new-message',
        sid: sessionId,
        message: {
          id: 'm1',
          seq: 2,
          content: { t: 'plain', v: { role: 'agent', content: [{ type: 'tool-result', tool_use_id: 'tool-1' }] } },
          localId: null,
          createdAt: 10,
          updatedAt: 10,
        },
      },
    } as any;

    await handleUpdateContainer({
      updateData,
      encryption: {
        getSessionEncryption: () => ({ encryptRaw: async (v: any) => v, decryptRaw: async (v: any) => v }),
        getMachineEncryption: () => null,
        removeSessionEncryption: () => {},
      } as any,
      artifactDataKeys: new Map<string, Uint8Array>(),
      applySessions: vi.fn(),
      fetchSessions: vi.fn(),
      applyMessages: vi.fn(),
      onSessionVisible: vi.fn(),
      isSessionMessagesLoaded: vi.fn(() => true),
      getSessionMaterializedMaxSeq: vi.fn(() => 1),
      markSessionMaterializedMaxSeq: vi.fn(),
      onMessageGapDetected: vi.fn(),
      assumeUsers: vi.fn(async () => {}),
      applyTodoSocketUpdates: vi.fn(async () => {}),
      invalidateMachines: vi.fn(),
      invalidateSessions: vi.fn(),
      invalidateArtifacts: vi.fn(),
      invalidateFriends: vi.fn(),
      invalidateFriendRequests: vi.fn(),
      invalidateFeed: vi.fn(),
      invalidateAutomations: vi.fn(),
      invalidateTodos: vi.fn(),
      log: { log: vi.fn() },
    });

    expect(invalidateScmMutationSpy).toHaveBeenCalledWith(sessionId);
    expect(invalidateScmSpy).not.toHaveBeenCalled();
  });
});
