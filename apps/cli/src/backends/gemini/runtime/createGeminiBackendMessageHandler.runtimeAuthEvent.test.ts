import { buildUsageLimitIssueFingerprint, type SessionRuntimeIssueV1 } from '@happier-dev/protocol';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetConnectedServiceRuntimeAuthFailureReportDedupeForTests } from '@/daemon/connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon';
import { GEMINI_PROVIDER_RUNTIME_ERROR_EVENT } from '../acp/transport';
import { createGeminiBackendMessageHandler } from './createGeminiBackendMessageHandler';

const notifyDaemonConnectedServiceRuntimeAuthFailureMock = vi.hoisted(() => vi.fn());

vi.mock('@/daemon/controlClient', () => ({
  notifyDaemonConnectedServiceRuntimeAuthFailure: notifyDaemonConnectedServiceRuntimeAuthFailureMock,
}));

function stubConnectedGeminiSelection(): void {
  vi.stubEnv('HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON', JSON.stringify([{
    kind: 'group',
    serviceId: 'gemini',
    groupId: 'gemini-main',
    activeProfileId: 'leeroy',
    fallbackProfileId: 'backup',
    generation: 2,
    credentialRevision: 'csr_abcdefghijklmnopqrstuv',
  }]));
}

function createHarness() {
  const session = {
    sessionId: 'session-1',
    sendAgentMessage: vi.fn(),
    sendSessionEvent: vi.fn(),
    updateMetadata: vi.fn(),
    keepAlive: vi.fn(),
  } as any;
  const messageBuffer = { addMessage: vi.fn(), updateLastMessage: vi.fn() } as any;
  const state = {
    thinking: false,
    accumulatedResponse: '',
    isResponseInProgress: false,
    hadToolCallInTurn: false,
    hadThinkingInTurn: false,
    hadPermissionInTurn: false,
    taskStartedSent: false,
    changeTitleCompleted: false,
  } as any;
  const diffProcessor = {
    processToolResult: vi.fn(),
    processFsEdit: vi.fn(),
  } as any;

  return {
    session,
    state,
    messageBuffer,
    handler: createGeminiBackendMessageHandler({
      session,
      messageBuffer,
      state,
      diffProcessor,
    }),
  };
}

describe('createGeminiBackendMessageHandler (provider runtime error events)', () => {
  beforeEach(() => {
    resetConnectedServiceRuntimeAuthFailureReportDedupeForTests();
    notifyDaemonConnectedServiceRuntimeAuthFailureMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('never renders raw provider runtime error payloads to the transcript or terminal', () => {
    // No gemini connected-service selection -> classification is null and nothing is reported;
    // either way the RAW payload must stay suppressed (Gemini CLI retries 429s internally).
    vi.stubEnv('HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON', '');

    const { handler, messageBuffer, session } = createHarness();

    handler({
      type: 'event',
      name: GEMINI_PROVIDER_RUNTIME_ERROR_EVENT,
      payload: {
        source: 'gemini_stderr',
        status: 429,
        message: 'RAW_PROVIDER_ERROR_RESOURCE_EXHAUSTED',
      },
    } as any);

    expect(session.sendAgentMessage).not.toHaveBeenCalled();
    expect(session.sendSessionEvent).not.toHaveBeenCalled();
    expect(messageBuffer.addMessage).not.toHaveBeenCalled();
    expect(messageBuffer.updateLastMessage).not.toHaveBeenCalled();
  });

  it('surfaces a superseded exact source tuple truthfully without the raw provider event payload', async () => {
    stubConnectedGeminiSelection();
    notifyDaemonConnectedServiceRuntimeAuthFailureMock.mockResolvedValue({
      ok: true,
      result: {
        status: 'recovery_superseded',
        reason: 'source_tuple_mismatch',
        serviceId: 'gemini',
        groupId: 'gemini-main',
        profileId: 'leeroy',
      },
    });
    const { handler, messageBuffer, session } = createHarness();

    handler({
      type: 'event',
      name: GEMINI_PROVIDER_RUNTIME_ERROR_EVENT,
      payload: {
        source: 'gemini_stderr',
        status: 429,
        message: 'RAW_PROVIDER_ERROR_RESOURCE_EXHAUSTED',
      },
    } as any);

    await expect.poll(() => session.sendSessionEvent.mock.calls).toEqual([[
      {
        type: 'message',
        message: 'Connected-service account already updated; the old turn was interrupted.',
      },
    ]]);
    expect(session.sendAgentMessage).not.toHaveBeenCalled();
    expect(messageBuffer.addMessage).not.toHaveBeenCalled();
    expect(messageBuffer.updateLastMessage).not.toHaveBeenCalled();
  });

  it('suppresses status-error raw fallback when the daemon handled a superseded exact source tuple', async () => {
    stubConnectedGeminiSelection();
    notifyDaemonConnectedServiceRuntimeAuthFailureMock.mockResolvedValue({
      ok: true,
      result: {
        status: 'recovery_superseded',
        reason: 'source_tuple_mismatch',
        serviceId: 'gemini',
        groupId: 'gemini-main',
        profileId: 'leeroy',
      },
    });
    const { handler, messageBuffer, session, state } = createHarness();
    const acceptedIssues: SessionRuntimeIssueV1[] = [];
    const lifecycle = createSessionTurnLifecycle({ sessionId: session.sessionId, enqueueSessionTurn: async (mutation) => {
      if (mutation.action === 'fail' && mutation.issue) acceptedIssues.push(mutation.issue);
    } });
    session.sessionTurnLifecycle = lifecycle;
    state.taskStartedSent = true;
    await lifecycle.beginTurn({ provider: 'gemini' });

    handler({
      type: 'status',
      status: 'error',
      detail: {
        status: 429,
        message: 'RAW_PROVIDER_ERROR_RESOURCE_EXHAUSTED',
      },
    } as any);

    await expect.poll(() => session.sendSessionEvent.mock.calls).toEqual([[
      {
        type: 'message',
        message: 'Connected-service account already updated; the old turn was interrupted.',
      },
    ]]);
    expect(acceptedIssues).toHaveLength(1);
    expect(notifyDaemonConnectedServiceRuntimeAuthFailureMock.mock.calls[0]?.[0].classification.runtimeIssueFingerprint)
      .toBe(buildUsageLimitIssueFingerprint(acceptedIssues[0]!));
    expect(session.sendAgentMessage).not.toHaveBeenCalledWith('gemini', expect.objectContaining({ type: 'message' }));
    expect(messageBuffer.addMessage).not.toHaveBeenCalled();
  });

  it('preserves the status-error raw fallback when the daemon does not handle recovery', async () => {
    stubConnectedGeminiSelection();
    notifyDaemonConnectedServiceRuntimeAuthFailureMock.mockResolvedValue({
      ok: true,
      result: { status: 'unhandled' },
    });
    const { handler, messageBuffer, session } = createHarness();

    handler({
      type: 'status',
      status: 'error',
      detail: {
        status: 429,
        message: 'RAW_PROVIDER_ERROR_RESOURCE_EXHAUSTED',
      },
    } as any);

    await expect.poll(() => session.sendAgentMessage.mock.calls).toContainEqual([
      'gemini',
      {
        type: 'message',
        message: 'Error: RAW_PROVIDER_ERROR_RESOURCE_EXHAUSTED',
      },
    ]);
    expect(messageBuffer.addMessage).toHaveBeenCalledWith(
      'Error: RAW_PROVIDER_ERROR_RESOURCE_EXHAUSTED',
      'status',
    );
    expect(session.sendSessionEvent).not.toHaveBeenCalled();
  });

  it('preserves the raw fallback when unhandled turn-failure persistence rejects', async () => {
    vi.stubEnv('HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON', '');
    const { handler, session, state } = createHarness();
    state.thinking = true;
    session.sessionTurnLifecycle = {
      beginTurn: vi.fn(async () => {
        throw new Error('turn lifecycle unavailable');
      }),
    };

    handler({
      type: 'status',
      status: 'error',
      detail: 'RAW_PROVIDER_ERROR_UNHANDLED',
    } as any);

    await expect.poll(() => session.sendAgentMessage.mock.calls).toContainEqual([
      'gemini',
      {
        type: 'message',
        message: 'Error: RAW_PROVIDER_ERROR_UNHANDLED',
      },
    ]);
  });
});
