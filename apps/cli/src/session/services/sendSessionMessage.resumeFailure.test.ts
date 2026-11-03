import { beforeEach, expect, it, vi } from 'vitest';

import { sendSessionMessage } from './sendSessionMessage';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
// HTTP and Machine RPC are external boundaries; admission and resume logic stay real.
vi.mock('axios', async importOriginal => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: { ...actual.default, ...http } };
});
vi.mock('@/configuration', async importOriginal => {
  const actual = await importOriginal<typeof import('@/configuration')>();
  return { ...actual, configuration: { ...actual.configuration,
  serverUrl: 'https://home.example', apiServerUrl: 'https://home.example', sessionControlHttpTimeoutMs: 1000,
  clientEncryptionRequirement: 'follow_account',
  } };
});

const sessionId = 'c123456789012345678901234';
let receiverActive = false;
let receiverMetadata: Record<string, unknown> = {};
let receiverMuteScopes: unknown[] = [];
let muteReadAvailable = true;
const senderSessionId = 'c223456789012345678901234';
const protectedSender = {
  provenance: { v: 1, kind: 'happierSession', sourceSessionId: senderSessionId, via: 'action', callerDepth: 1 },
  request: { v: 1, producer: 'sessionAction', caller: { kind: 'host' }, permission: { requestedPermissionCeiling: 'default' }, sourceSession: {
    sourceSessionId: senderSessionId, sourceTurnId: 'source-turn', sourceInputId: 'source-input', via: 'action',
  } },
} as const;

beforeEach(() => {
  receiverActive = false;
  receiverMetadata = {};
  receiverMuteScopes = [];
  muteReadAvailable = true;
  http.get.mockReset();
  http.post.mockReset();
  http.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/messages/reply-capability')) return { status: 200, data: { v: 1, protocolVersions: [1] } };
    if (url.endsWith(`/v2/sessions/${sessionId}/delivery-mutes`)) return {
      status: muteReadAvailable ? 200 : 503, data: { scopes: receiverMuteScopes },
    };
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    } };
    if (url.endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: {
      id: sessionId, seq: 1, createdAt: 1, updatedAt: 2, active: receiverActive, activeAt: 1, archivedAt: null,
      latestTurnStatus: receiverActive ? 'in_progress' : 'completed',
      pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0,
      encryptionMode: 'plain', metadataVersion: 0, agentState: null, agentStateVersion: 0,
      pendingCount: 0, pendingVersion: 0, share: null, dataEncryptionKey: null,
      metadata: JSON.stringify({ machineId: 'machine-1', path: '/repo', claudeSessionId: 'native-1',
        runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} }, ...receiverMetadata }),
    } } };
    throw new Error(`Unexpected HTTP request: ${url}`);
  });
  http.post.mockImplementation(async (url: string) => {
    if (url.endsWith(`/v2/sessions/${sessionId}/pending`)) return { status: 200, data: {
      didWrite: true, terminal: false, suppressed: false,
    } };
    throw new Error(`Unexpected HTTP request: ${url}`);
  });
});

it('accepts the Discussion original into Machine Pending before reusing the hosting daemon local resume owner', async () => {
  const discussionAddressing = { discussionId: 'discussion', messageId: 'question', throughSeq: 2, participantSessionId: sessionId };
  let accepted = false;
  const machineAdmissionTransport = vi.fn(async () => {
    accepted = true;
    return { status: 'accepted' as const, localId: 'discussion-original' };
  });
  // Process launch is the boundary. Receiver/Stop and snapshot reconstruction
  // are still the incumbent requestInactiveSessionResume implementation.
  const spawnSession = vi.fn(async (_options: SpawnSessionOptions) => {
    expect(accepted).toBe(true);
    return { type: 'success' as const, sessionId };
  });
  expect(await sendSessionMessage({ credentials: { token: 'account-token', encryption: null }, idOrPrefix: sessionId,
    message: 'Answer the question', localId: 'discussion-original', wait: false, timeoutMs: 1000,
    executionAuthority: 'account_automation', resumeInactiveSession: true,
    inputAdmission: { provenance: { v: 1, kind: 'host', producer: 'sessionAction' }, request: {
      v: 1, producer: 'sessionAction', caller: { kind: 'host' }, permission: {},
      discussionAddressing, replyIntent: { mode: 'return' },
    } }, machineAdmissionTransport, spawnSession,
  })).toMatchObject({ ok: true, admissionResult: { status: 'accepted', localId: 'discussion-original' } });
  expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({ existingSessionId: sessionId }));
  expect(spawnSession.mock.calls[0]?.[0]).not.toHaveProperty('executionAuthorization');
});

it('suppresses an admitted sender before writing or waking a muted receiver', async () => {
  receiverMuteScopes = [{ kind: 'sender_session', sessionId: senderSessionId }];
  const machineAdmissionTransport = vi.fn(async () => ({ status: 'accepted', localId: 'muted-send' } as const));
  const machineResumeTransport = vi.fn();
  expect(await sendSessionMessage({
    credentials: { token: 'account-token', encryption: null }, idOrPrefix: sessionId,
    message: 'new instruction', localId: 'muted-send', wait: false, timeoutMs: 1000,
    inputAdmission: protectedSender, machineAdmissionTransport, machineResumeTransport,
  })).toMatchObject({ ok: true, suppressed: true, receiverDelivery: { disposition: 'drop', reason: 'muted' } });
  expect(machineAdmissionTransport).not.toHaveBeenCalled();
  expect(machineResumeTransport).not.toHaveBeenCalled();
  expect(http.post).not.toHaveBeenCalled();
});

it('retains Pending without waking when the sender cannot read receiver policy', async () => {
  muteReadAvailable = false;
  const machineAdmissionTransport = vi.fn(async () => ({ status: 'accepted', localId: 'unknown-mute' } as const));
  expect(await sendSessionMessage({
    credentials: { token: 'account-token', encryption: null }, idOrPrefix: sessionId,
    message: 'new instruction', localId: 'unknown-mute', wait: false, timeoutMs: 1000,
    inputAdmission: protectedSender, machineAdmissionTransport,
  })).toMatchObject({ ok: true, waited: false, receiverDelivery: { disposition: 'hold', reason: 'receiver_unavailable' }, admissionResult: {
    status: 'accepted', localId: 'unknown-mute',
  } });
  expect(machineAdmissionTransport).toHaveBeenCalledOnce();
});

it('does not turn descriptive answer attribution into receiver policy authority', async () => {
  receiverMuteScopes = [{ kind: 'sender_session', sessionId: senderSessionId }];
  const machineAdmissionTransport = vi.fn(async () => ({ status: 'accepted', localId: 'muted-answer' } as const));
  expect(await sendSessionMessage({
    credentials: { token: 'account-token', encryption: null }, idOrPrefix: sessionId,
    message: 'answer', localId: 'muted-answer', wait: false, timeoutMs: 1000,
    informationDelivery: 'returned_answer', machineAdmissionTransport, resumeInactiveSession: false,
    inputAdmission: { provenance: { v: 1, kind: 'host', producer: 'sessionAction' }, request: {
      v: 1, producer: 'sessionAction', permission: {}, returnedAnswer: {
        requestSessionId: sessionId, requestLocalId: 'original-request', outcome: 'answer', delivery: 'wake',
        answeredBy: { v: 1, kind: 'happierSession', sourceSessionId: senderSessionId, via: 'action' },
      },
    } },
  })).toMatchObject({ ok: true, receiverDelivery: { disposition: 'next_turn' },
    admissionResult: { status: 'accepted', localId: 'muted-answer' },
  });
  expect(machineAdmissionTransport).toHaveBeenCalledOnce();
});

it('suppresses a protected returned sender without inventing an active source turn', async () => {
  receiverMuteScopes = [{ kind: 'sender_session', sessionId: senderSessionId }];
  const machineAdmissionTransport = vi.fn(async () => ({ status: 'accepted', localId: 'muted-return' } as const));
  const machineResumeTransport = vi.fn();
  expect(await sendSessionMessage({ credentials: { token: 'account-token', encryption: null }, idOrPrefix: sessionId,
    message: 'answer', localId: 'muted-return', wait: false, timeoutMs: 1000,
    informationDelivery: 'returned_answer', machineAdmissionTransport, machineResumeTransport,
    inputAdmission: { provenance: { v: 1, kind: 'host', producer: 'sessionAction' }, request: {
      v: 1, producer: 'sessionAction', permission: {}, returnedAnswer: {
        requestSessionId: senderSessionId, requestLocalId: 'original-request', outcome: 'cancelled', delivery: 'wake',
        senderSessionId,
      },
    } },
  })).toMatchObject({ ok: true, suppressed: true, receiverDelivery: { disposition: 'drop', reason: 'muted' } });
  expect(machineAdmissionTransport).not.toHaveBeenCalled();
  expect(machineResumeTransport).not.toHaveBeenCalled();
  expect(http.post).not.toHaveBeenCalled();
});

it('holds an agent send after person Stop without granting an explicit human resume', async () => {
  receiverMetadata = { sessionExplicitStopV1: { v: 1, cause: 'explicit_stop', requestId: 'person-stop', requestedAtMs: 1 } };
  const machineAdmissionTransport = vi.fn(async () => ({ status: 'accepted', localId: 'held-agent-input' } as const));
  const machineResumeTransport = vi.fn();
  expect(await sendSessionMessage({
    credentials: { token: 'account-token', encryption: null }, idOrPrefix: sessionId,
    message: 'new instruction', localId: 'held-agent-input', wait: false, timeoutMs: 1000,
    inputAdmission: protectedSender, machineAdmissionTransport, machineResumeTransport,
  })).toMatchObject({ ok: true, waited: false, receiverDelivery: { disposition: 'hold', reason: 'explicit_stop' } });
  expect(machineAdmissionTransport).toHaveBeenCalledWith(expect.objectContaining({
    requestedAction: { v: 1, kind: 'enqueue' },
  }), expect.anything());
  expect(machineResumeTransport).not.toHaveBeenCalled();
});

it.each(['agent_send', 'returned_answer'] as const)(
  'does not borrow a parent Session hold or occupancy for an exact Execution Run %s', async (delivery) => {
    receiverActive = true;
    receiverMetadata = { sessionExplicitStopV1: { v: 1, cause: 'explicit_stop', requestId: 'parent-stop', requestedAtMs: 1 } };
    const machineAdmissionTransport = vi.fn(async () => ({ status: 'accepted', localId: 'run-return' } as const));
    const machineResumeTransport = vi.fn();
    const result = await sendSessionMessage({
      credentials: { token: 'account-token', encryption: null }, idOrPrefix: sessionId,
      message: 'answer for the retained Run', localId: 'run-return', wait: false, timeoutMs: 1000,
      ...(delivery === 'returned_answer' ? { informationDelivery: 'returned_answer' as const } : {}),
      inputAdmission: protectedSender, executionAuthority: 'account_automation',
      recipient: { kind: 'execution_run', runId: 'run-1' },
      machineAdmissionTransport, machineResumeTransport,
    });
    expect(result).toMatchObject({ ok: true, admissionResult: { status: 'accepted', localId: 'run-return' } });
    expect(result).not.toHaveProperty('receiverDelivery');
    expect(machineAdmissionTransport).toHaveBeenCalledWith(expect.objectContaining({
      v: 2, recipient: { kind: 'execution_run', runId: 'run-1' },
    }), expect.anything());
    expect(machineResumeTransport).not.toHaveBeenCalled();
  },
);

it('retains a returned answer in Pending after explicit Stop without resuming or claiming acceptance', async () => {
  receiverMetadata = { sessionExplicitStopV1: { v: 1, cause: 'explicit_stop', requestId: 'person-stop', requestedAtMs: 1 } };
  const machineResumeTransport = vi.fn(async () => ({ type: 'success', sessionId }));
  const sent = await sendSessionMessage({
    credentials: { token: 'account-token', encryption: null }, idOrPrefix: sessionId,
    message: 'The answer is ready', localId: 'returned-answer-held', wait: false, timeoutMs: 1000,
    informationDelivery: 'returned_answer', machineResumeTransport,
  });
  expect(sent).toMatchObject({ ok: true, localId: 'returned-answer-held', waited: false,
    receiverDelivery: { disposition: 'hold', reason: 'explicit_stop' },
    admissionResult: { status: 'accepted', localId: 'returned-answer-held' },
  });
  expect(machineResumeTransport).not.toHaveBeenCalled();
  expect(http.post.mock.calls.find(([url]) => url.endsWith('/pending'))?.[1]).toMatchObject({
    localId: 'returned-answer-held', requestedAction: { v: 1, kind: 'enqueue' },
  });
});

it('queues a returned answer for a busy receiver without steering its active turn', async () => {
  receiverActive = true;
  const machineResumeTransport = vi.fn();
  expect(await sendSessionMessage({
    credentials: { token: 'account-token', encryption: null }, idOrPrefix: sessionId,
    message: 'The answer is ready', localId: 'returned-answer-busy', wait: false, timeoutMs: 1000,
    informationDelivery: 'returned_answer', machineResumeTransport,
  })).toMatchObject({ ok: true, receiverDelivery: { disposition: 'next_turn' } });
  expect(http.post.mock.calls.find(([url]) => url.endsWith('/pending'))?.[1]).toMatchObject({
    requestedAction: { v: 1, kind: 'enqueue' },
  });
  expect(machineResumeTransport).not.toHaveBeenCalled();
});

it('keeps an accepted returned answer pending when its exact Machine cannot resume', async () => {
  const machineResumeTransport = vi.fn(async () => { throw new Error('Machine disconnected'); });
  expect(await sendSessionMessage({
    credentials: { token: 'account-token', encryption: null }, idOrPrefix: sessionId,
    message: 'The answer is ready', localId: 'returned-answer-offline', wait: false, timeoutMs: 1000,
    informationDelivery: 'returned_answer', machineResumeTransport,
  })).toMatchObject({ ok: true, waited: false, admissionResult: { status: 'accepted', localId: 'returned-answer-offline' },
    receiverDelivery: { disposition: 'hold', reason: 'receiver_unavailable' },
    receiverResumeFailure: { ok: false, code: 'resume_failed' },
  });
});
it('marks accepted input visibly blocked when Machine wake admission is refused', async () => {
  const machineResumeTransport = vi.fn(async () => ({ errorCode: 'RPC_FORBIDDEN', error: 'Forbidden' }));
  http.post.mockImplementation(async (url: string) => {
    if (url.endsWith('/pending')) return { status: 200, data: { didWrite: true, terminal: false, suppressed: false } };
    if (url.endsWith('/delivery/block')) return { status: 200, data: { ok: true } };
    throw new Error(`Unexpected HTTP request: ${url}`);
  });
  expect(await sendSessionMessage({ credentials: { token: 'account-token', encryption: null }, idOrPrefix: sessionId,
    message: 'continue', localId: 'wake-refused', wait: false, timeoutMs: 1000, machineResumeTransport,
  })).toMatchObject({ ok: false, code: 'authority_unavailable', admissionResult: { status: 'accepted', localId: 'wake-refused' } });
  expect(http.post.mock.calls).toContainEqual([
    `https://home.example/v2/sessions/${sessionId}/pending/wake-refused/delivery/block`,
    { reason: 'session_input_target_unavailable' }, expect.anything(),
  ]);
});

it.each(['SESSION_DIRECTORY_MISSING', 'SPAWN_FAILED'])('maps the Machine resume refusal %s to resume_failed while retaining accepted input', async (errorCode) => {
  const machineResumeTransport = vi.fn(async () => ({ type: 'error', errorCode, errorMessage: 'Machine could not resume' }));
  await expect(sendSessionMessage({
    credentials: { token: 'account-token', encryption: null }, idOrPrefix: sessionId,
    message: 'continue', localId: 'resume-refusal-input', wait: false, timeoutMs: 1000,
    machineResumeTransport,
  })).resolves.toMatchObject({
    ok: false, code: 'resume_failed', message: 'Machine could not resume',
    admissionResult: { status: 'accepted', localId: 'resume-refusal-input' },
  });
  expect(machineResumeTransport).toHaveBeenCalledOnce();
});
