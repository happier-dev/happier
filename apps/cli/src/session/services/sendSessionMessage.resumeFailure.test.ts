import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosError } from 'axios';

import { sendSessionMessage } from './sendSessionMessage';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import { buildTrustedHostSessionInputAdmissionV1, deriveWorkflowSessionInputLocalIdV2, SessionMessageSendResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { buildSessionStopHoldV1 } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
const sockets = vi.hoisted(() => ({ connect: vi.fn() }));
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
vi.mock('@/api/session/sockets', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/session/sockets')>();
  return { ...actual, createSessionScopedSocketConnection: sockets.connect };
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
    if (url.endsWith('/discard')) return { status: 200, data: { ok: true } };
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

describe('a message send after Stop', () => {
  const heldStop = () => {
    const hold = buildSessionStopHoldV1({ rawSession: { id: sessionId }, stopIntent: 'explicit_stop',
      executionAuthority: 'present_user', requestId: 'person-stop', requestedAtMs: 1 });
    if (hold.kind !== 'hold') throw new Error('Expected an explicit person Stop');
    receiverMetadata = { sessionExplicitStopV1: hold.stop };
    return hold.stop;
  };
  const transport = () => vi.fn(async (_method: string, _request: unknown) => ({ type: 'success', sessionId }));

  it.each(['account', 'cli', 'present_user', 'automation'] as const)('%s send resumes through the Resume authority, once', async source => {
    const stop = heldStop();
    const machineResumeTransport = transport();
    expect(await sendSessionMessage({ credentials: { token: 'account-token', encryption: null },
      idOrPrefix: sessionId, message: 'Pick this back up', localId: 'send-1', wait: false, timeoutMs: 1000,
      explicitMessageSend: true, machineResumeTransport,
      ...(source === 'cli' ? { inputAdmission: buildTrustedHostSessionInputAdmissionV1('cli') } : {}),
      ...(source === 'present_user' ? { executionAuthority: 'present_user' as const } : {}),
      ...(source === 'automation' ? { executionAuthority: 'account_automation' as const } : {}),
    })).toMatchObject({ ok: true, localId: 'send-1' });
    expect(machineResumeTransport).toHaveBeenCalledOnce();
    expect(machineResumeTransport.mock.calls[0]?.[1]).toMatchObject({
      executionAuthorization: { provenance: 'user_request', requestId: 'send-1' } });
    // Only the launch owner clears the hold, after an exact successful resume.
    expect(receiverMetadata.sessionExplicitStopV1).toEqual(stop);
  });

  it('an agent or manager Session send wakes the stopped receiver through the same rule', async () => {
    heldStop();
    const machineAdmissionTransport = vi.fn(async () => ({ status: 'accepted', localId: 'agent-send' } as const));
    const machineResumeTransport = transport();
    expect(await sendSessionMessage({ credentials: { token: 'account-token', encryption: null }, idOrPrefix: sessionId,
      message: 'new instruction', localId: 'agent-send', wait: false, timeoutMs: 1000, explicitMessageSend: true,
      inputAdmission: protectedSender, machineAdmissionTransport, machineResumeTransport,
    })).toMatchObject({ ok: true, receiverDelivery: { disposition: 'wake' } });
    expect(machineResumeTransport).toHaveBeenCalledOnce();
    expect(machineResumeTransport.mock.calls[0]?.[1]).toMatchObject({ executionAuthorization: { provenance: 'user_request' } });
  });

  it('an automatic delivery that is not a new send stays held and starts nothing', async () => {
    const stop = heldStop();
    const machineResumeTransport = transport();
    expect(await sendSessionMessage({ credentials: { token: 'account-token', encryption: null },
      idOrPrefix: sessionId, message: 'Continue after the limit', localId: 'automatic-1', wait: false, timeoutMs: 1000,
      machineResumeTransport,
    })).toMatchObject({ ok: false, code: 'held_by_person', admissionResult: { status: 'accepted', localId: 'automatic-1' } });
    expect(machineResumeTransport).not.toHaveBeenCalled();
    expect(receiverMetadata.sessionExplicitStopV1).toEqual(stop);
  });

  it('a send into a Session without a hold mints no Resume authority', async () => {
    receiverMetadata = {};
    const machineResumeTransport = transport();
    expect(await sendSessionMessage({ credentials: { token: 'account-token', encryption: null },
      idOrPrefix: sessionId, message: 'Ordinary', localId: 'ordinary-unheld', wait: false, timeoutMs: 1000,
      explicitMessageSend: true, machineResumeTransport,
    })).toMatchObject({ ok: true });
    expect(machineResumeTransport.mock.calls[0]?.[1]).not.toHaveProperty('executionAuthorization');
  });
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

it('preserves pre-effect mute for a Workflow invocation carrying Discussion addressing', async () => {
  const discussionAddressing = { discussionId: 'discussion', messageId: 'question', throughSeq: 2, participantSessionId: sessionId };
  receiverMuteScopes = [{ kind: 'source', source: { kind: 'discussion', discussionId: discussionAddressing.discussionId } }];
  const workflow = { purpose: 'invocation', runId: 'run', invocationRecordId: 'invocation' } as const;
  const localId = deriveWorkflowSessionInputLocalIdV2(workflow);
  const machineAdmissionTransport = vi.fn(async () => ({ status: 'accepted', localId } as const));
  const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId }));
  expect(await sendSessionMessage({ credentials: { token: 'account-token', encryption: null }, idOrPrefix: sessionId,
    message: 'Workflow input', localId, wait: false, timeoutMs: 1000, machineAdmissionTransport, spawnSession,
    inputAdmission: { request: { v: 2, producer: 'workflow', caller: { kind: 'host' }, permission: {}, workflow,
      discussionAddressing, replyIntent: { mode: 'wait' } },
      provenance: { v: 2, kind: 'workflow_invocation', runId: workflow.runId, invocationRecordId: workflow.invocationRecordId } },
  })).toMatchObject({ ok: true, suppressed: true, receiverDelivery: { disposition: 'drop', reason: 'muted' } });
  expect(machineAdmissionTransport).not.toHaveBeenCalled();
  expect(spawnSession).not.toHaveBeenCalled();
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

it('holds an automatic Session delivery after Stop that is not a new send', async () => {
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
it.each([
  { description: 'unclaimed input', settlementReply: null },
  { description: 'runner-owned input', settlementReply: { status: 409, error: 'delivery-settlement-conflict' } },
])('returns the wake refusal and accepted receipt for $description', async ({ settlementReply }) => {
  const machineResumeTransport = vi.fn(async () => ({ errorCode: 'RPC_FORBIDDEN', error: 'Forbidden' }));
  http.post.mockImplementation(async (url: string) => {
    if (url.endsWith('/pending')) return { status: 200, data: { didWrite: true, terminal: false, suppressed: false } };
    if (url.endsWith('/delivery/block')) {
      if (settlementReply) throw pendingHttpRefusal(settlementReply);
      return { status: 200, data: { ok: true } };
    }
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

it.each(['SESSION_DIRECTORY_MISSING', 'SPAWN_FAILED'])('settles the carried input when Machine resume is refused with %s', async (errorCode) => {
  let pendingCount = 0;
  http.post.mockImplementation(async (url: string, body: unknown) => {
    if (url.endsWith('/pending')) { pendingCount += 1; return { status: 200, data: { didWrite: true, terminal: false, suppressed: false } }; }
    if (url.endsWith('/pending/resume-refusal-input/discard')) {
      expect(body).toEqual({ reason: 'resume_failed' });
      pendingCount -= 1;
      return { status: 200, data: { ok: true, pendingCount } };
    }
    throw new Error(`Unexpected HTTP request: ${url}`);
  });
  const machineResumeTransport = vi.fn(async () => ({ type: 'error', errorCode, errorMessage: 'Machine could not resume' }));
  await expect(sendSessionMessage({
    credentials: { token: 'account-token', encryption: null }, idOrPrefix: sessionId,
    message: 'continue', localId: 'resume-refusal-input', wait: false, timeoutMs: 1000,
    machineResumeTransport,
  })).resolves.toMatchObject({
    ok: false, code: 'resume_failed', message: 'Machine could not resume',
    admissionResult: { status: 'accepted', localId: 'resume-refusal-input' },
    settlementResult: { status: 'failed', code: 'resume_failed', localId: 'resume-refusal-input' },
  });
  expect(machineResumeTransport).toHaveBeenCalledOnce();
  expect(pendingCount).toBe(0);
});

it('retains the typed Machine refusal through ordinary Send after accepting Pending custody', async () => {
  const errorDetail = { kind: 'launch_error', code: 'requester_session_custody_unavailable',
    message: 'Requester Session custody is unavailable' } as const;
  const machineResumeTransport = vi.fn(async () => ({ type: 'error', errorCode: 'SPAWN_VALIDATION_FAILED',
    errorMessage: errorDetail.message, errorDetail, runtimeFailureReason: 'runner_authority_unavailable' }));
  await expect(sendSessionMessage({
    credentials: { token: 'account-token', encryption: null }, idOrPrefix: sessionId,
    message: 'continue', localId: 'typed-resume-refusal', wait: false, timeoutMs: 1000, machineResumeTransport,
  })).resolves.toMatchObject({ ok: false, code: 'resume_failed',
    spawnErrorCode: 'SPAWN_VALIDATION_FAILED', runtimeFailureReason: 'runner_authority_unavailable', errorDetail,
    admissionResult: { status: 'accepted', localId: 'typed-resume-refusal' },
  });
});

function pendingHttpRefusal(reply: { status: number; error: string }) {
  return Object.assign(new AxiosError(`Request failed with status code ${reply.status}`), {
    response: { status: reply.status, data: { error: reply.error } },
  });
}

it.each([
  { entry: 'service', description: 'retained input through the service' },
  { entry: 'action', description: 'retained input through the Action' },
  { entry: 'continuity-action', description: 'continuity refusal through the Action' },
  { entry: 'action', description: 'runner-owned input through the Action', settlementReply: { status: 409, error: 'delivery-settlement-conflict' } },
  { entry: 'action', description: 'input already removed from Pending through the Action', settlementReply: { status: 404, error: 'not-found' } },
  { entry: 'service', description: 'unrecognized settlement failure through the service', settlementReply: { status: 409, error: 'pending-mutation-conflict' }, propagateFailure: true },
  { entry: 'service', description: 'missing Session through the service', settlementReply: { status: 404, error: 'session-not-found' }, propagateFailure: true },
] as const)('handles a waiting send startup refusal for $description', async row => {
  const { entry } = row;
  const settlementFailure = 'settlementReply' in row ? pendingHttpRefusal(row.settlementReply) : null;
  const localId = 'failed-start-later-send';
  receiverMetadata = { lifecycleState: 'failed' };
  const errorDetail = entry === 'continuity-action' ? { kind: 'connected_service_resume_unreachable',
    continuityErrorCode: 'provider_session_state_unavailable_for_resume', failurePhase: 'continuity', agentId: 'gemini',
    reason: 'gemini_resume_unreachable', uxDiagnostic: { code: 'provider_session_state_unavailable_for_resume',
      failurePhase: 'continuity', source: 'spawn_resume', agentId: 'gemini', retryable: false,
      suggestedActions: ['start_fresh_under_selected_account', 'resume_current_account', 'open_connected_accounts'],
      diagnostics: { reason: 'gemini_resume_unreachable' } } } as const
    : { kind: 'launch_error', code: 'agent_startup_model_reconciliation_failed',
    message: 'Review the selected model.', failureCause: { code: 'agent_startup_model_reconciliation_failed',
      phase: 'client_start', failureReason: 'model_selection_required', retryable: false },
    childExit: { code: 1, signal: null, stderrHead: 'Error: cannot open /home/alice/private-repo/.env' },
    spawnFailure: { reason: 'too_many_open_files', errno: 'EMFILE', cwd: '/home/alice/private-repo' } } as const;
  // Pending settlement is plaintext on the server: only the typed cause leaves this CLI.
  const settledCause = entry === 'continuity-action' ? { kind: 'connected_service_resume_unreachable',
    uxDiagnostic: { code: 'provider_session_state_unavailable_for_resume', failurePhase: 'continuity',
      source: 'spawn_resume', retryable: false,
      suggestedActions: ['start_fresh_under_selected_account', 'resume_current_account', 'open_connected_accounts'] } }
    : { kind: 'launch_error', code: 'agent_startup_model_reconciliation_failed',
      failureCause: { code: 'agent_startup_model_reconciliation_failed', phase: 'client_start',
        failureReason: 'model_selection_required', retryable: false },
      childExit: { code: 1, signal: null }, spawnFailure: { reason: 'too_many_open_files', errno: 'EMFILE' } };
  let retainedInput: unknown;
  let handledSettlementRequest = false;
  const readSession = http.get.getMockImplementation();
  http.get.mockImplementation(async (url: string) => {
    if (url.endsWith(`/messages/by-local-id/${localId}`)) {
      throw { response: { status: 404, data: { error: 'message_not_found' } } };
    }
    if (url.endsWith(`/pending?includeDiscarded=true`)) return { status: 200, data: { pending: [] } };
    return readSession?.(url);
  });
  const socket = createApiSessionSocketStub({ connected: true });
  // Socket.IO is a genuine boundary; the shared observer and its existing wait budget stay real.
  sockets.connect.mockImplementation(() => ({ socket, transport: createSocketTransportAdapter(socket as never) }));
  http.post.mockImplementation(async (url: string, body: unknown) => {
    if (url.endsWith(`/v2/sessions/${sessionId}/pending`)) {
      retainedInput = body;
      return { status: 200, data: { didWrite: true, terminal: false, suppressed: false } };
    }
    if (url.endsWith(`/pending/${localId}/discard`)) {
      expect(body).toEqual({ reason: 'resume_failed', errorDetail: settledCause });
      expect(JSON.stringify(body)).not.toMatch(/private-repo|cannot open|Review the selected model|gemini_resume_unreachable/u);
      handledSettlementRequest = true;
      if (settlementFailure) throw settlementFailure;
      return { status: 200, data: { ok: true, didUpdate: true } };
    }
    throw new Error(`Unexpected HTTP request: ${url}`);
  });
  let admittedSpawnNonce: string | undefined;
  const machineResumeTransport = vi.fn(async (method: string, request: unknown) => {
    if (method === RPC_METHODS.SPAWN_HAPPY_SESSION) {
      const nonce = request && typeof request === 'object' ? Reflect.get(request, 'spawnNonce') : undefined;
      admittedSpawnNonce = typeof nonce === 'string' ? nonce : undefined;
      return { type: 'success', sessionId, ...(admittedSpawnNonce ? { spawnNonce: admittedSpawnNonce } : {}) };
    }
    if (method === RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE) {
      expect(request).toMatchObject({ spawnNonce: admittedSpawnNonce });
      return { status: 'error', errorCode: 'SPAWN_FAILED', errorMessage: 'Resume refused', errorDetail };
    }
    throw new Error(`Unexpected Machine request: ${method}`);
  });
  const credentials = { token: 'account-token', encryption: null };
  const expectedFailure = { status: 'failed', code: 'resume_failed', localId, errorDetail,
    admissionResult: { status: 'accepted', localId } };
  if (entry === 'service') {
    const send = sendSessionMessage({ credentials, idOrPrefix: sessionId,
      message: 'Keep this prompt for recovery', localId, wait: true, timeoutMs: 1000, machineResumeTransport,
    });
    if ('propagateFailure' in row) await expect(send).rejects.toBe(settlementFailure);
    else await expect(send).resolves.toMatchObject({ ok: false, code: 'resume_failed', errorDetail,
      admissionResult: { status: 'accepted', localId }, settlementResult: expectedFailure });
  } else {
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: 'daemon-global',
      mode: 'plain', ctx: null, machineActionDirectTargetTransport: { machineId: 'machine-1', invoke: machineResumeTransport } });
    const outcome = await createActionExecutor(deps).execute('session.message.send', {
      sessionId, message: 'Keep this prompt for recovery', localId, wait: true, timeoutSeconds: 1,
      requestedAction: { v: 1, kind: 'enqueue' },
    }, { surface: 'ui', authority: 'present_user' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.error);
    expect(SessionMessageSendResultV1Schema.parse(outcome.result)).toEqual(expectedFailure);
  }
  expect(handledSettlementRequest).toBe(true);
  expect(retainedInput).toMatchObject({ localId, content: { t: 'plain', v: {
    content: { text: 'Keep this prompt for recovery' },
  } } });
});
