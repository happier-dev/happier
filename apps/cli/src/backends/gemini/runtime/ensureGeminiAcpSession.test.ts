import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentBackend } from '@/agent';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/ProviderEnforcedPermissionHandler';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { ensureGeminiAcpSession, importGeminiAcpSessionReplay } from './ensureGeminiAcpSession';

const importAcpReplayHistoryV1Mock = vi.hoisted(() => vi.fn());

vi.mock('@/agent/acp/history/importAcpReplayHistory', () => ({
  importAcpReplayHistoryV1: (...args: unknown[]) => importAcpReplayHistoryV1Mock(...args),
}));

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type ReplayImportParams = Readonly<{
  session: Pick<ApiSessionClient, 'fetchRecentTranscriptTextItemsForAcpImport'>;
}>;

function createBackendFixture<T extends Partial<AgentBackend>>(backend: T): AgentBackend & T {
  return backend as AgentBackend & T;
}

function createSessionFixture<T extends Partial<ApiSessionClient>>(session: T = {} as T): ApiSessionClient & T {
  return session as ApiSessionClient & T;
}

function createPermissionHandlerFixture(): ProviderEnforcedPermissionHandler {
  return {} as ProviderEnforcedPermissionHandler;
}

class ReplayCaptureBackendFixture implements Partial<AgentBackend> {
  readonly replayCalls: string[] = [];
  readonly startSession = vi.fn<AgentBackend['startSession']>();

  async loadSessionWithReplayCapture(sessionId: string) {
    this.replayCalls.push(sessionId);
    return { sessionId, replay: [{ type: 'message' }] };
  }
}

describe('ensureGeminiAcpSession', () => {
  afterEach(() => {
    importAcpReplayHistoryV1Mock.mockReset();
  });

  it('starts a new session when no resume id is provided', async () => {
    const backend = createBackendFixture({
      startSession: vi.fn().mockResolvedValue({ sessionId: 'new-session' }),
    });

    const result = await ensureGeminiAcpSession({
      backend,
      session: createSessionFixture(),
      permissionHandler: createPermissionHandlerFixture(),
      messageBuffer: new MessageBuffer(),
      storedResumeId: null,
      onDebug: vi.fn(),
    });

    expect(result).toEqual({ acpSessionId: 'new-session', storedResumeId: null, startedFreshSession: true });
    expect(backend.startSession).toHaveBeenCalledTimes(1);
  });

  it('loads an existing session and consumes stored resume id', async () => {
    const backend = createBackendFixture({
      loadSession: vi.fn().mockResolvedValue({ sessionId: 'resume-123' }),
      startSession: vi.fn(),
    });

    const result = await ensureGeminiAcpSession({
      backend,
      session: createSessionFixture(),
      permissionHandler: createPermissionHandlerFixture(),
      messageBuffer: new MessageBuffer(),
      storedResumeId: 'resume-123',
      onDebug: vi.fn(),
    });

    expect(backend.loadSession).toHaveBeenCalledWith('resume-123');
    expect(backend.startSession).not.toHaveBeenCalled();
    expect(result).toEqual({ acpSessionId: 'resume-123', storedResumeId: null, startedFreshSession: false });
  });

  it('loads an existing session with replay capture using the backend binding and imports replay history', async () => {
    importAcpReplayHistoryV1Mock.mockClear();
    const backend = createBackendFixture(new ReplayCaptureBackendFixture());
    const session = createSessionFixture();
    const permissionHandler = createPermissionHandlerFixture();

    const result = await ensureGeminiAcpSession({
      backend,
      session,
      permissionHandler,
      messageBuffer: new MessageBuffer(),
      storedResumeId: 'resume-456',
      onDebug: vi.fn(),
    });

    expect(backend.replayCalls).toEqual(['resume-456']);
    expect(backend.startSession).not.toHaveBeenCalled();
    expect(importAcpReplayHistoryV1Mock).toHaveBeenCalledWith({
      session,
      provider: 'gemini',
      remoteSessionId: 'resume-456',
      replay: [{ type: 'message' }],
      permissionHandler,
    });
    expect(result).toEqual({ acpSessionId: 'resume-456', storedResumeId: null, startedFreshSession: false });
  });

  it('rejects a mismatched loaded identity before importing replay history', async () => {
    const backend = createBackendFixture({
      loadSessionWithReplayCapture: vi.fn().mockResolvedValue({
        sessionId: 'replacement-session',
        replay: [{ type: 'message', role: 'agent', text: 'must not import' }],
      }),
      startSession: vi.fn(),
    });

    await expect(ensureGeminiAcpSession({
      backend,
      session: createSessionFixture(),
      permissionHandler: createPermissionHandlerFixture(),
      messageBuffer: new MessageBuffer(),
      storedResumeId: 'expected-session',
      onDebug: vi.fn(),
    })).rejects.toMatchObject({ code: 'ACP_SESSION_IDENTITY_RESUME_MISMATCH' });

    expect(importAcpReplayHistoryV1Mock).not.toHaveBeenCalled();
  });

  it('can defer replay import until the caller has durably published the validated identity', async () => {
    const session = createSessionFixture();
    const permissionHandler = createPermissionHandlerFixture();
    const result = await ensureGeminiAcpSession({
      backend: createBackendFixture({
        loadSessionWithReplayCapture: vi.fn().mockResolvedValue({
          sessionId: 'resume-deferred',
          replay: [{ type: 'message', role: 'agent', text: 'deferred history' }],
        }),
        startSession: vi.fn(),
      }),
      session,
      permissionHandler,
      messageBuffer: new MessageBuffer(),
      storedResumeId: 'resume-deferred',
      deferReplayImport: true,
      onDebug: vi.fn(),
    });

    expect(importAcpReplayHistoryV1Mock).not.toHaveBeenCalled();
    expect(result.deferredReplay).toEqual([{ type: 'message', role: 'agent', text: 'deferred history' }]);

    await importGeminiAcpSessionReplay({
      session,
      permissionHandler,
      remoteSessionId: result.acpSessionId,
      replay: result.deferredReplay ?? [],
    });
    expect(importAcpReplayHistoryV1Mock).toHaveBeenCalledTimes(1);
  });

  it('waits for replay history import before returning a loaded resumed session', async () => {
    const importDeferred = createDeferred<void>();
    importAcpReplayHistoryV1Mock.mockReturnValueOnce(importDeferred.promise);
    const backend = createBackendFixture({
      async loadSessionWithReplayCapture(sessionId: string) {
        return { sessionId, replay: [{ type: 'message', role: 'user', text: 'remote hello' }] };
      },
      startSession: vi.fn(),
    });

    const resumed = ensureGeminiAcpSession({
      backend,
      session: createSessionFixture(),
      permissionHandler: createPermissionHandlerFixture(),
      messageBuffer: new MessageBuffer(),
      storedResumeId: 'resume-789',
      onDebug: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(importAcpReplayHistoryV1Mock).toHaveBeenCalledTimes(1);
    });

    let resolved = false;
    void resumed.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    importDeferred.resolve();
    await expect(resumed).resolves.toEqual({
      acpSessionId: 'resume-789',
      storedResumeId: null,
      startedFreshSession: false,
    });
  });

  it('excludes the current materialized prompt from replay import overlap detection', async () => {
    let importedExistingTranscript: Array<{ role: 'user' | 'agent'; text: string }> | null = null;
    importAcpReplayHistoryV1Mock.mockImplementationOnce(async (params: ReplayImportParams) => {
      importedExistingTranscript = await params.session.fetchRecentTranscriptTextItemsForAcpImport({ take: 150 });
    });
    const backend = {
      async loadSessionWithReplayCapture(sessionId: string) {
        return { sessionId, replay: [{ type: 'message', role: 'agent', text: 'remote history' }] };
      },
      startSession: vi.fn(),
    };
    const session = {
      fetchRecentTranscriptTextItemsForAcpImport: vi.fn(async () => [
        { role: 'user' as const, text: 'GEMINI_ACP_CANCELLED_T5' },
      ]),
      sendUserTextMessageCommitted: vi.fn(async () => undefined),
      sendAgentMessageCommitted: vi.fn(async () => undefined),
      updateMetadata: vi.fn(),
    };

    await ensureGeminiAcpSession({
      backend: createBackendFixture(backend),
      session: createSessionFixture(session),
      permissionHandler: createPermissionHandlerFixture(),
      messageBuffer: new MessageBuffer(),
      storedResumeId: 'resume-999',
      currentPromptText: 'GEMINI_ACP_CANCELLED_T5',
      onDebug: vi.fn(),
    });

    expect(session.fetchRecentTranscriptTextItemsForAcpImport).toHaveBeenCalledWith({ take: 150 });
    expect(importedExistingTranscript).toEqual([]);
  });
});
