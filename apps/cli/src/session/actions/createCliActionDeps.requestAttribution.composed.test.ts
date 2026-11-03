import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApprovalRequestV2Schema, SessionInputRequestV1Schema, ActionsSettingsV1Schema, FeaturesResponseSchema,
  buildTrustedHostSessionInputAdmissionV1, settleSessionInputRequestV1, withSessionInputAuthorityV1,
  type ApprovalRequest, type SessionInputAdmissionReceiptV1,
} from '@happier-dev/protocol';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { deriveSessionInputActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { createMcpServerActionExecuteV1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { encryptSessionPayload, openSessionStoredContent, sealSessionStoredContent } from '@/session/transport/encryption/sessionEncryptionContext';
import { createCliActionDeps } from './createCliActionDeps';
import { UserMessageSchema, SessionMessageContentSchema } from '@/api/types';
import { sendSessionMessage } from '@/session/services/sendSessionMessage';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { handleSessionNewMessageUpdate } from '@/api/session/sessionNewMessageUpdate';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';

const accountId = 'cli-sender';
const serverId = 'request-attribution-home';
const sessionId = 'cmv3requestattributionaaaa';
const machineId = 'shared-machine';
const localId = 'cli-original-input';
const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
const secret = new Uint8Array(32).fill(31);
const persona = { serverId, sessionId };
const accountAuthorization = {
  v: 1 as const, token: 'home-issued-input-authorization', binding: {
    accountId, authentication: { kind: 'account' as const, tokenEpoch: 0 },
    custodianAccountId: 'machine-owner', machineId, installationId: 'installed-machine',
    serverIdentityId: 'srv_request_attribution', actionId: 'session.message.send', requestId: 'input-action',
    requestEnvelopeDigest: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    target: { kind: 'session' as const, sessionId }, accountEncryptionMode: 'e2ee' as const,
  },
};

afterEach(() => { resetActiveAccountSettingsSnapshotForTests(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function installHomeBoundary(mode: 'e2ee' | 'plain') {
  const credentials = mode === 'plain' ? { token, encryption: null }
    : { token, encryption: { type: 'legacy' as const, secret } };
  const metadata = { machineId, permissionMode: 'default', permissionModeUpdatedAt: 1 };
  const rawSession = createSessionRecordFixture({ id: sessionId, active: true, encryptionMode: mode,
    machineId, metadata: mode === 'plain' ? JSON.stringify(metadata)
      : encryptSessionPayload({ ctx: { encryptionKey: secret, encryptionVariant: 'legacy' }, payload: metadata }),
    dataEncryptionKey: null });
  const reads: string[] = [];
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    reads.push(new URL(String(url)).pathname);
    if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200,
      data: createAccountEncryptionCurrentnessFixture({ mode }) };
    if (String(url).endsWith('/v1/account/profile')) return { status: 200, data: { id: accountId } };
    if (String(url).endsWith('/v2/account/settings')) return { status: 200, data: { content: null, version: 0 } };
    if (String(url).includes(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: rawSession } };
    throw new Error(`Unexpected Home read: ${url}`);
  });
  const accepted: ReturnType<typeof UserMessageSchema.parse>[] = [];
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(FeaturesResponseSchema.parse({
    features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_request_attribution' },
      encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } },
  }))));
  const accept = (content: Parameters<typeof openSessionStoredContent>[0]['content']) => {
    accepted.push(UserMessageSchema.parse(mode === 'plain'
      ? openSessionStoredContent({ mode: 'plain', ctx: null, content })
      : openSessionStoredContent({ mode: 'e2ee', ctx: { encryptionKey: secret, encryptionVariant: 'legacy' }, content })));
  };
  vi.spyOn(axios, 'post').mockImplementation(async (_url, body: unknown) => {
    if (!body || typeof body !== 'object') throw new Error('Expected Pending HTTP body');
    accept(SessionMessageContentSchema.parse(Reflect.get(body, 'content')
      ?? { t: 'encrypted', c: Reflect.get(body, 'ciphertext') }));
    return { status: 200, data: { didWrite: true, terminal: false, suppressed: false } };
  });
  return { credentials, reads, accept, accepted };
}

describe('CLI input requester through protected custody and danger approval', () => {
  it.each([
    { mode: 'e2ee', surface: 'cli', toolSurface: 'agent', senderKind: 'account' },
    { mode: 'plain', surface: 'cli', toolSurface: 'agent', senderKind: 'account' },
    { mode: 'e2ee', surface: 'ui', toolSurface: 'mcp', senderKind: 'account' },
    { mode: 'e2ee', surface: 'cli', toolSurface: 'agent', senderKind: 'terminal' },
  ] as const)('retains the $senderKind sender on $surface $mode input through $toolSurface and executes Allow only once', async ({ mode, surface, toolSurface, senderKind }) => {
    const { credentials, accept, accepted } = installHomeBoundary(mode);
    await bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force' });
    const deps = createCliActionDeps({ token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null, serverId,
      machineAdmissionTransport: async request => {
        accept(request.content);
        return { status: 'accepted', localId: request.localId };
      } });
    // The public Action owner builds the CLI request; only Home HTTP and the
    // authenticated Machine socket are replaced. Encryption/admission stay real.
    const sender = createActionExecutor(deps);
    const sent = senderKind === 'terminal' ? await sendSessionMessage({ credentials, idOrPrefix: sessionId, localId,
      expectedSessionAddress: persona, message: 'Test the configured MCP server', wait: false, timeoutMs: 30_000,
      inputAdmission: buildTrustedHostSessionInputAdmissionV1('cli'), callerInputAuthorization: {
        ...accountAuthorization, binding: { ...accountAuthorization.binding,
          authentication: { kind: 'terminal', tokenEpoch: 0 } },
      },
      machineAdmissionTransport: async request => { accept(request.content); return { status: 'accepted', localId: request.localId }; },
    }) : await sender.execute('session.message.send', { sessionId, localId, message: 'Test the configured MCP server',
      requestedAction: { v: 1, kind: 'enqueue' } }, {
      surface, authority: 'present_user', serverId, runtimeAccountId: accountId,
      actionCaller: { kind: 'host' }, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'session.message.send': ['cli'] } }),
    });
    expect(sent, JSON.stringify(sent)).toMatchObject(senderKind === 'terminal'
      ? { ok: true, admissionResult: { status: 'accepted', localId } }
      : { ok: true, result: { status: 'accepted', localId } });
    const acceptedRecord = accepted[0];
    if (!acceptedRecord) throw new Error('Input was not admitted');
    const request = acceptedRecord.meta?.happierInputRequestV1 === undefined ? undefined
      : SessionInputRequestV1Schema.parse(acceptedRecord.meta.happierInputRequestV1);
    const receipt: SessionInputAdmissionReceiptV1 = mode === 'plain' || surface === 'ui'
      ? { v: 1, issuer: 'authenticatedAccount', actorAccountId: accountId, sessionRelationship: 'owner' }
      : { v: 1, issuer: 'authenticatedMachine' };
    const authority = request ? settleSessionInputRequestV1({ request, currentSessionPermissionCeiling: 'default', inputAdmissionReceipt: receipt }) : undefined;
    const crypto = mode === 'plain' ? { mode, ctx: null }
      : { mode, ctx: { encryptionKey: secret, encryptionVariant: 'legacy' as const } };
    const delivered: ReturnType<typeof UserMessageSchema.parse>[] = [];
    handleSessionNewMessageUpdate({ ...crypto, sessionId, serverId,
      update: { id: 'new-input', seq: 1, createdAt: 1, body: { t: 'new-message', delivery: 'full' as const, sid: sessionId, message: {
        id: 'committed-input', seq: 1, localId, messageRole: 'user', inputAdmissionReceipt: receipt,
        content: sealSessionStoredContent({ ...crypto, payload: { ...acceptedRecord,
          ...(authority ? { meta: withSessionInputAuthorityV1(acceptedRecord.meta, authority) } : {}) } }),
        createdAt: 1, updatedAt: 1,
      } } }, receivedMessageIds: new Set(), lastObservedMessageSeq: 0, lastObservedUserMessageSeq: 0,
      emit: (event, message) => { if (event === 'user-message') delivered.push(UserMessageSchema.parse(message)); },
      debug: () => {}, debugLargeJson: () => {},
    });
    expect(delivered).toHaveLength(1);
    const attribution = delivered[0]?.actionRequestAttributionV1;
    expect(attribution).toMatchObject({ requestRef: localId, requester: { serverId, accountId }, persona });
    if (mode === 'plain') expect(request).not.toHaveProperty('actionRequestAttributionV1');

    let stored: ApprovalRequest | null = null;
    let cardCount = 0;
    let effects = 0;
    const danger = createActionExecutor({
      // Artifact persistence and the actual MCP process are system boundaries.
      // Real approval admission, transitions, replay and MCP schemas run here.
      approvalsCreate: async ({ request: proposal }) => { cardCount++; stored = ApprovalRequestV2Schema.parse(proposal); return { artifactId: 'd22-card' }; },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request: next }) => {
        if (!stored) throw new Error('Missing approval');
        const transition = decideApprovalRequestTransition(stored, next);
        if (!transition.ok) return transition;
        stored = ApprovalRequestV2Schema.parse(next);
        return { ok: true };
      },
      isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentnessFromCredentials({
        credentials, machineId, serverId, serverApiUrl: resolveServerHttpBaseUrl(),
      }),
      mcpServerAction: createMcpServerActionExecuteV1({
        readCatalog: async () => { throw new Error('Test is a Machine operation'); },
        mutate: async () => { throw new Error('Test does not edit the catalog'); },
        machine: async () => { effects++; return { ok: true, toolCount: 1, durationMs: 1 }; },
      }),
    });
    const context = { surface: 'agent' as const, authority: 'account_automation' as const,
      runtimeAccountId: accountId, serverId, defaultSessionId: sessionId, actionRequestId: 'danger-call',
      defaultSessionMachineId: machineId, serverIdentityId: 'srv_request_attribution',
      actionCaller: { kind: 'host' as const } };
    let actionSettings = ActionsSettingsV1Schema.parse({ v: 1 });
    const bridge = createActionToolExecutorBridge({ surface: toolSurface,
      resolveActiveTurnPermissionWitness: () => ({ turnId: 'admitted-turn', inputId: localId,
        actionRequestAttributionV1: attribution }),
      executor: { execute: (id, input, toolContext) => danger.execute(id, input, { ...context, ...toolContext, actionsSettings: actionSettings }) },
    });
    const call = () => bridge.executeActionByToolName('action_execute', { actionId: 'mcp.servers.test',
      input: { t: 'byId', serverId: 'mcp-server', machineId, directory: '/workspace' } }, sessionId);
    const proposal = await call();
    expect(proposal, JSON.stringify(proposal)).toMatchObject({ ok: true,
      result: { kind: 'approval_request_created', artifactId: 'd22-card', actionId: 'mcp.servers.test' } });
    expect(stored).toMatchObject({ executionOriginV1: { actionRequestAttributionV1: { requester: { accountId } } } });
    expect(cardCount).toBe(1);
    expect(effects).toBe(0);
    const approve = () => danger.execute('approval.request.decide', { artifactId: 'd22-card', decision: 'approve' },
      { surface: 'ui', authority: 'present_user', runtimeAccountId: accountId, serverId });
    const decision = await approve();
    expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true,
      result: { status: 'executed', execution: { ok: true, result: { ok: true } } } });
    expect(stored).toMatchObject({ status: 'executed', execution: { ok: true, result: { ok: true } } });
    await approve();
    expect(effects).toBe(1);
    expect(cardCount).toBe(1);
    actionSettings = ActionsSettingsV1Schema.parse({ v: 1,
      approvalWaivedSurfaces: { 'mcp.servers.test': [toolSurface] } });
    expect(await call()).toMatchObject({ ok: true, result: { ok: true } });
    expect(effects).toBe(2);
    expect(cardCount).toBe(1);
  });

  it.each(['e2ee', 'plain'] as const)('attributes an admitted shared Machine %s send to its authenticated Account rather than the custodian', async mode => {
    const { credentials, accept, accepted } = installHomeBoundary(mode);
    expect(await sendSessionMessage({ credentials, idOrPrefix: sessionId, localId, expectedSessionAddress: persona,
      message: 'A shared Machine is not the sending person', wait: false, timeoutMs: 30_000,
      inputAdmission: buildTrustedHostSessionInputAdmissionV1('cli'), callerInputAuthorization: {
        ...accountAuthorization, binding: { ...accountAuthorization.binding, accountEncryptionMode: mode },
      },
      machineAdmissionTransport: async request => { accept(request.content); return { status: 'accepted', localId: request.localId }; },
    })).toMatchObject({ ok: true });
    expect(accepted[0]).toMatchObject({ meta: { happierInputRequestV1: { actionRequestAttributionV1: {
      requester: { serverId, accountId },
    } } } });
  });

  it('does not promote an API-token root Account into an original human requester', async () => {
    const { credentials, accept, accepted } = installHomeBoundary('e2ee');
    const { authentication: _authentication, ...binding } = accountAuthorization.binding;
    expect(await sendSessionMessage({ credentials, idOrPrefix: sessionId, localId, expectedSessionAddress: persona,
      message: 'Unattended input', wait: false, timeoutMs: 30_000,
      inputAdmission: buildTrustedHostSessionInputAdmissionV1('cli'), callerInputAuthorization: {
        ...accountAuthorization, binding: { ...binding, principalId: 'api-principal', credentialId: 'api-credential',
          grant: API_TOKEN_FULL_GRANT_V1 },
      },
      machineAdmissionTransport: async request => { accept(request.content); return { status: 'accepted', localId: request.localId }; },
    })).toMatchObject({ ok: true });
    const request = SessionInputRequestV1Schema.parse(accepted[0]?.meta?.happierInputRequestV1);
    expect(request.actionRequestAttributionV1).toBeUndefined();
    const inputAdmissionReceipt = { v: 1, issuer: 'authenticatedMachine' } as const;
    const inputAuthority = settleSessionInputRequestV1({ request, inputAdmissionReceipt,
      currentSessionPermissionCeiling: 'default' });
    const cause = deriveSessionInputActionRequestAttributionV1({ requestRef: localId, persona, origin: null,
      messageRole: 'user', inputAdmissionReceipt, inputAuthority });
    expect(cause).toMatchObject({ requester: null });
    let cards = 0;
    const danger = createActionExecutor({ approvalsCreate: async () => { cards++; return { artifactId: 'forbidden' }; } });
    expect(await danger.execute('mcp.servers.test', { t: 'byId', serverId: 'mcp-server', machineId, directory: '/workspace' },
      { surface: 'agent', authority: 'account_automation', runtimeAccountId: accountId, serverId,
        defaultSessionId: sessionId, actionRequestAttributionV1: cause }))
      .toMatchObject({ ok: false, errorCode: 'approval_requester_unavailable' });
    expect(cards).toBe(0);
  });

  it.each(['requester', 'request', 'persona', 'credential', 'foreign-machine'] as const)('refuses a mismatched %s before admitting input', async mismatch => {
    const { credentials, accept, accepted } = installHomeBoundary('e2ee');
    const admission = buildTrustedHostSessionInputAdmissionV1('cli');
    const cause = { requestRef: mismatch === 'request' ? 'forged-input' : localId,
      requester: { serverId, accountId: mismatch === 'requester' ? 'machine-owner' : accountId },
      persona: mismatch === 'persona' ? { serverId, sessionId: 'foreign-session' } : persona, origin: null };
    const result = await sendSessionMessage({ credentials, idOrPrefix: sessionId, localId,
      expectedSessionAddress: persona, message: 'Untrusted attribution', wait: false, timeoutMs: 30_000,
      inputAdmission: { ...admission, request: { ...admission.request, actionRequestAttributionV1: cause } },
      ...(mismatch === 'credential' ? { callerInputAuthorization: { ...accountAuthorization,
        binding: { ...accountAuthorization.binding, accountId: 'another-account' } } } : {}),
      ...(mismatch === 'foreign-machine' ? { targetMachineId: 'another-accounts-machine' } : {}),
      machineAdmissionTransport: async request => { accept(request.content); return { status: 'accepted', localId: request.localId }; },
    });
    expect(result).toMatchObject({ ok: false, code: 'admission_rejected', admissionResult: {
      status: 'rejected', code: mismatch === 'foreign-machine' ? 'session_input_target_unavailable' : 'session_input_untrusted_assertion',
    } });
    expect(accepted).toEqual([]);
  });

  it('keeps persisted missing and malformed Machine attribution fail-closed without creating a card', async () => {
    let cards = 0;
    const danger = createActionExecutor({ approvalsCreate: async () => { cards++; return { artifactId: 'forbidden' }; } });
    const legacy = settleSessionInputRequestV1({ request: buildTrustedHostSessionInputAdmissionV1('cli').request,
      currentSessionPermissionCeiling: 'default', inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' } });
    for (const inputAuthority of [legacy, { ...legacy, actionRequestAttributionV1: { requester: { accountId: 'forged' } } }]) {
      const cause = deriveSessionInputActionRequestAttributionV1({ requestRef: localId, persona, origin: null,
        messageRole: 'user', inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' }, inputAuthority });
      const bridge = createActionToolExecutorBridge({ surface: 'agent',
        resolveActiveTurnPermissionWitness: () => ({ turnId: 'legacy-turn', inputId: localId,
          actionRequestAttributionV1: cause }),
        executor: { execute: (id, input, context) => danger.execute(id, input, {
          ...context, serverId, runtimeAccountId: accountId,
        }) },
      });
      expect(await bridge.executeActionByToolName('action_execute', { actionId: 'mcp.servers.test',
        input: { t: 'byId', serverId: 'mcp-server', machineId, directory: '/workspace' } }, sessionId))
        .toMatchObject({ ok: false, errorCode: 'approval_requester_unavailable' });
    }
    expect(cards).toBe(0);
  });
});
