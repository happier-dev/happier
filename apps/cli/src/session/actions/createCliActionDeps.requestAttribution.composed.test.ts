import axios from 'axios';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { AgentSessionRuntime, AgentSessionRuntimeContext, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { createNativeAgentSessionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import * as daemonControl from '@/daemon/controlHttp';
import { createCliBrowserRuntimeActionExecutor } from '@/daemon/browser/actions/controlTransport';
import {
  ApprovalRequestV2Schema, SessionInputRequestV1Schema, ActionsSettingsV1Schema, FeaturesResponseSchema,
  buildTrustedHostSessionInputAdmissionV1, settleSessionInputRequestV1, withSessionInputAuthorityV1,
  type ApprovalRequest, type SessionInputAdmissionReceiptV1,
} from '@happier-dev/protocol';
import { buildCommittedLaunchMetadata } from '@/agent/runtime/createSessionMetadata';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { deriveSessionInputActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { createMcpServerActionExecuteV1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { encryptSessionPayload, openSessionStoredContent, sealSessionStoredContent } from '@/session/transport/encryption/sessionEncryptionContext';
import { createCliActionDeps } from './createCliActionDeps';
import { UserMessageSchema, SessionMessageContentSchema } from '@/api/types';
import { sendSessionMessage } from '@/session/services/sendSessionMessage';
import { buildSessionSpawnInitialInputAdmissionForLocalIdV1 } from '@/session/services/sessionInputAdmissionIdentity';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { handleSessionNewMessageUpdate } from '@/api/session/sessionNewMessageUpdate';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { getActionSpec, projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { DISCUSSION_ACTION_INPUT_SCHEMAS_V1 } from '@happier-dev/protocol/discussions/actions';
import { SessionActionRpcOriginV1Schema } from '@happier-dev/protocol/socketRpc';
import { resolveSessionRoleRpcOrigin } from './sessionRoleRpcOrigin';
import { buildActionExecutorContextForRpc } from '@/rpc/handlers/_actionDispatchAdapter';
import { executeExternalAction } from '@/daemon/externalActions/executeExternalAction';
import { ExternalActionRequesterInvocationV1Schema } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { sealExternalActionRequestV2, openExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import tweetnacl from 'tweetnacl';

const accountId = 'cli-sender';
const serverId = 'srv_request_attribution';
const sessionId = 'cmv3requestattributionaaa';
const machineId = 'shared-machine';
const localId = 'cli-original-input';
const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
const secret = new Uint8Array(32).fill(31);
const persona = { serverId, sessionId };
const mcpEffect = { actionId: 'mcp.servers.test',
  input: { t: 'byId', serverId: 'mcp-server', machineId, directory: '/workspace' },
  output: { ok: true, toolCount: 1, durationMs: 1 } } as const;
const storageItem = { ref: { itemId: 'own-file', path: '/workspace/own-file',
  identity: { dev: '1', ino: '2', kind: 'file' }, collectedAt: 1,
  collectedBy: { accountId, kind: 'person' } }, expect: 'reviewed-file' } as const;
const processTarget = { ref: 'owned-process', expect: { level: 'proven' } } as const;
const machineEffects = [
  { actionId: 'machines.storage.trash.move', input: { machineId, items: [{ ...storageItem, claimedVerdict: 'safe' }] },
    output: { batchId: 'approved-batch', mode: 'trash', outcomes: [{ itemId: 'own-file', status: 'moved' }], inTrashBytes: 64, freedBytes: 0 } },
  { actionId: 'machines.storage.deleteNow', input: { machineId, items: [storageItem] },
    output: { batchId: 'approved-batch', mode: 'delete', outcomes: [{ itemId: 'own-file', status: 'deleted' }], inTrashBytes: 0, freedBytes: 64 } },
  { actionId: 'machines.processes.stop', input: { machineId, targets: [processTarget] },
    output: { status: 'ended', outcomes: [{ ref: 'owned-process', outcome: 'ended', freedBytes: 64 }] } },
  { actionId: 'machines.processes.kill', input: { machineId, targets: [processTarget], tree: false },
    output: { status: 'ended', outcomes: [{ ref: 'owned-process', outcome: 'ended', freedBytes: 64 }] } },
  { actionId: 'machines.guard.sessionCeiling.set', input: { machineId, sessionId, bytes: 1073741824 },
    output: { status: 'applied', appliesAt: 'next_start' } },
] as const;
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
  let rawSession = createSessionRecordFixture({ id: sessionId, active: true, encryptionMode: mode,
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
  const acceptedLocalIds: string[] = [];
  const acceptedIssuers: Array<SessionInputAdmissionReceiptV1['issuer']> = [];
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async url => String(url).endsWith('/v1/account/profile')
    ? Response.json({ id: accountId }) : Response.json(FeaturesResponseSchema.parse({
    features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_request_attribution' },
      encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } },
  }))));
  const accept = (content: Parameters<typeof openSessionStoredContent>[0]['content'], admittedLocalId: string,
    issuer: SessionInputAdmissionReceiptV1['issuer'] = 'authenticatedMachine') => {
    acceptedLocalIds.push(admittedLocalId);
    acceptedIssuers.push(issuer);
    accepted.push(UserMessageSchema.parse(mode === 'plain'
      ? openSessionStoredContent({ mode: 'plain', ctx: null, content })
      : openSessionStoredContent({ mode: 'e2ee', ctx: { encryptionKey: secret, encryptionVariant: 'legacy' }, content })));
  };
  vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
    if (String(url).endsWith('/lookup-by-tags')) return { status: 200, data: { sessions: [] } };
    if (!body || typeof body !== 'object') throw new Error('Expected Pending HTTP body');
    const pendingLocalId: unknown = Reflect.get(body, 'localId');
    if (typeof pendingLocalId !== 'string') throw new Error('Missing Pending local id');
    accept(SessionMessageContentSchema.parse(Reflect.get(body, 'content')
      ?? { t: 'encrypted', c: Reflect.get(body, 'ciphertext') }), pendingLocalId, 'authenticatedAccount');
    return { status: 200, data: { didWrite: true, terminal: false, suppressed: false } };
  });
  return { credentials, reads, accept, accepted, acceptedLocalIds, acceptedIssuers, spawned: (options: Parameters<typeof buildCommittedLaunchMetadata>[0]['options']) => {
    const launched = buildCommittedLaunchMetadata({ options, directory: options.directory ?? '/workspace' });
    rawSession = { ...rawSession, active: true, metadata: mode === 'plain' ? JSON.stringify(launched)
      : encryptSessionPayload({ ctx: { encryptionKey: secret, encryptionVariant: 'legacy' }, payload: launched }) };
  } };
}

describe('CLI input requester through protected custody and danger approval', () => {
  it.each(['plain', 'e2ee'] as const)('retains the requester when an approval result resumes the agent before Browser navigation (%s)', async mode => {
    const { credentials, accept, accepted, acceptedLocalIds, acceptedIssuers, reads } = installHomeBoundary(mode);
    await bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force' });
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(69));
    const cli = createCliActionDeps({ token, credentials, sessionId, mode: 'plain', ctx: null, serverId,
      serverIdentityId: serverId, externalActionMachineRequestPrivateKey: installation.secretKey,
      externalActionMachineInstallationId: 'installed-machine',
      machineAdmissionTransport: async request => {
        accept(request.content, request.localId);
        return { status: 'accepted', localId: request.localId };
      } });
    const requests = new Map<string, ApprovalRequest>();
    let postAllowed = false;
    let publications = 0;
    const navigated: unknown[] = [];
    // Authenticated daemon IPC is the Browser process boundary; Action admission remains real.
    vi.spyOn(daemonControl, 'daemonPost').mockImplementation(async (_path, body) => {
      navigated.push(body);
      return { result: { v: 1, commandId: 'continued-navigation', status: 'dispatched',
        adapterKind: 'chromiumSidecar', events: [] } };
    });
    const receiver = createActionExecutor({ sessionSendMessage: cli.sessionSendMessage });
    const executor = createActionExecutor({ sessionSendMessage: async args => {
      // The UI projection is tested at its real Account transport. This closed
      // private wire and receiver preserve the same approved origin to Pending.
      const invocation = ExternalActionRequesterInvocationV1Schema.parse(JSON.parse(JSON.stringify({
        caller: { kind: 'host' }, surface: args.context.surface, authority: args.context.authority,
        actionRequestAttributionV1: args.context.actionRequestAttributionV1,
      })));
      const target = { kind: 'machine' as const, machineId };
      const input = args.authoredInput ?? { sessionId: args.sessionId, message: args.message };
      const authentication = { kind: 'account' as const, tokenEpoch: 0 };
      const binding = { serverIdentityId: serverId, accountId, authentication, actionId: 'session.message.send',
        requestId: `continuation-${args.localId}`, target };
      const material = { type: 'dataKey' as const, machineKey: secret };
      const envelope = mode === 'plain' ? { v: 1 as const, requestId: binding.requestId, target, input }
        : sealExternalActionRequestV2({ binding, material, input, randomBytes: tweetnacl.randomBytes,
          projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1 });
      const result = await executeExternalAction({ actionId: 'session.message.send', envelope,
        principal: { accountId, authority: 'account_automation', authentication }, localRootInvocation: invocation,
        currentMachineId: machineId, currentServerId: serverId, currentInstallationId: 'installed-machine',
        executionAuthorization: { v: 1, token: 'continuation-authorization', binding: {
          accountId, authentication, custodianAccountId: accountId, serverIdentityId: serverId,
          machineId, installationId: 'installed-machine', actionId: 'session.message.send', requestId: envelope.requestId,
          target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), accountEncryptionMode: mode,
        } }, externalActionMachineRequestPrivateKey: installation.secretKey,
        resolveEncryption: async () => ({ serverIdentityId: serverId, material }),
        verifyExecutionAuthorization: async () => true, resolveTarget: async () => target, executor: receiver,
      });
      if (result.kind !== 'response') throw new Error(`Missing private continuation receipt: ${result.kind}`);
      const execution = envelope.v === 2
        ? openExternalActionResponseV2({ envelope: result.response, binding, material, request: envelope })
        : result.response.v === 1 ? result.response.execution : null;
      if (!execution) throw new Error('Invalid private continuation response');
      return execution.ok ? execution.result : execution;
    },
      runtimeActionExecute: createCliBrowserRuntimeActionExecutor({ sessionId }),
      approvalsCreate: async ({ request }) => {
        const artifactId = `doc-review-${requests.size + 1}`;
        requests.set(artifactId, ApprovalRequestV2Schema.parse(request));
        return { artifactId };
      },
      approvalsGet: async ({ artifactId }) => requests.get(artifactId) ?? null,
      approvalsUpdate: async ({ artifactId, request }) => {
        const previous = requests.get(artifactId);
        if (!previous) throw new Error('Missing approval');
        const transition = decideApprovalRequestTransition(previous, request);
        if (!transition.ok) return transition;
        requests.set(artifactId, ApprovalRequestV2Schema.parse(request));
        return { ok: true };
      },
      isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentnessFromCredentials({
        credentials, machineId, serverId, serverApiUrl: resolveServerHttpBaseUrl(),
        isSessionCallerCurrent: ({ caller }) => caller.sessionId === sessionId
          && native.readActiveTurnAdmissionWitness?.() !== null,
      }),
      discussionAction: async ({ actionId, input }) => {
        if (actionId === 'discussion.invite') {
          postAllowed = true;
          return { discussionId: 'doc-thread', ownerAccountId: accountId, access: 'owner', grants: [], changed: true };
        }
        if (actionId !== 'discussion.post') throw new Error('Unexpected Discussion operation');
        if (!postAllowed) return { ok: false, errorCode: 'discussion_post_denied', error: 'discussion_post_denied' };
        publications++;
        const post = DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.post'].parse(input);
        return { v: 1, serverId, messageSeq: 1, message: { id: 'proposal-message', discussionId: 'doc-thread',
          localId: post.localId, seq: 1, authorAccountId: null, accountActor: null, producerV1: null,
          content: post.content, replyTarget: post.replyTarget, mentionedAccountIds: [], createdAt: 1,
          messageRef: { kind: 'discussion', discussion: { serverId, discussionId: 'doc-thread' }, messageId: 'proposal-message' } } };
      },
    });
    const crypto = mode === 'plain' ? { mode, ctx: null }
      : { mode, ctx: { encryptionKey: secret, encryptionVariant: 'legacy' as const } };
    const humanReceipt = { v: 1, issuer: 'authenticatedAccount', actorAccountId: accountId, sessionRelationship: 'owner' } as const;
    const humanRequest = buildTrustedHostSessionInputAdmissionV1('ui').request;
    const humanAuthority = settleSessionInputRequestV1({ request: humanRequest,
      currentSessionPermissionCeiling: 'default', inputAdmissionReceipt: humanReceipt });
    expect(humanAuthority.actionRequestAttributionV1).toBeUndefined();
    const humanInputs: ReturnType<typeof UserMessageSchema.parse>[] = [];
    handleSessionNewMessageUpdate({ ...crypto, sessionId, serverId,
      update: { id: 'fresh-person-update', seq: 1, createdAt: 1, body: { t: 'new-message', delivery: 'full', sid: sessionId, message: {
        id: 'fresh-person-input', seq: 1, localId: 'person-request', messageRole: 'user', inputAdmissionReceipt: humanReceipt,
        content: sealSessionStoredContent({ ...crypto, payload: { role: 'user', content: { type: 'text', text: 'Propose the Doc correction' },
          meta: withSessionInputAuthorityV1({}, humanAuthority) } }), createdAt: 1, updatedAt: 1,
      } } }, receivedMessageIds: new Set(), lastObservedMessageSeq: 0, lastObservedUserMessageSeq: 0,
      emit: (event, message) => { if (event === 'user-message') humanInputs.push(UserMessageSchema.parse(message)); },
      debug: () => {}, debugLargeJson: () => {},
    });
    const original = humanInputs[0]?.actionRequestAttributionV1;
    if (!original) throw new Error('Fresh authenticated Account input has no requester');
    expect(original.requester).toEqual({ serverId, accountId });
    let publish: ((event: AgentSessionRuntimeEvent) => void) | undefined;
    const provider: AgentSessionRuntime = { async send() { return { status: 'admitted' }; },
      watch: listener => { publish = listener; return { dispose() {} }; }, dispose() {} };
    const native = createNativeAgentSessionOperations(provider, sessionId, undefined, undefined, undefined, undefined, undefined,
      { context: {} as AgentSessionRuntimeContext, // The external provider never calls SDK services.
        cwd: '/workspace', connectedAccounts: [], capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
        cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null } });
    onTestFinished(async () => { await native.resetOrDisposeRuntime(); });
    await native.sendTurnPrompt('Propose the Doc correction', { localId: original.requestRef, turnId: 'doc-turn',
      actionRequestAttributionV1: original,
      agentStartCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 } });
    publish?.({ kind: 'input-accepted', sequence: 0, sessionId, emittedAtMs: 0,
      inputIds: [original.requestRef], delivery: { kind: 'newTurn', turnId: 'doc-turn' } });
    publish?.({ kind: 'turn-start', sequence: 1, sessionId, emittedAtMs: 1, turnId: 'doc-turn', startedBy: 'host' });
    const agent = { surface: 'agent' as const, authority: 'account_automation' as const, runtimeAccountId: accountId,
      serverId, serverIdentityId: 'srv_request_attribution', defaultSessionId: sessionId, defaultSessionMachineId: machineId,
      actionCaller: { kind: 'session' as const, sessionId, starterDepth: 0, turnDepth: 0 } };
    const bridge = createActionToolExecutorBridge({ surface: 'agent',
      resolveCallerPermissionMode: () => 'default',
      resolveActiveTurnPermissionWitness: () => native.readActiveTurnAdmissionWitness?.(),
      executor: { execute: (id, input, context) => {
        // The authenticated socket is the boundary: retain the real producer,
        // closed wire parser and receiving projection beneath it.
        const origin = SessionActionRpcOriginV1Schema.parse(JSON.parse(JSON.stringify(
          resolveSessionRoleRpcOrigin({ ...agent, ...context }))));
        const received = buildActionExecutorContextForRpc({ sessionActionOrigin: origin,
          serverId, defaultSessionId: sessionId });
        return executor.execute(id, input, { ...agent, ...received });
      } },
    });
    const proposal = { target: { ref: { kind: 'doc', artifactId: 'doc', serverId }, revision: { headerVersion: 1, bodyVersion: 1 },
      range: { start: 0, end: 4 }, quote: 'Read' }, discussionRef: { serverId, discussionId: 'doc-thread' },
      baseRevision: { headerVersion: 1, bodyVersion: 1 }, before: 'Read', after: 'Review', reason: 'Clarify', localId: 'first-proposal' };
    let invocation = 0;
    const invoke = (actionId: string, input: unknown) => bridge.executeActionByToolName('action_execute', { actionId, input }, sessionId,
      { actionRequestId: `doc-tool-${++invocation}` });
    const approve = (artifactId: string) => executor.execute('approval.request.decide', { artifactId, decision: 'approve' },
      { surface: 'ui', authority: 'present_user', runtimeAccountId: accountId, serverId,
        serverIdentityId: 'srv_request_attribution', actionCaller: { kind: 'host' } });
    const firstProposal = await invoke('doc.edit.propose', proposal);
    expect(firstProposal, JSON.stringify(firstProposal)).toMatchObject({ ok: true, result: { artifactId: 'doc-review-1' } });
    const firstDecision = await approve('doc-review-1');
    expect(firstDecision, JSON.stringify({ firstDecision, reads })).toMatchObject({ ok: true,
      result: { status: 'failed', execution: { ok: false, errorCode: 'discussion_post_denied' } } });
    expect(await invoke('discussion.invite', { discussionId: 'doc-thread', participant: { kind: 'session', sessionId } }))
      .toMatchObject({ ok: true, result: { artifactId: 'doc-review-2' } });
    expect(await approve('doc-review-2')).toMatchObject({ ok: true });
    expect(await invoke('approval.request.decide', { artifactId: 'doc-review-2', decision: 'approve' }))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    // Consume the actual host-authored receipt through the production attribution owner.
    // This is an admitted approval-result input, not a fabricated replacement actor.
    const continued = accepted.at(-1);
    if (!continued) throw new Error('Missing approval-result Session input');
    const request = SessionInputRequestV1Schema.parse(continued.meta?.happierInputRequestV1);
    const receipt: SessionInputAdmissionReceiptV1 = acceptedIssuers.at(-1) === 'authenticatedAccount'
      ? { v: 1, issuer: 'authenticatedAccount', actorAccountId: accountId, sessionRelationship: 'owner' }
      : { v: 1, issuer: 'authenticatedMachine' };
    const authority = settleSessionInputRequestV1({ request, currentSessionPermissionCeiling: 'default', inputAdmissionReceipt: receipt });
    const continuedLocalId = acceptedLocalIds.at(-1);
    if (!continuedLocalId) throw new Error('Missing continuation identity');
    const delivered: ReturnType<typeof UserMessageSchema.parse>[] = [];
    handleSessionNewMessageUpdate({ ...crypto, sessionId, serverId,
      update: { id: 'approval-update', seq: 1, createdAt: 1, body: { t: 'new-message', delivery: 'full', sid: sessionId, message: {
        id: 'approval-input', seq: 1, localId: continuedLocalId, messageRole: 'user', inputAdmissionReceipt: receipt,
        content: sealSessionStoredContent({ ...crypto, payload: { ...continued,
          meta: withSessionInputAuthorityV1(continued.meta, authority) } }), createdAt: 1, updatedAt: 1,
      } } }, receivedMessageIds: new Set(), lastObservedMessageSeq: 0, lastObservedUserMessageSeq: 0,
      emit: (event, message) => { if (event === 'user-message') delivered.push(UserMessageSchema.parse(message)); },
      debug: () => {}, debugLargeJson: () => {},
    });
    expect(delivered).toHaveLength(1);
    expect(native.readActiveTurnAdmissionWitness?.()).toMatchObject({ turnId: 'doc-turn', actionRequestAttributionV1: original });
    const retry = await invoke('doc.edit.propose', { ...proposal, localId: 'retry-proposal' });
    expect(retry, JSON.stringify(retry)).toMatchObject({ ok: true, result: { artifactId: 'doc-review-3' } });
    expect(await approve('doc-review-3')).toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(publications).toBe(1);
    publish?.({ kind: 'turn-complete', sequence: 2, sessionId, emittedAtMs: 2, turnId: 'doc-turn' });
    await vi.waitFor(() => expect(native.readActiveTurnAdmissionWitness?.()).toBeNull());
    await native.sendTurnPrompt('Continue after the approved invitation', {
      localId: continuedLocalId, turnId: 'approval-result-turn',
      actionRequestAttributionV1: delivered[0]!.actionRequestAttributionV1,
      agentStartCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 },
    });
    publish?.({ kind: 'input-accepted', sequence: 3, sessionId, emittedAtMs: 3,
      inputIds: [continuedLocalId], delivery: { kind: 'newTurn', turnId: 'approval-result-turn' } });
    publish?.({ kind: 'turn-start', sequence: 4, sessionId, emittedAtMs: 4, turnId: 'approval-result-turn', startedBy: 'host' });
    await vi.waitFor(() => expect(native.readActiveTurnAdmissionWitness?.()).toMatchObject({ turnId: 'approval-result-turn',
      actionRequestAttributionV1: delivered[0]!.actionRequestAttributionV1 }));
    const navigation = await invoke('browser.navigate', { commandId: 'continued-navigation', kind: 'navigate',
      browserSessionId: sessionId, viewId: 'own-browser-view', url: 'https://example.com' });
    expect(navigation, JSON.stringify(navigation)).toMatchObject({ ok: true, result: { artifactId: 'doc-review-4' } });
    expect(navigated).toEqual([]);
    expect(await approve('doc-review-4')).toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(navigated).toMatchObject([{ actionId: 'browser.navigate', sessionId,
      input: { commandId: 'continued-navigation', viewId: 'own-browser-view' } }]);
    expect(delivered[0]!.actionRequestAttributionV1).toEqual(original);
  });
  it.each([...([
    { mode: 'e2ee', surface: 'cli', toolSurface: 'agent', senderKind: 'account' },
    { mode: 'plain', surface: 'cli', toolSurface: 'agent', senderKind: 'account' },
    { mode: 'e2ee', surface: 'ui', toolSurface: 'mcp', senderKind: 'account' },
    { mode: 'plain', surface: 'ui', toolSurface: 'mcp', senderKind: 'account' },
    { mode: 'e2ee', surface: 'voice', toolSurface: 'agent', senderKind: 'account' },
    { mode: 'e2ee', surface: 'rpc', toolSurface: 'mcp', senderKind: 'account' },
    { mode: 'e2ee', surface: 'cli', toolSurface: 'agent', senderKind: 'terminal' },
  ] as const).map(test => ({ ...test, effect: mcpEffect })),
    ...machineEffects.map(effect => ({ mode: 'e2ee' as const, surface: 'rpc' as const,
      toolSurface: 'mcp' as const, senderKind: 'account' as const, effect })),
  ])('retains the $senderKind sender on $surface $mode input through $toolSurface for $effect.actionId and executes Allow only once', async ({ mode, surface, toolSurface, senderKind, effect }) => {
    const { credentials, accept, accepted, acceptedLocalIds, spawned } = installHomeBoundary(mode);
    await bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force' });
    const deps = createCliActionDeps({ token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null, serverId,
      sessionSpawnDirectTargetTransport: { machineId,
        prepare: async () => ({ ok: true, directory: '/workspace', directoryKind: 'path', directoryCreationRequired: false, checkout: null }),
        spawnedSession: {
          spawn: async options => { spawned(options); return { type: 'success', sessionId,
            sessionCreationOutcome: { disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] } } }; },
          resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }),
        } },
      machineAdmissionTransport: async request => {
        accept(request.content, request.localId);
        return { status: 'accepted', localId: request.localId };
      } });
    // The public Action owner builds the CLI request; only Home HTTP and the
    // authenticated Machine socket are replaced. Encryption/admission stay real.
    const sender = createActionExecutor(deps);
    const firstInputHandoff = buildSessionSpawnInitialInputAdmissionForLocalIdV1({
      actionCaller: { kind: 'host' }, callerSurface: surface, callerAuthority: 'present_user', localId,
    });
    const firstInput = surface === 'ui' || surface === 'voice' || surface === 'rpc';
    const sent = surface === 'rpc' ? await sender.execute('session.spawn_new', {
      creationKey: localId, executionTarget: { serverId, machineId }, directory: { kind: 'path', path: '/workspace' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      connectedServices: { v: 2, bindingsByServiceId: {} }, memoryEnabled: false, initialInput: { text: 'Review my own fixture' },
    }, { surface, authority: 'present_user', serverId, runtimeAccountId: accountId, actionCaller: { kind: 'host' } })
      : firstInput ? await sendSessionMessage({ credentials, idOrPrefix: sessionId, localId,
      serverId, expectedSessionAddress: persona, message: 'Review my own fixture', wait: false, timeoutMs: 30_000,
      // The same producer that createSpawnedSession uses for the Ask composer.
      inputAdmission: firstInputHandoff.inputAdmission,
      executionAuthority: firstInputHandoff.executionAuthority,
      machineAdmissionTransport: async request => { accept(request.content, request.localId); return { status: 'accepted', localId: request.localId }; },
    }) : senderKind === 'terminal' ? await sendSessionMessage({ credentials, idOrPrefix: sessionId, localId,
      expectedSessionAddress: persona, message: 'Test the configured MCP server', wait: false, timeoutMs: 30_000,
      inputAdmission: buildTrustedHostSessionInputAdmissionV1('cli'), callerInputAuthorization: {
        ...accountAuthorization, binding: { ...accountAuthorization.binding,
          authentication: { kind: 'terminal', tokenEpoch: 0 } },
      },
      machineAdmissionTransport: async request => { accept(request.content, request.localId); return { status: 'accepted', localId: request.localId }; },
    }) : await sender.execute('session.message.send', { sessionId, localId, message: 'Test the configured MCP server',
      requestedAction: { v: 1, kind: 'enqueue' } }, {
      surface, authority: 'present_user', serverId, runtimeAccountId: accountId,
      actionCaller: { kind: 'host' }, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'session.message.send': ['cli'] } }),
    });
    expect(sent, JSON.stringify(sent)).toMatchObject(surface === 'rpc'
      ? { ok: true, result: { sessionId, initialInput: { status: 'accepted' } } }
      : senderKind === 'terminal' || firstInput
      ? { ok: true, admissionResult: { status: 'accepted', localId } }
      : { ok: true, result: { status: 'accepted', localId } });
    const acceptedRecord = accepted[0];
    if (!acceptedRecord) throw new Error('Input was not admitted');
    const admittedLocalId = acceptedLocalIds[0];
    if (!admittedLocalId) throw new Error('Missing admitted input identity');
    const request = acceptedRecord.meta?.happierInputRequestV1 === undefined ? undefined
      : SessionInputRequestV1Schema.parse(acceptedRecord.meta.happierInputRequestV1);
    // Encrypted host input uses Machine admission for UI as well as CLI;
    // that receipt cannot supply the sending person's Account by itself.
    const receipt: SessionInputAdmissionReceiptV1 = mode === 'plain'
      ? { v: 1, issuer: 'authenticatedAccount', actorAccountId: accountId, sessionRelationship: 'owner' }
      : { v: 1, issuer: 'authenticatedMachine' };
    const authority = request ? settleSessionInputRequestV1({ request, currentSessionPermissionCeiling: 'default', inputAdmissionReceipt: receipt }) : undefined;
    const crypto = mode === 'plain' ? { mode, ctx: null }
      : { mode, ctx: { encryptionKey: secret, encryptionVariant: 'legacy' as const } };
    const delivered: ReturnType<typeof UserMessageSchema.parse>[] = [];
    handleSessionNewMessageUpdate({ ...crypto, sessionId, serverId,
      update: { id: 'new-input', seq: 1, createdAt: 1, body: { t: 'new-message', delivery: 'full' as const, sid: sessionId, message: {
        id: 'committed-input', seq: 1, localId: admittedLocalId, messageRole: 'user', inputAdmissionReceipt: receipt,
        content: sealSessionStoredContent({ ...crypto, payload: { ...acceptedRecord,
          ...(authority ? { meta: withSessionInputAuthorityV1(acceptedRecord.meta, authority) } : {}) } }),
        createdAt: 1, updatedAt: 1,
      } } }, receivedMessageIds: new Set(), lastObservedMessageSeq: 0, lastObservedUserMessageSeq: 0,
      emit: (event, message) => { if (event === 'user-message') delivered.push(UserMessageSchema.parse(message)); },
      debug: () => {}, debugLargeJson: () => {},
    });
    expect(delivered).toHaveLength(1);
    const attribution = delivered[0]?.actionRequestAttributionV1;
    if (mode === 'plain' && request) expect(request).not.toHaveProperty('actionRequestAttributionV1');

    let stored: ApprovalRequest | null = null;
    let cardCount = 0;
    let effects = 0;
    const effectInput = getActionSpec(effect.actionId).inputSchema.parse(effect.input);
    // Replace only the authenticated Machine network hop, retaining the real
    // CLI adapters, captured-target admission and strict result consumers.
    vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async request => {
      expect(request.machineId).toBe(machineId);
      expect(request.method).toBe(getActionSpec(effect.actionId).bindings?.rpcMethod);
      effects++;
      return effect.output;
    });
    const machineDeps = createCliActionDeps({ token, credentials, sessionId, serverId, mode: 'plain', ctx: null });
    // The external Agent accepts the prompt; the actual native host owns its
    // copied admission witness and never exposes attribution to the Agent.
    const provider: AgentSessionRuntime = { async send() { return { status: 'admitted' }; },
      watch: () => ({ dispose() {} }), dispose() {} };
    const native = createNativeAgentSessionOperations(provider, sessionId, undefined, undefined, undefined, undefined, undefined,
      { context: {} as AgentSessionRuntimeContext, // This boundary Agent never calls SDK services.
        cwd: '/workspace', connectedAccounts: [], capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
        cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null } });
    onTestFinished(async () => { await native.resetOrDisposeRuntime(); });
    await native.sendTurnPrompt(delivered[0]!.content.text, { localId: admittedLocalId, turnId: 'admitted-turn',
      actionRequestAttributionV1: attribution,
      agentStartCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 } });
    const danger = createActionExecutor({
      machineStorageAction: machineDeps.machineStorageAction,
      machineProcessesAction: machineDeps.machineProcessesAction,
      machineGuardAction: machineDeps.machineGuardAction,
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
      resolveActiveTurnPermissionWitness: () => native.readActiveTurnAdmissionWitness?.(),
      executor: { execute: (id, input, toolContext) => danger.execute(id, input, { ...context, ...toolContext, actionsSettings: actionSettings }) },
    });
    const call = () => bridge.executeActionByToolName('action_execute', { actionId: effect.actionId,
      input: effectInput }, sessionId);
    const proposal = await call();
    expect(proposal, JSON.stringify(proposal)).toMatchObject({ ok: true,
      result: { kind: 'approval_request_created', artifactId: 'd22-card', actionId: effect.actionId } });
    expect(attribution).toMatchObject({ requestRef: admittedLocalId, requester: { serverId, accountId }, persona });
    expect(stored).toMatchObject({ executionOriginV1: { actionRequestAttributionV1: { requester: { accountId } } } });
    expect(cardCount).toBe(1);
    expect(effects).toBe(0);
    expect(await danger.execute('approval.request.decide', { artifactId: 'd22-card', decision: 'approve' },
      { surface: 'agent', authority: 'account_automation', runtimeAccountId: accountId, serverId }))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(effects).toBe(0);
    const approve = () => danger.execute('approval.request.decide', { artifactId: 'd22-card', decision: 'approve' },
      { surface: 'ui', authority: 'present_user', runtimeAccountId: accountId, serverId });
    const decision = await approve();
    expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true,
      result: { status: 'executed', execution: { ok: true, result: effect.output } } });
    expect(stored).toMatchObject({ status: 'executed', execution: { ok: true, result: effect.output } });
    await approve();
    expect(effects).toBe(1);
    expect(cardCount).toBe(1);
    actionSettings = ActionsSettingsV1Schema.parse({ v: 1,
      approvalWaivedSurfaces: { [effect.actionId]: [toolSurface] } });
    expect(await call()).toMatchObject({ ok: true, result: effect.output });
    expect(effects).toBe(2);
    expect(cardCount).toBe(1);
  });


  it.each(['ui', 'voice'] as const)('keeps causal permission authority for an existing %s Session send', async surface => {
    const { credentials, accept, accepted, acceptedLocalIds } = installHomeBoundary('e2ee');
    const deps = createCliActionDeps({ token, credentials, sessionId: 'cli-global', mode: 'e2ee', ctx: null, serverId,
      machineAdmissionTransport: async request => { accept(request.content, request.localId); return { status: 'accepted', localId: request.localId }; } });
    const result = await deps.sessionSendMessage({ sessionId, localId, message: 'Existing Session authority', requestedAction: { v: 1, kind: 'enqueue' },
      context: { surface, callerSurface: surface, authority: 'present_user', callerPermissionMode: 'default', serverId,
        runtimeAccountId: accountId, actionCaller: { kind: 'host' } }, callerSurface: surface, actionCaller: { kind: 'host' } });
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'accepted', localId });
    expect(accepted.length, JSON.stringify({ result, accepted: accepted.length, acceptedLocalIds: acceptedLocalIds })).toBe(1);
    expect(accepted[0], JSON.stringify(accepted[0])).toBeDefined();
    const request = SessionInputRequestV1Schema.parse(accepted[0]?.meta?.happierInputRequestV1);
    expect(request.actionRequestAttributionV1).toMatchObject({ requestRef: localId,
      requester: { accountId, serverId }, persona, origin: null });
    expect(request.producer).toBe(surface === 'ui' ? 'happierApp' : 'voiceInput');
    expect(request.permission).toEqual({});
  });

  it.each((['e2ee', 'plain'] as const).flatMap(mode => (['cli', 'ui', 'voice'] as const).map(surface => ({ mode, surface }))))('attributes an admitted shared Machine $surface $mode send to its authenticated Account rather than the custodian', async ({ mode, surface }) => {
    const { credentials, accept, accepted } = installHomeBoundary(mode);
    expect(await sendSessionMessage({ credentials, idOrPrefix: sessionId, localId, expectedSessionAddress: persona,
      message: 'A shared Machine is not the sending person', wait: false, timeoutMs: 30_000,
      inputAdmission: buildTrustedHostSessionInputAdmissionV1(surface), callerInputAuthorization: {
        ...accountAuthorization, binding: { ...accountAuthorization.binding, accountEncryptionMode: mode },
      },
      machineAdmissionTransport: async request => { accept(request.content, request.localId); return { status: 'accepted', localId: request.localId }; },
    })).toMatchObject({ ok: true });
    expect(accepted[0]).toMatchObject({ meta: { happierInputRequestV1: { actionRequestAttributionV1: {
      requester: { serverId, accountId },
    } } } });
  });

  it.each([
    ...(['cli', 'ui', 'voice', 'rpc'] as const).map(surface => ({ surface, apiToken: true })),
    { surface: 'rpc' as const, apiToken: false },
  ])('does not promote an unattended $surface Account into an original human requester (API token: $apiToken)', async ({ surface, apiToken }) => {
    const { credentials, accept, accepted } = installHomeBoundary('e2ee');
    const { authentication: _authentication, ...binding } = accountAuthorization.binding;
    expect(await sendSessionMessage({ credentials, idOrPrefix: sessionId, localId, expectedSessionAddress: persona,
      message: 'Unattended input', wait: false, timeoutMs: 30_000,
      inputAdmission: buildSessionSpawnInitialInputAdmissionForLocalIdV1({ actionCaller: { kind: 'host' },
        callerSurface: surface, callerAuthority: apiToken ? 'present_user' : 'account_automation', localId }).inputAdmission,
      executionAuthority: apiToken ? 'present_user' : 'account_automation',
      ...(apiToken ? { callerInputAuthorization: {
        ...accountAuthorization, binding: { ...binding, principalId: 'api-principal', credentialId: 'api-credential',
          grant: API_TOKEN_FULL_GRANT_V1 },
      } } : {}),
      machineAdmissionTransport: async request => { accept(request.content, request.localId); return { status: 'accepted', localId: request.localId }; },
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

  it.each((['requester', 'request', 'persona', 'credential', 'foreign-machine'] as const)
    .flatMap(mismatch => (['cli', 'ui'] as const).map(surface => ({ mismatch, surface }))))('refuses a mismatched $mismatch on $surface before admitting input', async ({ mismatch, surface }) => {
    const { credentials, accept, accepted } = installHomeBoundary('e2ee');
    const admission = buildTrustedHostSessionInputAdmissionV1(surface);
    const cause = { requestRef: mismatch === 'request' ? 'forged-input' : localId,
      requester: { serverId, accountId: mismatch === 'requester' ? 'machine-owner' : accountId },
      persona: mismatch === 'persona' ? { serverId, sessionId: 'foreign-session' } : persona, origin: null };
    const result = await sendSessionMessage({ credentials, idOrPrefix: sessionId, localId,
      expectedSessionAddress: persona, message: 'Untrusted attribution', wait: false, timeoutMs: 30_000,
      inputAdmission: { ...admission, request: { ...admission.request, actionRequestAttributionV1: cause } },
      ...(mismatch === 'credential' ? { callerInputAuthorization: { ...accountAuthorization,
        binding: { ...accountAuthorization.binding, accountId: 'another-account' } } } : {}),
      ...(mismatch === 'foreign-machine' ? { targetMachineId: 'another-accounts-machine' } : {}),
      machineAdmissionTransport: async request => { accept(request.content, request.localId); return { status: 'accepted', localId: request.localId }; },
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
