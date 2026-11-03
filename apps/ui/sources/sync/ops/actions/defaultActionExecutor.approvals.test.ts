import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import {
    API_TOKEN_FULL_GRANT_V1, ApprovalRequestSchema, ARTIFACT_PLAIN_DATA_KEY_MARKER, DEFAULT_SESSION_CAPABILITIES,
    MACHINE_PLAIN_DATA_KEY_MARKER, buildApprovalRequestArtifactHeaderV1, encodePlainArtifactStoredContent,
    type AccountApiTokenSummaryV1, type ApprovalRequest,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { PENDING_INPUT_PROTOCOL_VERSION_V4 } from '@happier-dev/protocol/clientCompatibility/primitives';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import tweetnacl from 'tweetnacl';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import type { ExternalActionExecutionAuthorizationV1, ExternalActionRequestEnvelopeV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { answerDiscussionThreadForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { ArtifactActionOutputSchemasV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { deriveDocCommentDiscussionCreationLocalIdV1, DocEditAcceptTransportInputV1Schema,
    DOC_EDIT_PROPOSAL_HTTP_PATHS_V1 } from '@happier-dev/protocol/artifacts/artifactCollaborationActionsV1';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { DiscussionDocEditProposalContentV1Schema } from '@happier-dev/protocol/discussions/content';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
import { getActionSpec, type ActionExecutorContext } from '@happier-dev/protocol/actions';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema,
    ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { createPluginInstallationReviewFixture } from '@happier-dev/protocol/testing/pluginInstallationReviewFixture';
import { PluginUiTargetedContributionsV1Schema } from '@happier-dev/protocol/plugins/ui';
import { buildWidgetSurfaceArtifactIdV1 } from '@happier-dev/protocol/widgets/widgetSurfaceArtifactV1';
import { TargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { buildTargetActionApprovalArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';

// Only HTTP, device credentials and Socket.IO network acknowledgements are replaced.
// Home/Account policy, Sync, scoped RPC, the Artifact codec and versioned CAS remain real.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { Modal } = await import('@/modal');
const outgoing: SocketRpcRequestPayload[] = [];
let rpcResult: unknown = { ok: true };
let rpcAcknowledgement: unknown;
let decisionReceiver: ((input: unknown) => Promise<unknown>) | null = null;
installDisconnectedServerSocketBoundary((socket) => {
    configureConnectedServerSocketBoundary(socket);
    vi.spyOn(socket, 'timeout').mockReturnValue(socket);
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event: string, payload: SocketRpcRequestPayload) => {
        // Sync also acknowledges subscriptions; only RPC envelopes are Action effects.
        if (event === SOCKET_RPC_EVENTS.CALL) outgoing.push(payload);
        if (event === SOCKET_RPC_EVENTS.CALL && rpcAcknowledgement !== undefined) return rpcAcknowledgement;
        return { ok: true, result: decisionReceiver && payload.method.endsWith(':' + RPC_METHODS.APPROVAL_REQUEST_DECIDE)
            ? await decisionReceiver(payload.params) : rpcResult };
    });
});
const apiTokenSummary = {
    tokenId: 'dd03e74b-4aae-4a0a-81ee-1c23ddc4525d', label: 'CI deploy', displayPrefix: 'hap_v1_dd03e74b',
    createdAt: '2026-08-22T12:00:00.000Z', lastUsedAt: null, expiresAt: '2026-11-20T12:00:00.000Z',
    hasEncryptionAccess: false, hasUnattendedTeamAccess: false, grant: API_TOKEN_FULL_GRANT_V1,
    parentTokenId: null, activeChildCount: 0, embedConfig: null,
} satisfies AccountApiTokenSummaryV1;
const token = 'hap_v1_' + apiTokenSummary.tokenId + '_' + 'A'.repeat(43);
type Executor = ReturnType<typeof import('./defaultActionExecutor').createDefaultActionExecutor>;
type StoreState = ReturnType<ReturnType<typeof import('@/sync/domains/state/storage').getStorage>['getState']>;
let initialState: StoreState;
let executor: Executor;
let homeId: string;
let webLocks: ReturnType<typeof installWebLockManagerMock>;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
const context = () => ({ surface: 'ui' as const, serverId: homeId });
const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(29));

async function connectPermissionTransport(): Promise<void> {
    const { apiSocket } = await import('@/sync/api/session/apiSocket');
    await new Promise<void>((resolve) => {
        const unsubscribe = apiSocket.onStatusChange(status => {
            if (status === 'connected') {
                queueMicrotask(() => { unsubscribe(); resolve(); });
            }
        });
    });
}

async function invitationApproval(actionId: 'teams.invitations.create' | 'teams.invitations.reissue' | 'account.name.set' | 'ui.voice_global.get' | 'memory.remember', signed = true, publicProposal = false,
    carrierActionId?: ExternalActionExecutionAuthorizationV1['binding']['actionId'], reviewedInput?: ExternalActionRequestEnvelopeV1['input']) {
    const input: ExternalActionRequestEnvelopeV1['input'] = reviewedInput ?? (actionId === 'ui.voice_global.get' ? {} : actionId === 'account.name.set' ? { name: 'Captain' } : actionId === 'teams.invitations.create'
        ? { v: 1, teamId: 'team-a', role: 'member', historyAccess: 'from_membership', recipientEmail: null, requestKey: 'create-request' }
        : { v: 1, teamId: 'team-a', invitationId: 'old-invitation', recipientEmail: null, requestKey: 'reissue-request' });
    const caller = { kind: 'session' as const, sessionId: 's1', starterDepth: 0, turnDepth: 0 };
    const target = { kind: 'machine' as const, machineId: 'machine-exact' };
    const requestId = `proposal-${actionId}`;
    const proposalInput = { actionId, actionArgs: input, summary: 'Set my name', createdBy: { surface: 'agent' } };
    const authorization: ExternalActionExecutionAuthorizationV1 = {
        v: 1, token: 'signed-proposal-fixture', binding: {
            serverIdentityId: 'srv_approval_home', accountId: 'account-a',
            authentication: { kind: 'account', tokenEpoch: 0 },
            machineId: target.machineId, custodianAccountId: 'account-a', installationId: 'installation-1',
            actionId: carrierActionId ?? (publicProposal ? 'approval.request.create' : actionId), requestId, target,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId, target,
                input: publicProposal ? proposalInput : input }),
            sessionActionOrigin: { v: 1, caller, sourceTurnId: 'turn-1', callerPermissionMode: null, requestId },
            sessionActionSource: { machineId: target.machineId, installationId: 'installation-1' },
        },
    };
    const { createPlainMachineRowFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    const machineRow = { ...createPlainMachineRowFixture({ id: target.machineId, accountId: 'account-a' }),
        installationId: 'installation-1', installationPublicKey: encodeBase64(installation.publicKey, 'base64'),
        revokedAt: null, replacedByMachineId: null, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER };
    homes.answer(homeId, '/v1/machines', { body: [machineRow] });
    // The original Account Machine is read by id (a532f4a1e0): it is the same Home row, installation identity included.
    homes.answer(homeId, '/v1/machines/machine-exact', { body: { machine: { ...machineRow, kind: 'persistent' } } });
    if (!signed) {
        // Retained host-CLI approvals remain replayable; current CLI admission
        // does not grant automation permission to create a fresh invitation proposal.
        const artifactId = `retained-${requestId}`;
        await seedApproval(artifactId, ApprovalRequestSchema.parse({
            v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'cli' }, requestedSurface: 'cli',
            approval: { flow: 'deferred', result: 'required' },
            executionOriginV1: {
                v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
                serverId: 'creator-cli-profile', serverIdentityId: 'srv_approval_home', accountId: 'account-a',
                machineId: target.machineId, actionId, requestId,
            },
            actionId, actionArgs: input, summary: 'Retained Account proposal',
        }));
        return { artifactId, input, proposed: { ok: true, result: { kind: 'approval_request_created', artifactId } } };
    }
    const proposed = await executor.execute(publicProposal ? 'approval.request.create' : actionId,
        publicProposal ? proposalInput : input, {
        surface: 'agent', authority: 'account_automation', serverId: homeId,
        actionCaller: caller, actionRequestId: requestId,
            ...(!publicProposal ? { defaultSessionId: 's1' } : {}), defaultSessionMachineId: target.machineId, callerPermissionMode: null,
            sessionInputSource: { sourceSessionId: 's1', sourceTurnId: 'turn-1', via: 'action' as const },
            externalActionTarget: target, externalActionExecutionAuthorization: authorization,
            signExternalActionApprovalInput: (args: Parameters<NonNullable<import('@happier-dev/protocol/actions/executor/types').ActionExecutorContext['signExternalActionApprovalInput']>>[0]) =>
                signExternalActionApprovalInputV1({ authorizationToken: args.authorization.token,
                    actionId: args.actionId, input: args.input, target: args.target, privateKey: installation.secretKey }),
    });
    expect(proposed, proposed.ok ? undefined : proposed.errorCode).toMatchObject({ ok: true,
        result: publicProposal ? { artifactId: expect.any(String) } : { kind: 'approval_request_created' } });
    if (!proposed.ok || !proposed.result || typeof proposed.result !== 'object'
        || !('artifactId' in proposed.result) || typeof proposed.result.artifactId !== 'string') throw new Error('expected_approval');
    return { artifactId: proposed.result.artifactId, input, proposed };
}

function approvalRequest(actionId: 'session.title.set' | 'session.stop' = 'session.title.set'): ApprovalRequest {
    return ApprovalRequestSchema.parse({
        v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'mcp', sessionId: 's1' }, requestedSurface: 'mcp',
        executionOriginV1: {
            v: 1, authority: 'account_automation', surface: 'mcp', caller: { kind: 'host' },
            serverId: homeId, sessionId: 's1', target: { kind: 'session', sessionId: 's1' },
            actionId, requestId: 'request-' + actionId,
        },
        actionId, actionArgs: actionId === 'session.stop' ? { sessionId: 's1' } : { sessionId: 's1', title: 'Renamed from approval' },
        summary: actionId === 'session.stop' ? 'Stop session' : 'Set session title',
    });
}
async function seedApproval(id: string, request: ApprovalRequest): Promise<void> {
    const response = await homes.artifacts(homeId).handle('/v1/artifacts', {
        method: 'POST', body: JSON.stringify({
            id, header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(request)),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        }),
    });
    expect(response?.ok).toBe(true);
}
function persistedApproval(id: string): ApprovalRequest {
    return ApprovalRequestSchema.parse(JSON.parse(homes.artifacts(homeId).readPlainBody(id) ?? 'null'));
}
async function setVoiceApprovalDelegation(enabled: boolean): Promise<void> {
    const { storage } = await import('@/sync/domains/state/storage');
    const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    const current = storage.getState().settings;
    const settings = settingsParse({ ...current, ...normalizeVoiceSettingsLocalDelta({
        voice: { ...current.voice, canApproveRequests: enabled },
    }, current) });
    storage.setState({ settings });
    homes.answer(homeId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
    expect(storage.getState().settings.voice.canApproveRequests).toBe(enabled);
}
function expectFailedApproval(id: string, errorCode = 'approval_stale'): void {
    expect(persistedApproval(id)).toMatchObject({
        status: 'failed', decision: { kind: 'approve' }, execution: { ok: false, errorCode },
    });
    expect(outgoing).toEqual([]);
    // Tuple mutations PATCH the Session row; metadata-upgrades is a legitimate
    // background GET. Legacy Socket metadata writes are covered by outgoing.
    expect(homes.requests.filter(({ path, input }) => path === '/v2/sessions/s1' && input !== null)).toEqual([]);
}

// Load the real owners after boundary installation, outside timed per-test hooks.
await import('@/sync/syncEngine');
await import('./defaultActionExecutor');

describe('createDefaultActionExecutor approvals', () => {
    it.each([
        ['approve', 1], ['reject', 1], ['approve', 2], ['reject', 2],
    ] as const)('revokes a suspended Voice %s before settlement at approval read %s', async (decision, heldRead) => {
        const { artifactId } = await invitationApproval('account.name.set', false);
        homes.answer(homeId, '/v1/account/profile', { body: { name: 'Captain', firstName: 'Captain', lastName: null, timestamp: 10 } });
        let reached!: () => void;
        let release!: () => void;
        const readReached = new Promise<void>(resolve => { reached = resolve; });
        const readRelease = new Promise<void>(resolve => { release = resolve; });
        const path = '/v1/artifacts/' + artifactId;
        let reads = 0;
        homes.answer(homeId, 'GET ' + path, { select: async () => {
            if (++reads === heldRead) { reached(); await readRelease; }
            const response = await homes.artifacts(homeId).handle(path, { method: 'GET' });
            if (!response) throw new Error('Missing approval boundary response');
            return { body: await response.json() };
        } });
        const pending = executor.execute('approval.request.decide', { artifactId, decision }, { surface: 'voice', serverId: homeId });
        try {
            await Promise.race([readReached, pending.then(result => { throw new Error('No held read: ' + JSON.stringify(result)); })]);
            await setVoiceApprovalDelegation(false);
        } finally { release(); }
        expect(await pending).toMatchObject({ ok: false, errorCode: 'present_user_required' });
        expect(persistedApproval(artifactId).status).toBe('open');
        expect(homes.requestsFor(path).filter(request => request.input !== null)).toEqual([]);
        expect(homes.requestsFor('/v1/account/profile').filter(request => request.input !== null)).toEqual([]);
    });

    it('revokes Voice cancellation of approved unclaimed work before its fresh CAS write', async () => {
        const artifactId = 'voice-approved-cancel';
        const approved = ApprovalRequestSchema.parse({ ...approvalRequest(), status: 'approved', updatedAtMs: 2,
            decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user', decidingAccountId: 'account-a' } });
        await seedApproval(artifactId, approved);
        let reached!: () => void;
        let release!: () => void;
        const readReached = new Promise<void>(resolve => { reached = resolve; });
        const readRelease = new Promise<void>(resolve => { release = resolve; });
        const path = '/v1/artifacts/' + artifactId;
        let reads = 0;
        homes.answer(homeId, 'GET ' + path, { select: async () => {
            if (++reads === 2) { reached(); await readRelease; }
            const response = await homes.artifacts(homeId).handle(path, { method: 'GET' });
            if (!response) throw new Error('Missing approval boundary response');
            return { body: await response.json() };
        } });
        const pending = executor.execute('approval.request.decide', { artifactId, decision: 'cancel' }, { surface: 'voice', serverId: homeId });
        try {
            await Promise.race([readReached, pending.then(result => {
                throw new Error('No held cancellation CAS read: ' + JSON.stringify(result));
            })]);
            await setVoiceApprovalDelegation(false);
            release();
            const result = await pending;
            const { storage } = await import('@/sync/domains/state/storage');
            expect(storage.getState().settings.voice.canApproveRequests).toBe(false);
            expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'present_user_required' });
            expect(persistedApproval(artifactId)).toEqual(approved);
            expect(homes.requestsFor(path).filter(request => request.input !== null)).toEqual([]);
            expect(outgoing).toEqual([]);
        } finally {
            release();
            await pending;
        }
    });

    it.each(['approve', 'reject'] as const)('revokes a prepared Voice %s before running its decision', async decision => {
        const { artifactId } = await invitationApproval('account.name.set', false);
        const prepared = await executor.prepare('approval.request.decide', { artifactId, decision }, { surface: 'voice', serverId: homeId });
        expect(prepared.kind).toBe('ready');
        if (prepared.kind !== 'ready') throw new Error('Expected an admitted decision');
        await setVoiceApprovalDelegation(false);
        expect(await prepared.invocation.run()).toMatchObject({ ok: false, errorCode: 'present_user_required' });
        expect(persistedApproval(artifactId).status).toBe('open');
    });

    it('retains a Voice approval receipt when delegation is revoked after its effect was issued', async () => {
        const { artifactId } = await invitationApproval('account.name.set', false);
        let issued!: () => void;
        let release!: () => void;
        const effectIssued = new Promise<void>(resolve => { issued = resolve; });
        const effectReply = new Promise<void>(resolve => { release = resolve; });
        homes.answer(homeId, 'POST /v1/account/profile', { select: async () => {
            issued(); await effectReply;
            return { body: { name: 'Captain', firstName: 'Captain', lastName: null, timestamp: 10 } };
        } });
        const pending = executor.execute('approval.request.decide', { artifactId, decision: 'approve' }, { surface: 'voice', serverId: homeId });
        try {
            await Promise.race([effectIssued, pending.then(result => { throw new Error('Effect was not issued: ' + JSON.stringify(result)); })]);
            expect(persistedApproval(artifactId)).toMatchObject({ decision: { kind: 'approve' } });
            await setVoiceApprovalDelegation(false);
        } finally { release(); }
        expect(await pending).toMatchObject({ ok: true, result: { status: 'executed' } });
        expect(persistedApproval(artifactId)).toMatchObject({ status: 'executed', decision: { kind: 'approve' } });
        expect(homes.requestsFor('/v1/account/profile').filter(request => request.input !== null)).toHaveLength(1);
    });

    it.each(['approve', 'reject'] as const)('lets the Voice agent %s an existing request once by default', async decision => {
        const { artifactId } = await invitationApproval('account.name.set', false);
        homes.answer(homeId, '/v1/account/profile', { body: { name: 'Captain', firstName: 'Captain', lastName: null, timestamp: 10 } });
        const voiceContext = { surface: 'voice' as const, serverId: homeId };
        const first = await executor.execute('approval.request.decide', { artifactId, decision }, voiceContext);
        expect(first).toMatchObject({ ok: true });
        expect(persistedApproval(artifactId)).toMatchObject({
            status: decision === 'approve' ? 'executed' : 'rejected',
            decision: { kind: decision, decidingAccountId: 'account-a' },
        });
        expect(await executor.execute('approval.request.decide', { artifactId, decision }, voiceContext)).toMatchObject({ ok: true });
        expect(homes.requestsFor('/v1/account/profile').filter(request => request.input !== null))
            .toHaveLength(decision === 'approve' ? 1 : 0);
    });

    it.each(['voice', 'agent', 'mcp'] as const)('retains the decision floor for %s when Voice delegation is off', async surface => {
        const { storage } = await import('@/sync/domains/state/storage');
        const current = storage.getState();
        storage.setState({ settings: { ...current.settings,
            voice: { ...current.settings.voice, canApproveRequests: false } } });
        const request = { artifactId: 'artifact-1', decision: 'reject' as const };
        const result = await executor.execute('approval.request.decide', request, { surface, serverId: homeId,
            authority: 'present_user', actionCaller: { kind: 'host' } });
        expect(result).toMatchObject({ ok: false, errorCode: 'present_user_required' });
        expect(persistedApproval('artifact-1').status).toBe('open');
        expect(outgoing).toEqual([]);
    });

    it.each(['agent', 'mcp'] as const)('does not delegate decisions to %s even with Voice enabled', async surface => {
        expect(await executor.execute('approval.request.decide', { artifactId: 'artifact-1', decision: 'reject' }, {
            surface, serverId: homeId, authority: 'present_user', actionCaller: { kind: 'host' },
        })).toMatchObject({ ok: false, errorCode: 'present_user_required' });
        expect(persistedApproval('artifact-1').status).toBe('open');
    });

    it('acquires an ordinary built-in once for initial family routing, retaining the fresh CAS read', async () => {
        const result = await executor.execute('approval.request.decide', { artifactId: 'artifact-1', decision: 'reject' }, context());
        expect(result, JSON.stringify({ result, paths: homes.requests.map(request => request.path) }))
            .toMatchObject({ ok: true, result: { status: 'rejected' } });
        const requests = homes.requestsFor('/v1/artifacts/artifact-1');
        const firstWrite = requests.findIndex(request => request.input !== null);
        expect(firstWrite).toBeGreaterThan(0);
        // One initial classification acquisition plus the writer's fresh revision basis.
        expect(requests.slice(0, firstWrite).filter(request => request.input === null)).toHaveLength(2);
        expect(persistedApproval('artifact-1')).toMatchObject({ status: 'rejected' });
        expect(outgoing).toEqual([]);
    });

    it('rejects a malformed approval family after one initial acquisition without effects', async () => {
        const artifact = homes.artifacts(homeId).read('artifact-1');
        if (!artifact) throw new Error('Missing approval fixture');
        homes.artifacts(homeId).replaceStoredRow({ ...artifact,
            body: encodePlainArtifactStoredContent({ body: JSON.stringify({ ...approvalRequest(), v: 99 }) }),
        });
        const result = await executor.execute('approval.request.decide', { artifactId: 'artifact-1', decision: 'approve' }, context());
        expect(result, JSON.stringify({ result, paths: homes.requests.map(request => request.path) }))
            .toMatchObject({ ok: false, errorCode: 'approval_not_found' });
        expect(homes.requestsFor('/v1/artifacts/artifact-1')).toHaveLength(1);
        expect(outgoing).toEqual([]);
    });

    it('does not accept a caller-authored initial approval body', async () => {
        expect(await executor.execute('approval.request.decide', {
            artifactId: 'artifact-missing', decision: 'approve', initialRead: { request: approvalRequest() },
        }, context())).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(homes.requestsFor('/v1/artifacts/artifact-missing')).toEqual([]);
        expect(outgoing).toEqual([]);
    });

    it.each([false, true])('rechecks Account custody after a held execution claim (retired: %s)', async retired => {
        const { artifactId } = await invitationApproval('account.name.set', false);
        homes.answer(homeId, '/v1/account/profile', { body: { name: 'Captain', firstName: 'Captain', lastName: null, timestamp: 10 } });
        let claimReached!: () => void;
        let releaseClaim!: () => void;
        const reached = new Promise<void>(resolve => { claimReached = resolve; });
        const release = new Promise<void>(resolve => { releaseClaim = resolve; });
        const artifacts = homes.artifacts(homeId);
        artifacts.beforeNextUpdate(async () => {
            // Consent commits first; hold the subsequent execution claim at the HTTP boundary.
            artifacts.beforeNextUpdate(async () => { claimReached(); await release; });
        });
        const pending = executor.execute('approval.request.decide', { artifactId, decision: 'approve' }, context());
        try {
            await Promise.race([reached, pending.then(result => { throw new Error(`Claim not reached: ${JSON.stringify(result)}`); })]);
            if (retired) {
                const { TokenStorage } = await import('@/auth/storage/tokenStorage');
                const profile = (await import('@/sync/domains/server/serverProfiles')).getServerProfileById(homeId);
                if (!profile) throw new Error('Expected original Home fixture');
                await TokenStorage.removeCredentialsForServerUrl(profile.serverUrl, { serverId: homeId });
            }
        } finally { releaseClaim(); }
        await pending;
        expect(homes.requestsFor('/v1/account/profile').filter(request => request.input !== null)).toHaveLength(retired ? 0 : 1);
        expect(outgoing).toEqual([]);
        if (retired) expect(persistedApproval(artifactId).status).not.toBe('executed');
        else expect(persistedApproval(artifactId)).toMatchObject({ status: 'executed', execution: { ok: true } });
    });

    it.each(['approve', 'reject'] as const)('records a public %s decision for a live Account Action without a Machine', async decision => {
        const artifactId = `account-target-${decision}`;
        const request = TargetActionApprovalRequestV1Schema.parse({
            v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'cli' }, requestedSurface: 'cli',
            qualifiedActionId: 'acme.account-actions/actions/write', input: { key: 'personal', value: 'reviewed' },
            secretInputPaths: [], approvalInputCustody: 'live_only',
            sourceCustody: { kind: 'account_release', pluginId: 'acme.account-actions', version: '1.0.0',
                archiveDigestSha256: `sha256:${'a'.repeat(64)}` },
            policyFingerprint: 'b'.repeat(64), subjectFingerprint: 'c'.repeat(64), summary: 'Write personal value',
        });
        const seeded = await homes.artifacts(homeId).handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({
            id: artifactId, header: encodePlainArtifactStoredContent(buildTargetActionApprovalArtifactHeaderV1(request)),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        }) });
        expect(seeded?.ok).toBe(true);
        const result = await executor.execute('approval.request.decide', { artifactId, decision }, context());
        expect(result, JSON.stringify({ result, paths: homes.requests.map(request => request.path) }))
            .toMatchObject({ ok: true, result: { status: decision === 'approve' ? 'approved' : 'rejected' } });
        expect(TargetActionApprovalRequestV1Schema.parse(JSON.parse(homes.artifacts(homeId).readPlainBody(artifactId) ?? 'null')))
            .toMatchObject({ status: decision === 'approve' ? 'approved' : 'rejected', decision: { kind: decision } });
        const requests = homes.requestsFor(`/v1/artifacts/${artifactId}`);
        const firstWrite = requests.findIndex(request => request.input !== null);
        expect(firstWrite).toBeGreaterThan(0);
        expect(requests.slice(0, firstWrite).filter(request => request.input === null)).toHaveLength(2);
        if (decision === 'approve') {
            // Consent readback is a later phase and must not reuse the open initial body.
            expect(requests.slice(firstWrite + 1).filter(request => request.input === null).length).toBeGreaterThan(0);
        }
        expect(outgoing).toEqual([]);
    });

    it.each(['origin_profile', 'portable_home', 'independent_device'] as const)('executes unsigned deferred CLI Doc comments and proposals in the approving app without a daemon replay (%s)', async decidingProfile => {
        expect(homeId).not.toBe(connection.serverId);
        expect(connection.serverId).toBe('srv_approval_home');
        const originServerId = decidingProfile === 'independent_device' ? 'creator-cli-only-profile' : homeId;
        if (decidingProfile === 'independent_device') {
            const { getServerProfileById, resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
            expect(getServerProfileById(originServerId)).toBeNull();
            expect(resolveServerProfileScopeIdForIdentifier(originServerId)).toBe(originServerId);
        }
        const created = await executor.execute('artifact.create', { header: { kind: 'markdown', title: 'Reviewed Doc' }, body: 'Review this passage.' }, context());
        expect(created).toMatchObject({ ok: true });
        if (!created.ok) throw new Error('Expected source Artifact');
        const doc = ArtifactActionOutputSchemasV1['artifact.create'].parse(created.result);
        const target = { ref: { kind: 'doc' as const, artifactId: doc.artifactId, serverId: originServerId }, revision: doc.revision,
            range: { start: 0, end: 19 }, quote: 'Review this passage' };
        const network = answerDiscussionThreadForTests(homes, homeId, { accountId: 'account-a', loseCreate: false, loseFirstRejoin: false });
        const requests = [
            { actionId: 'doc.comment.reply', actionArgs: { target, localId: 'cli-comment',
                content: { v: 1, parts: [{ t: 'text', text: 'Please clarify' }] } } },
            { actionId: 'doc.edit.propose', actionArgs: { target, localId: 'cli-proposal',
                discussionRef: { serverId: originServerId, discussionId: 'committed-thread' }, baseRevision: doc.revision,
                before: target.quote, after: 'Review the exact passage', reason: 'Clarify the basis' } },
        ] as const;
        for (const { actionId, actionArgs } of requests) {
            const artifactId = `unsigned-cli-${actionId}`;
            await seedApproval(artifactId, ApprovalRequestSchema.parse({
                v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
                createdBy: { surface: 'cli' }, requestedSurface: 'cli', approval: { flow: 'deferred', result: 'optional' },
                executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
                    serverId: originServerId, serverIdentityId: 'srv_approval_home', accountId: 'account-a',
                    machineId: 'recorded-cli-machine', target: { kind: 'machine', machineId: 'recorded-cli-machine' },
                    actionId, requestId: `request-${actionId}` },
                actionId, actionArgs, summary: 'Reviewed CLI Doc write',
            }));
            const decided = await executor.execute('approval.request.decide', { artifactId, decision: 'approve' }, {
                surface: 'ui', serverId: decidingProfile === 'origin_profile' ? homeId : connection.serverId,
            });
            expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
            expect(persistedApproval(artifactId)).toMatchObject({ status: 'executed', execution: { ok: true,
                result: { message: { localId: actionArgs.localId, messageRef: { discussion: {
                    serverId: connection.serverId, discussionId: 'committed-thread',
                } } } } } });
        }
        expect(network.stored()?.discussion.creationLocalId).toBe(deriveDocCommentDiscussionCreationLocalIdV1({
            ref: target.ref, localId: 'cli-comment',
        }));
        expect(network.messages.map(message => message.localId)).toEqual(['cli-comment', 'cli-proposal']);
        if (decidingProfile === 'independent_device') {
            const committed = network.messages[1]!;
            if (committed.content.t !== 'plain') throw new Error('Expected the plain codec fixture');
            expect(DiscussionDocEditProposalContentV1Schema.parse(committed.content.v).proposal.target.ref.serverId).toBe(originServerId);
            const proposalRef = { kind: 'discussion' as const, discussion: {
                serverId: connection.serverId, discussionId: committed.discussionId,
            }, messageId: committed.id };
            const disposition = { state: 'accepted', acceptedRevision: { ...doc.revision, bodyVersion: doc.revision.bodyVersion + 1 },
                decidedBy: { accountId: 'account-a', atMs: 3 } } as const;
            homes.answer(homeId, `POST ${DOC_EDIT_PROPOSAL_HTTP_PATHS_V1.accept}`, { select: input => {
                const packet = DocEditAcceptTransportInputV1Schema.parse(input);
                expect(packet).toMatchObject({ proposalRef, expectedRevision: doc.revision });
                expect(packet.preparation?.doc.ref).toEqual({ kind: 'doc', artifactId: doc.artifactId, serverId: connection.serverId });
                expect(decodePlainArtifactStoredContent(packet.preparation!.body)).toEqual({ body: 'Review the exact passage.' });
                return { body: { proposalRef, docEditProposalDispositionV1: disposition } };
            } });
            // The person opens the committed C3 proposal; no creator-local profile exists on this device.
            const accepted = await executor.execute('doc.edit.accept', { proposalRef, expectedRevision: doc.revision }, {
                surface: 'ui', serverId: connection.serverId,
            });
            expect(accepted, JSON.stringify(accepted)).toMatchObject({ ok: true, result: { proposalRef, docEditProposalDispositionV1: disposition } });
            expect(homes.requestsFor(DOC_EDIT_PROPOSAL_HTTP_PATHS_V1.accept)).toHaveLength(1);
            const parentReply = await executor.execute('doc.comment.reply', {
                target: { ...target, ref: { ...target.ref, serverId: connection.serverId } },
                parentMessageRef: { kind: 'discussion', discussion: proposalRef.discussion, messageId: network.messages[0]!.id },
                localId: 'ui-parent-reply', content: { v: 1, parts: [{ t: 'text', text: 'Reply on the original passage' }] },
            }, { surface: 'ui', serverId: connection.serverId });
            expect(parentReply, JSON.stringify(parentReply)).toMatchObject({ ok: true, result: { message: {
                localId: 'ui-parent-reply', replyTarget: { kind: 'message', messageId: network.messages[0]!.id },
                content: { v: 1, parts: [{ t: 'text', text: 'Reply on the original passage' }] },
            } } });
            expect(await executor.execute('doc.comment.reply', { target: { ...target,
                ref: { ...target.ref, serverId: 'unbound-other-device-profile' } }, localId: 'unbound-comment',
                content: { v: 1, parts: [{ t: 'text', text: 'Must not publish' }] } }, {
                surface: 'ui', serverId: connection.serverId,
            })).toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
            expect(network.messages.map(message => message.localId)).toEqual(['cli-comment', 'cli-proposal', 'ui-parent-reply']);
        }
        expect(outgoing).toEqual([]);
        expect(homes.requestsFor('/v1/actions/approval.request.decide')).toEqual([]);
    });
    it.each(['current', 'replaced', 'unavailable', 'detached'] as const)('W04 returns a mounted widget-area approval to its live app waiter (%s)', async source => {
        const { getSharedBlockingApprovalCoordinator } = await import('@happier-dev/protocol/actions/blockingApprovalCoordinator');
        const { createPlainMachineRowFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const coordinator = getSharedBlockingApprovalCoordinator();
        const artifactId = 'w04-mounted-area';
        const machineId = 'machine-exact';
        const surface = { serverId: homeId, accountId: 'account-a', owner: {
            kind: 'pluginArea' as const, pluginId: 'external.widgets', pageId: 'overview', area: 'pinned' } };
        const request = ApprovalRequestSchema.parse({
            v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'system', pluginId: 'external.widgets', contributionLocalId: 'overview' },
            requestedSurface: 'plugin', approval: { flow: 'blocking', result: 'required' },
            executionOriginV1: { v: 1, authority: 'account_automation', surface: 'plugin',
                caller: { kind: 'plugin', pluginId: 'external.widgets', contributionLocalId: 'overview',
                    sourceCustody: { kind: 'development', registeredRootId: '/external/widgets' } },
                serverId: homeId, serverIdentityId: 'srv_approval_home', accountId: 'account-a',
                machineId, actionId: 'widgets.item.add', requestId: 'w04-add' },
            actionId: 'widgets.item.add', summary: 'Add followed widget', actionArgs: {
                surface,
                instance: { v: 1, id: 'followed', definition: { kind: 'builtin', id: 'session_summary' },
                    bindings: { session: { kind: 'context', slot: 'session' } } },
            },
        });
        await seedApproval(artifactId, request);
        const machine = { ...createPlainMachineRowFixture({ id: machineId, accountId: 'account-a' }),
            installationId: 'installation-1', installationPublicKey: encodeBase64(installation.publicKey, 'base64'),
            revokedAt: null, replacedByMachineId: null, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER };
        homes.answer(homeId, '/v1/machines', { body: [machine] });
        homes.answer(homeId, '/v1/machines/machine-exact', { body: { machine: { ...machine, kind: 'persistent' } } });
        rpcResult = source === 'unavailable'
            ? { status: 'unavailable', code: 'plugin_targeted_contributions_target_unavailable' }
            : { status: 'current', targetedContributions: PluginUiTargetedContributionsV1Schema.parse({
                target: { pluginId: 'external.widgets', occurrenceId: 'occurrence', sourceCustody: {
                    kind: 'development', registeredRootId: source === 'replaced' ? '/replacement/widgets' : '/external/widgets' } },
                points: [],
            }), targetedSurfaceMounts: [] };
        // Only the actual remote boundary is substituted. The daemon cannot reach
        // an app-local waiter or its followed page values; consent remains approved.
        homes.answer(homeId, '/v1/actions/approval.request.decide', { select: body => {
            const carried = ExternalActionRequestEnvelopeV1Schema.parse(body);
            return { body: { v: 1, actionId: 'approval.request.decide', requestId: carried.requestId,
                execution: { ok: true, result: { ok: true, status: 'approved' } } } };
        } });
        const cancellation = new AbortController();
        const pending = source === 'detached' ? null : coordinator.waitForDecision({ artifactId, request, signal: cancellation.signal });
        const completed = pending?.catch(() => null);
        try {
            expect(coordinator.getLiveWaiterCount(artifactId)).toBe(source === 'detached' ? 0 : 1);
            const decided = await executor.execute('approval.request.decide', { artifactId, decision: 'approve' }, context());
            expect(decided).toMatchObject({ ok: true });
            const status = source === 'replaced' || source === 'unavailable' ? 'failed' : 'approved';
            expect(persistedApproval(artifactId)).toMatchObject({ status,
                ...(status === 'failed' ? { execution: { ok: false, errorCode: 'approval_stale',
                    details: { reason: source === 'unavailable' ? 'currentness_read_failed' : 'plugin_source_changed' } } } : {}) });
            expect(coordinator.getLiveWaiterCount(artifactId)).toBe(0);
            if (completed) await expect(completed).resolves.toMatchObject({ decision: 'approve', request: { status } });
            expect(homes.requestsFor('/v1/actions/approval.request.decide')).toHaveLength(source === 'detached' ? 1 : 0);
            expect(outgoing).toEqual(expect.arrayContaining([expect.objectContaining({
                method: machineId + ':' + RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ,
                params: expect.objectContaining({ machineId, pluginId: 'external.widgets' }),
            })]));
            // Decision delivery owns no widget effect. In particular, withdrawn
            // custody cannot create the area's domain Artifact while settling.
            expect(homes.artifacts(homeId).readPlainBody(buildWidgetSurfaceArtifactIdV1(surface))).toBeNull();
        } finally {
            cancellation.abort();
            await completed;
        }
    });

    it.each([false, true])('settles shared Memory Keep both in the approving app without CLI requester custody (signed Session: %s)', async signed => {
        const { captureLazyActionAccountContext } = await import('./actionAccountContext');
        const { createUiPromptLibraryArtifactStore } = await import('@/sync/ops/promptLibrary/promptLibraryArtifactStore');
        const { createMemoryDocInLibrary, readMemoryDocInLibrary } = await import('@happier-dev/protocol/prompts/library/promptLibraryActionOperations');
        const { MemoryRememberInputV1Schema } = await import('@happier-dev/protocol/prompts/library/memoryActionsV1');
        const account = await captureLazyActionAccountContext(homeId);
        try {
            const store = createUiPromptLibraryArtifactStore(account.workflowArtifacts, account);
            const originalText = 'Verify webhook signatures before acknowledging payment events.';
            const reviewedText = 'Verify webhook signatures before acknowledging payment events; retain an idempotency key.';
            const created = await createMemoryDocInLibrary({ store, request: { title: 'Team Memory', text: originalText },
                randomId: () => 'original-fact', nowMs: () => 1, sourceSessionRef: null });
            const before = await readMemoryDocInLibrary({ store, artifactId: created.artifactId });
            homes.answer(homeId, `/v1/artifacts/${created.artifactId}/access/grants`, { body: {
                artifactId: created.artifactId, ownerAccountId: 'account-a', access: 'owner', grants: [{
                    principal: { kind: 'team', teamId: 'team-a' }, accessLevel: 'view',
                    createdByAccountId: 'account-a', createdAt: 1, display: { name: 'Team' },
                }],
            } });
            homes.answer(homeId, `/v1/public-shares?subjectKind=artifact&subjectId=${created.artifactId}`, { body: { publicShares: [] } });
            const input = MemoryRememberInputV1Schema.parse({ ref: { kind: 'doc', artifactId: created.artifactId, serverId: homeId },
                expectedRevision: before.revision, text: reviewedText,
                duplicateChoice: { kind: 'keep_both', expectedRevision: before.revision } });
            const { artifactId } = await invitationApproval('memory.remember', signed, false, undefined, input);
            const origin = persistedApproval(artifactId);
            const decide = () => executor.execute('approval.request.decide', { artifactId, decision: 'approve' }, context());

            const decided = await decide();
            expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
            await decide();

            const after = await readMemoryDocInLibrary({ store, artifactId: created.artifactId });
            if (!('body' in after)) throw new Error('Expected the Memory document index');
            expect(after.body.index.map(fact => fact.text)).toEqual([originalText, reviewedText]);
            expect(after.revision).toEqual({ headerVersion: before.revision.headerVersion + 1, bodyVersion: before.revision.bodyVersion + 1 });
            expect(persistedApproval(artifactId)).toMatchObject({ status: 'executed', execution: { ok: true },
                executionOriginV1: origin.v === 2 ? origin.executionOriginV1 : undefined });
            expect(outgoing).toEqual([]);
            expect(homes.requestsFor('/v1/actions/approval.request.decide')).toEqual([]);
        } finally { account.dispose(); }
    });

    it.each([
        { actionId: 'mcp.servers.signIn.start', input: { serverId: 'oauth-server' }, currentInventory: 'none' },
        { actionId: 'teams.credentials.externalKeys.create', input: {
            resourceId: 'resource-1', teamMembershipId: 'membership-1', label: 'CLI key',
        }, currentInventory: 'current' },
        { actionId: 'teams.credentials.externalKeys.create', input: {
            resourceId: 'resource-1', teamMembershipId: 'membership-1', label: 'CLI key',
        }, currentInventory: 'failed-refresh' },
    ] as const)('returns blocking $actionId approval to the live originating daemon ($currentInventory inventory)', async ({ actionId, input, currentInventory }) => {
        const { createPlainMachineRowFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const machineId = 'machine-exact';
        const machineRow = { ...createPlainMachineRowFixture({ id: machineId, accountId: 'account-a' }),
            installationId: 'installation-1', installationPublicKey: encodeBase64(installation.publicKey, 'base64'),
            revokedAt: null, replacedByMachineId: null, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER };
        homes.answer(homeId, '/v1/machines', { body: [machineRow] });
        homes.answer(homeId, '/v1/machines/machine-exact', { body: { machine: {
            ...createPlainMachineRowFixture({ id: machineId, accountId: 'account-a' }),
            id: machineId, kind: 'persistent', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        } } });
        if (currentInventory !== 'none') {
            const { sync } = await import('@/sync/sync');
            await sync.refreshMachines();
            if (currentInventory === 'failed-refresh') {
                homes.answer(homeId, '/v1/machines', { status: 503, body: {} });
                await expect(sync.refreshMachines()).rejects.toThrow();
                // A failed list does not revoke an already admitted own-Machine
                // row. Keep the HTTP failure installed through the decision.
                const { resolveFreshMachineAdministrationExecutionTarget } = await import('@/sync/domains/machines/administration/useTargetSelection');
                expect(resolveFreshMachineAdministrationExecutionTarget({ serverIdentityId: 'srv_approval_home', machineId }, {
                    intent: 'retry', accountScope: { serverId: homeId, accountId: 'account-a' },
                })).toMatchObject({ machine: { id: machineId, availability: { kind: 'available' },
                    access: { accessState: 'ready', custodian: { accountId: 'account-a' } } } });
            }
            homes.requests.length = 0;
        }
        const artifactId = `blocking-${actionId}`;
        await seedApproval(artifactId, ApprovalRequestSchema.parse({
            v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'cli' }, requestedSurface: 'cli',
            approval: { flow: 'blocking', result: 'required' },
            executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
                serverId: homeId, serverIdentityId: 'srv_approval_home', accountId: 'account-a',
                machineId, actionId, requestId: `request-${actionId}` },
            actionId, actionArgs: getActionSpec(actionId).inputSchema.parse(input), summary: 'Live result requested by CLI',
        }));
        homes.answer(homeId, '/v1/actions/approval.request.decide', { select: body => {
            // Only the remote daemon acknowledgement is substituted. The app's
            // replay decision, Home proof, strict request and Artifact CAS are real.
            const carried = ExternalActionRequestEnvelopeV1Schema.parse(body);
            expect(getActionSpec('approval.request.decide').inputSchema.parse(carried.input))
                .toEqual({ artifactId, decision: 'approve', serverIdentityId: 'srv_approval_home', originServerId: homeId });
            expect(carried.target).toEqual({ kind: 'machine', machineId });
            return { body: { v: 1, actionId: 'approval.request.decide', requestId: carried.requestId,
                execution: { ok: true, result: { ok: true, status: 'approved' } } } };
        } });

        const result = await executor.execute('approval.request.decide', { artifactId, decision: 'approve' }, context());

        expect(result, JSON.stringify({ result, paths: homes.requests.map(request => request.path),
            methods: outgoing.map(request => request.method) })).toMatchObject({ ok: true, result: { status: 'approved' } });
        expect(homes.requestsFor('/v1/actions/approval.request.decide')).toHaveLength(1);
        const machineReads = homes.requests.filter(request => request.path.startsWith('/v1/machines'));
        if (currentInventory === 'none') expect(machineReads.length).toBeGreaterThan(0);
        else expect(machineReads).toHaveLength(0);
        expect(outgoing).toEqual([]);
        // The app commits only the human decision. It does not execute the
        // target and strand the original caller with redacted Artifact history.
        expect(persistedApproval(artifactId)).toMatchObject({ status: 'approved' });
        expect(persistedApproval(artifactId)).not.toHaveProperty('execution');
    });

    it('replays a signed Session client proposal with the approving app authority and no daemon carrier', async () => {
        const { artifactId } = await invitationApproval('ui.voice_global.get', true, true);
        const { captureActionAccountContext } = await import('./actionAccountContext');
        const { normalizeActionsSettingsV1 } = await import('@happier-dev/protocol/actions/actionSettings');
        const { storage } = await import('@/sync/domains/state/storage');
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const account = await captureActionAccountContext(homeId);
        try {
            // A newer external Settings fact disables agent ingress; it must not
            // veto the approving person's separate UI invocation of the proposal.
            const settings = normalizeActionsSettingsV1(storage.getState().settings.actionsSettingsV1);
            const next = settingsParse({ ...storage.getState().settings, actionsSettingsV1: { ...settings,
                actions: { ...settings.actions, 'ui.voice_global.get': { disabledSurfaces: ['agent', 'mcp'] } } } });
            const previousVersion = storage.getState().settingsVersion;
            if (previousVersion === null) throw new Error('expected_settings_baseline');
            const version = previousVersion + 1;
            homes.answer(homeId, '/v2/account/settings', { body: { content: { t: 'plain', v: next }, version } });
            storage.getState().applySettingsForScope(account.accountLifetime.scope, next, version);
        } finally { account.dispose(); }
        const approved = await executor.execute('approval.request.decide', { artifactId, decision: 'approve' }, context());
        expect(approved, JSON.stringify(approved)).toMatchObject({ ok: true, result: {
            status: 'executed', execution: { ok: true, result: { voice: { status: 'disconnected' } } },
        } });
        expect(persistedApproval(artifactId)).toMatchObject({ executionOriginV1: {
            authority: 'account_automation', caller: { kind: 'session' }, externalActionExecutionAuthorization: expect.any(Object),
        } });
        expect(outgoing).toEqual([]);
    });
    it('settles a worker link created on another device through this reader profile and portable Home WorkspaceRef', async () => {
        const { computeWorkspaceSyncPolicyDigest } = await import('@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas');
        const { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } = await import('@happier-dev/protocol/projects/projectAccountRowsV1');
        const { createPlainProjectAccountRowListFixture } = await import('@/dev/testkit/fixtures/projectAccountRows');
        const artifactId = 'cross-device-worker-link';
        const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
        const original = ApprovalRequestV2Schema.parse({ v: 2, status: 'outcome_unknown', createdAtMs: 1, updatedAtMs: 2,
            createdBy: { surface: 'agent' }, requestedSurface: 'agent', summary: 'Link worker',
            actionId: 'workspace.sync.relationship.create', actionArgs: {
                v: 1, sourceWorkspaceRefId: 'source', targetMachineId: 'worker', targetPath: '/copy', mode: 'keep_synced',
                contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
                destinationIntent: 'materialize_from_source_workspace', purpose: 'worker_clean_copy',
            }, executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', caller: { kind: 'host' },
                serverId: 'creating-device-only-profile', serverIdentityId: 'srv_approval_home', accountId: 'account-a',
                actionId: 'workspace.sync.relationship.create', requestId: 'original-link-operation' },
            decision: { kind: 'approve', decidedAtMs: 1 },
            execution: { executedAtMs: 2, ok: false, effectAttempted: true, errorCode: 'RPC_OUTCOME_UNKNOWN' },
        });
        await seedApproval(artifactId, original);
        homes.answer(homeId, `POST ${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`, { body: createPlainProjectAccountRowListFixture({ workspaceRefs: [{
            id: 'source', serverId: 'srv_approval_home', machineId: 'controller', rootPath: '/source',
            label: null, createdAtMs: 1, lastOpenedAtMs: null,
        }] }) });
        const machine = createPlainMachineRowFixture({ id: 'controller', accountId: 'account-a' });
        homes.answer(homeId, '/v1/machines', { body: [machine] });
        homes.answer(homeId, '/v1/machines/controller', { body: { machine } });
        rpcResult = { outcome: 'succeeded', relationshipId: 'committed-link', controllerMachineId: 'controller',
            sourceWorkspaceRefId: 'source', targetWorkspaceRefId: 'copy' };
        expect(await executor.execute('approval.request.get', { artifactId }, context()))
            .toMatchObject({ ok: true, result: { request: { status: 'executed', execution: { result: rpcResult } } } });
        expect(persistedApproval(artifactId)).toMatchObject({ status: 'executed', executionOriginV1: original.executionOriginV1 });
        expect(outgoing.map(request => request.method)).toEqual([`controller:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATION_OBSERVE}`]);
    });
    beforeEach(async () => {
        vi.mocked(Modal.confirm).mockReset().mockResolvedValue(false);
        webLocks = installWebLockManagerMock();
        installHomeGovernanceBoundaries(homes);
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        setRuntimeFetch(homes.request);
        const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
        await loadSyncSingletonForTests();
        const { getStorage } = await import('@/sync/domains/state/storage');
        initialState = getStorage().getState();
        homeId = await homes.addHome({
            name: 'Approval Home', serverUrl: 'https://approval-actions.test',
            serverIdentityId: 'srv_approval_home', accountId: 'account-a', currentAccount: true,
        });
        const baseFeatures = createRootLayoutFeaturesResponse();
        const features = createRootLayoutFeaturesResponse({ capabilities: { session: {
            ...baseFeatures.capabilities.session, pendingInput: { protocolVersion: PENDING_INPUT_PROTOCOL_VERSION_V4 },
        } } });
        homes.answer(homeId, '/v1/features', { body: features });
        homes.answer(homeId, '/v1/features/authenticated', { body: features });
        homes.answer(homeId, '/v2/cursor', { body: { cursor: '0' } });
        const accountCredential = homes.findByServerUrl('https://approval-actions.test')?.token;
        if (!accountCredential) throw new Error('missing_current_account_credential');
        connection = await restoreServerAccountForTest({ serverUrl: 'https://approval-actions.test',
            serverIdentityId: 'srv_approval_home', accountId: 'account-a', request: homes.request,
            credentials: { token: accountCredential } });
        getStorage().getState().applySettingsForScope({ serverId: connection.serverId, accountId: 'account-a' }, getStorage().getState().settings, 0);
        const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        getStorage().setState({ sessions: { s1: createSessionFixture({ id: 's1', serverId: connection.serverId, active: true }) } });
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        executor = createDefaultActionExecutor({ resolveServerIdForSessionId: () => homeId });
        await seedApproval('artifact-1', approvalRequest());
        homes.requests.length = 0;
        outgoing.length = 0;
        rpcResult = { ok: true };
        rpcAcknowledgement = undefined;
        decisionReceiver = null;
    });
    afterEach(async () => {
        await connection.dispose();
        const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
        const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
        await serverScopedRpcSocketPool.stopAll();
        resetScopedMachineTransportCacheForTests();
        await homes.reset();
        const { resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        resetRuntimeFetch();
        const { getStorage } = await import('@/sync/domains/state/storage');
        getStorage().setState(initialState, true);
        vi.restoreAllMocks();
        webLocks.restore();
    });

    it('discovers a private addressed Discussion draft through the same captured-Home queue, Inbox identity and detail read', async () => {
        homes.answer(homeId, '/v1/discussions/discussion/participants', { body: {
            discussionId: 'discussion', ownerAccountId: 'account-a', access: 'owner', grants: [],
            participants: [{ participant: { kind: 'session', sessionId: 's1' }, answerPolicy: 'drafts_for_approval', createdAt: 1 }],
        } });
        const proposed = await executor.execute('discussion.reply', {
            discussionId: 'discussion', localId: 'private-answer',
            content: { v: 1, parts: [{ t: 'text', text: 'Private answer requiring review' }] },
            replyTarget: { kind: 'message', messageId: 'question' },
        }, { surface: 'agent', authority: 'account_automation', serverId: homeId,
            actionCaller: { kind: 'host' }, actionRequestId: 'draft-discovery',
            defaultSessionId: 's1', defaultSessionMachineId: 'machine-exact',
            discussionReplyReturn: { serverId: 'srv_approval_home', requestLocalId: 'question/1', acceptedTurnId: 'original-turn' } });
        expect(proposed, JSON.stringify(proposed)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        const { ActionApprovalRequestCreatedResultSchema } = await import('@happier-dev/protocol/actions/actionExecutionResult');
        if (!proposed.ok) throw new Error(proposed.error);
        const { artifactId } = ActionApprovalRequestCreatedResultSchema.parse(proposed.result);
        const request = persistedApproval(artifactId);
        expect(request).toMatchObject({ v: 2, discussionDraftReview: true, status: 'open' });
        // A newer unrelated row forces limit:1 to follow the Artifact cursor,
        // rather than treating the first structural page as the approval queue.
        const account = await (await import('./actionAccountContext')).captureLazyActionAccountContext(homeId);
        try {
            const unrelatedId = await account.createArtifact({ title: 'Unrelated document' }, 'Not an approval');
            const unrelated = homes.artifacts(homeId).read(unrelatedId);
            const draft = homes.artifacts(homeId).read(artifactId);
            if (!unrelated || !draft) throw new Error('Missing stored Artifact');
            homes.artifacts(homeId).replaceStoredRow({ ...unrelated, updatedAt: Math.max(unrelated.updatedAt, draft.updatedAt + 1) });
        } finally { account.dispose(); }
        const otherHome = await homes.addHome({ name: 'Focused elsewhere', serverUrl: 'https://other-discovery.test',
            serverIdentityId: 'srv_other_discovery', accountId: 'account-b', currentAccount: true });
        homes.requests.length = 0;
        const listed = await executor.execute('approval.request.list', { status: 'open', limit: 1 }, context());
        expect(listed, JSON.stringify(listed)).toMatchObject({ ok: true, result: { items: [{ artifactId, actionId: 'discussion.reply', status: 'open' }],
            queryPlan: { kind: 'approval_artifact_header_scan', backingStore: 'ArtifactStore', serverLimit: 1, hydratedTranscripts: false } } });
        expect(await executor.execute('approval.request.get', { artifactId }, context()))
            .toMatchObject({ ok: true, result: { artifactId, request: { ...request, discussionDraftReview: true } } });
        const original = await (await import('./actionAccountContext')).captureLazyActionAccountContext(homeId);
        try {
            // The detail hook reads through this same captured Account owner.
            const artifact = await original.fetchArtifact(artifactId);
            if (!artifact) throw new Error('Missing private approval');
            const { isOpenApprovalInboxArtifact, readOpenApprovalDiscussionAttention } = await import('@/sync/domains/artifacts/approvalArtifacts');
            expect(isOpenApprovalInboxArtifact(artifact)).toBe(true);
            expect(readOpenApprovalDiscussionAttention(artifact)).toMatchObject({ discussionId: 'discussion', reason: 'draft_waiting' });
            const { buildInboxItems } = await import('@/components/inbox/inboxItems');
            const rows = buildInboxItems({ workGroups: [{ key: 'other', root: { kind: 'other' },
                items: [{ kind: 'approval', key: `approval:${artifactId}`, artifact }] }],
                sessionPresentation: { sessionsNeedingAttention: [], readySessions: [], markAllReadTargets: [], pendingRequestHydrationTargets: [] },
                workflowServerId: null, accountServerId: original.serverId, notices: [] });
            expect(rows).toHaveLength(1);
            const row = rows[0]!;
            expect(row.focus).toEqual({ kind: 'approval', serverId: original.serverIdentityId, id: artifactId });
            expect(row.pageRoute).toBe(`/inbox/approvals/${artifactId}?serverId=${encodeURIComponent(original.serverIdentityId!)}`);
        } finally { original.dispose(); }
        expect(homes.requests.filter(entry => entry.serverId === otherHome)).toEqual([]);
        expect(homes.requests.filter(entry => entry.path.startsWith('/v1/sessions') || entry.path.includes('/messages'))).toEqual([]);
        expect(outgoing).toEqual([]);
    });

    it.each(['reject', 'cancel'] as const)('settles the original private Discussion draft on its captured Home after %s', async decision => {
        const artifactId = 'private-discussion-draft';
        const terminal = decision === 'reject' ? 'rejected' : 'canceled';
        await seedApproval(artifactId, ApprovalRequestSchema.parse({
            v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 's1' }, requestedSurface: 'agent',
            discussionDraftReview: true, approval: { flow: 'deferred', result: 'required' },
            executionOriginV1: {
                v: 1, authority: 'account_automation', surface: 'agent', caller: { kind: 'host' },
                serverId: homeId, serverIdentityId: 'srv_approval_home', accountId: 'account-a', sessionId: 's1',
                machineId: 'machine-exact', actionId: 'discussion.reply', requestId: 'private-answer',
                discussionReplyReturn: { serverId: 'srv_approval_home', requestLocalId: 'question/1', acceptedTurnId: 'original-turn' },
            },
            actionId: 'discussion.reply', summary: 'Review private answer', actionArgs: {
                discussionId: 'discussion', localId: 'draft-answer',
                content: { v: 1, parts: [{ t: 'text', text: 'Private draft answer' }] },
                replyTarget: { kind: 'message', messageId: 'question' },
            },
        }));
        const otherHomeId = await homes.addHome({ name: 'Other Home', serverUrl: 'https://other-approval.test',
            serverIdentityId: 'other-home', accountId: 'account-b', currentAccount: true });
        const path = '/v2/sessions/s1/messages/by-local-id/question%2F1/reply';
        let refuse = true;
        homes.answer(homeId, `POST ${path}`, { select: input => {
            expect(persistedApproval(artifactId).status).toBe(terminal);
            expect(input).toEqual({ kind: 'discussion_review', discussionId: 'discussion', messageId: 'question',
                acceptedTurnId: 'original-turn', decision });
            return refuse ? { status: 409, body: { v: 1, ok: false, error: 'conflict' } }
                : { body: { v: 1, ok: true, progress: { v: 1, mode: 'return', discussion: {
                    discussionId: 'discussion', messageId: 'question', throughSeq: 1, participantSessionId: 's1',
                }, acceptedTurnId: 'original-turn', disposition: 'released', outcome: { kind: 'declined' } } } };
        } });
        homes.requests.length = 0;
        const decide = () => executor.execute('approval.request.decide', { artifactId, decision }, context());
        expect(await decide()).toMatchObject({ ok: false, errorCode: 'conflict' });
        const closed = persistedApproval(artifactId);
        expect(closed.status).toBe(terminal);
        refuse = false;
        expect(await decide()).toMatchObject({ ok: true, result: { status: terminal } });
        expect(persistedApproval(artifactId)).toEqual(closed);
        expect(homes.requestsFor(path)).toHaveLength(2);
        expect(homes.requestsFor(path).every(request => request.serverId === homeId)).toBe(true);
        expect(homes.requests.filter(request => request.serverId === otherHomeId)).toEqual([]);
        expect(homes.requests.filter(request => request.path.startsWith('/v1/discussions'))).toEqual([]);
        expect(outgoing).toEqual([]);
    });


    it('exposes the approval replay entry point through the app client executor', async () => {
        await expect(executor.replayApprovedApprovalRequest({ artifactId: 'artifact-missing' }))
            .resolves.toMatchObject({ ok: false, errorCode: 'approval_not_found' });
    });
    it.each(['approve', 'reject'] as const)('sends strict exact-daemon decision input for a contributed Action (%s)', async (decision) => {
        const { createPlainMachineRowFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        homes.answer(homeId, '/v1/machines/machine-exact', { body: { machine: {
            ...createPlainMachineRowFixture({ id: 'machine-exact', accountId: 'account-a' }),
            kind: 'persistent', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        } } });
        const { replayApprovalRequestAtExactDaemon } = await import('./defaultActionExecutor');
        const { createActionExecutor } = await import('@happier-dev/protocol/actions/actionExecutor');
        const { createActionExecutorBoundaryFixture } = await import('@/dev/testkit/fixtures/actionExecutorBoundary');
        const { captureLazyActionAccountContext } = await import('./actionAccountContext');
        const { writeApprovalRequestArtifact } = await import('./approvalArtifactWriter');
        const { approvalArtifactBodyMatchesHeaderV1 } = await import('@happier-dev/protocol/approvals/approvalArtifactHeaderV1');
        const artifactId = 'contributed-approval';
        const original = approvalRequest();
        if (original.v !== 2) throw new Error('Expected current approval');
        await seedApproval(artifactId, ApprovalRequestSchema.parse({ ...original,
            createdBy: { surface: 'system', pluginId: 'acme.reviewer', contributionLocalId: 'review' },
            requestedSurface: 'plugin', executionOriginV1: { ...original.executionOriginV1,
                serverId: 'creator-profile', serverIdentityId: 'srv_approval_home', machineId: 'machine-exact',
                surface: 'plugin', caller: { kind: 'plugin', pluginId: 'acme.reviewer', contributionLocalId: 'review',
                    sourceCustody: { kind: 'development', registeredRootId: 'reviewer-root' } },
            },
        }));
        const account = await captureLazyActionAccountContext(homeId);
        const read = (id: string) => account.fetchArtifact(id);
        const receiver = createActionExecutor(createActionExecutorBoundaryFixture({
            approvalsGet: async ({ artifactId }) => {
                const artifact = await read(artifactId);
                if (!artifact?.header || typeof artifact.body !== 'string') return null;
                const matched = approvalArtifactBodyMatchesHeaderV1(artifact.header, artifact.body);
                return matched?.family === 'built_in' ? matched.request : null;
            },
            approvalsUpdate: async ({ artifactId, request }) => writeApprovalRequestArtifact({ artifactId, request, read,
                write: (basis, header, body) => account.updateArtifact(artifactId, header, body, basis) }),
        }));
        decisionReceiver = input => receiver.execute('approval.request.decide', input, {
            surface: 'ui', authority: 'present_user', serverId: homeId, runtimeAccountId: 'account-a',
            serverIdentityId: 'srv_approval_home',
        });
        try {
            // The receiving decision owner must reject the old producer's extra
            // field before touching the Artifact; no permissive transport stub.
            expect(await decisionReceiver({ artifactId, decision, serverId: homeId }))
                .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
            expect(persistedApproval(artifactId).status).toBe('open');
            // This daemon has no live plugin-generation authority. Admission
            // therefore settles approve as stale instead of inventing execution.
            await expect(replayApprovalRequestAtExactDaemon({ artifactId, decision,
                executionTarget: { serverId: homeId, machineId: 'machine-exact',
                    serverIdentityId: 'srv_approval_home', originServerId: 'creator-profile' },
            })).resolves.toMatchObject({ ok: true, result: { status: decision === 'approve' ? 'failed' : 'rejected' } });
            expect(persistedApproval(artifactId).status).toBe(decision === 'approve' ? 'failed' : 'rejected');
            const request = outgoing.find(entry => entry.method === 'machine-exact:' + RPC_METHODS.APPROVAL_REQUEST_DECIDE);
            expect(request).toBeDefined();
            expect(getActionSpec('approval.request.decide').inputSchema.safeParse(request?.params).success).toBe(true);
            expect(request?.params).toEqual({ artifactId, decision,
                serverIdentityId: 'srv_approval_home', originServerId: 'creator-profile' });
        } finally { decisionReceiver = null; account.dispose(); }
    });
    it.each([true, false])('replays the exact CLI relation proposal once only on its current Home (%s)', async (currentHome) => {
        const artifactId = 'cli-relation-approval';
        const input = { sessionId: 's1', managerSessionId: 'lead', expectedManagerSessionId: null };
        const origin = {
            v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
            serverId: 'creator-cli-profile', serverIdentityId: currentHome ? 'srv_approval_home' : 'srv_foreign_home',
            accountId: 'account-a', machineId: 'creator-machine',
            actionId: 'session.manager.set', requestId: 'reviewed-relation-request',
        } as const;
        const { captureLazyActionAccountContext } = await import('./actionAccountContext');
        const account = await captureLazyActionAccountContext(homeId);
        try {
            expect(account.accountId).toBe('account-a');
            expect(account.serverIdentityId).toBe('srv_approval_home');
            const { isApprovalExecutionOriginCurrentForAccountContext } = await import('./defaultActionExecutor');
            expect(isApprovalExecutionOriginCurrentForAccountContext({ origin,
                accountServerId: account.serverId, accountId: account.accountId })).toBe(currentHome);
        } finally { account.dispose(); }
        await seedApproval(artifactId, ApprovalRequestSchema.parse({
            v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'cli' }, requestedSurface: 'cli', executionOriginV1: origin,
            actionId: 'session.manager.set', actionArgs: input, summary: 'Put session under lead',
        }));
        const path = '/v1/sessions/s1/manager';
        homes.answer(homeId, path, { body: { ok: true, sessionId: 's1', managerSessionId: 'lead', attachedAt: 1 } });
        homes.answer(homeId, '/v1/auth/ping', { body: {} });
        // Plain source content needs no daemon key transfer after the committed edge.
        const sessionAnswer = { body: { session: {
            id: 's1', seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
            archivedAt: null, metadata: '{}', metadataVersion: 1, agentState: null,
            agentStateVersion: 0, pendingCount: 0, pendingVersion: 0,
            dataEncryptionKey: null, encryptionMode: 'plain',
        } } };
        homes.answer(homeId, '/v2/sessions/s1', sessionAnswer);
        homes.answer(homeId, '/v2/sessions/s1?accessProjectionVersion=1', sessionAnswer);
        const decide = () => executor.execute('approval.request.decide', { artifactId, decision: 'approve' }, context());
        const decided = await decide();
        expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: {
            status: currentHome ? 'executed' : 'failed',
            execution: currentHome ? { ok: true } : { ok: false, errorCode: 'approval_stale' },
        } });
        await decide();
        expect(homes.requestsFor(path)).toHaveLength(currentHome ? 1 : 0);
        if (currentHome) {
            expect(homes.requestsFor(path)[0]?.input).toEqual({ managerSessionId: 'lead', expectedManagerSessionId: null });
            expect(homes.requestsFor(path)[0]?.token === homes.findByServerUrl('https://approval-actions.test')?.token).toBe(true);
        }
        expect(persistedApproval(artifactId)).toMatchObject({ executionOriginV1: origin });
        expect(outgoing).toEqual([]);
    });
    it.each([false, true])('executes a signed self-name request once in the approving app (public proposal: %s)', async publicProposal => {
        const { artifactId, input } = await invitationApproval('account.name.set', true, publicProposal);
        expect(persistedApproval(artifactId)).toMatchObject({ createdBy: { sessionId: 's1' },
            approval: { flow: 'deferred', result: 'required' } });
        const path = '/v1/account/profile';
        const output = { name: 'Captain', firstName: 'Captain', lastName: null, timestamp: 10 };
        homes.answer(homeId, path, { body: output });
        const decide = () => executor.execute('approval.request.decide', { artifactId, decision: 'approve' }, context());
        expect(await decide()).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
        await decide();
        const mutations = homes.requestsFor(path).filter(request => request.input !== null);
        expect(mutations).toHaveLength(1);
        expect(mutations[0]?.input).toEqual(input);
        expect(mutations[0]?.token === homes.findByServerUrl('https://approval-actions.test')?.token).toBe(true);
        expect(outgoing).toEqual([]);
        expect(persistedApproval(artifactId)).toMatchObject({ status: 'executed', execution: { ok: true, result: output } });
        const stored = persistedApproval(artifactId);
        expect(stored.v === 2 && stored.executionOriginV1.externalActionExecutionAuthorization?.binding.actionId)
            .toBe(publicProposal ? 'approval.request.create' : 'account.name.set');
    });

    it('refuses a self-name proposal borrowing an unrelated read carrier', async () => {
        const { artifactId } = await invitationApproval('account.name.set', true, true, 'teams.list');
        expect(await executor.execute('approval.request.decide', { artifactId, decision: 'approve' }, context()))
            .toMatchObject({ ok: true, result: { status: 'failed', execution: { ok: false, errorCode: 'approval_stale' } } });
        expect(homes.requestsFor('/v1/account/profile').filter(request => request.input !== null)).toEqual([]);
        expect(outgoing).toEqual([]);
    });

    it.each([
        { actionId: 'teams.invitations.create', signed: true },
        { actionId: 'teams.invitations.reissue', signed: true },
        { actionId: 'teams.invitations.create', signed: false },
        { actionId: 'teams.invitations.reissue', signed: false },
    ] as const)(
        'replays $actionId through its original custody (signed Session: $signed)', async ({ actionId, signed }) => {
            const { artifactId, input, proposed } = await invitationApproval(actionId, signed);
            const invitation = { id: 'invitation-a', teamId: 'team-a', state: 'active', role: 'member',
                historyAccess: 'from_membership', recipientEmailMask: null, expiresAt: 2, createdAt: 1,
                createdByAccountId: 'account-a', acceptedByAccountId: null, lastEmailDelivery: null };
            const joinUrl = 'https://approval-actions.test/join/live-result-sentinel';
            const output = actionId === 'teams.invitations.create' ? { invitation, joinUrl }
                : { previous: { ...invitation, id: 'old-invitation', state: 'revoked' }, replacement: invitation, joinUrl };
            const path = `/v1/teams/invitations/${actionId.endsWith('create') ? 'create' : 'reissue'}`;
            homes.answer(homeId, path, { body: output });
            const decide = () => executor.execute('approval.request.decide', { artifactId, decision: 'approve' }, context());
            const human = await decide();
            // Account effects without a Machine effect use the approving app
            // under the 2026-10-12 ruling, including signed Session proposals.
            // Avoid emitting a one-time fixture URL in assertion failures.
            const outcome = human.ok && typeof human.result === 'object' && human.result !== null
                ? human.result as { status?: string; execution?: { errorCode?: string } } : null;
            expect(outcome?.status === 'executed', human.ok ? outcome?.execution?.errorCode : human.errorCode).toBe(true);
            expect(human.ok && typeof human.result === 'object' && human.result !== null
                && 'liveExecution' in human.result && JSON.stringify(human.result.liveExecution).includes(joinUrl)).toBe(true);
            expect(homes.requestsFor(path)).toHaveLength(1);
            expect(homes.requestsFor(path)[0]?.input).toEqual(input);
            expect(homes.requestsFor(path)[0]?.token === homes.findByServerUrl('https://approval-actions.test')?.token).toBe(true);
            expect(outgoing).toEqual([]);
            expect(persistedApproval(artifactId)).toMatchObject({ status: 'executed', decision: { kind: 'approve', authority: 'present_user' } });
            const repeated = await decide();
            const agent = await executor.execute('approval.request.get', { artifactId }, {
                surface: 'agent', authority: 'account_automation', serverId: homeId, actionCaller: { kind: 'host' },
            });
            for (const safe of [proposed, repeated, agent, persistedApproval(artifactId)]) {
                expect(JSON.stringify(safe).includes(joinUrl)).toBe(false);
            }
            expect(homes.requestsFor(path)).toHaveLength(1);
        },
    );
    it.each(['reject', 'cancel'] as const)('does not execute a signed invitation after %s', async decision => {
        const { artifactId } = await invitationApproval('teams.invitations.create');
        await expect(executor.execute('approval.request.decide', { artifactId, decision }, context()))
            .resolves.toMatchObject({ ok: true, result: { status: decision === 'reject' ? 'rejected' : 'canceled' } });
        expect(homes.requestsFor('/v1/teams/invitations/create')).toEqual([]);
        expect(outgoing).toEqual([]);
    });
    it('routes an unsigned native private Discussion Post to its exact Machine, not the live Session', async () => {
        const artifactId = 'unsigned-native-private-discussion';
        const machine = createPlainMachineRowFixture({ id: 'machine-exact', accountId: 'account-a' });
        homes.answer(homeId, '/v1/machines?includeRevoked=true', { body: [machine] });
        homes.answer(homeId, '/v1/machines/machine-exact', { body: { machine } });
        const request = ApprovalRequestSchema.parse({
            v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 's1' }, requestedSurface: 'agent',
            discussionDraftReview: true, approval: { flow: 'deferred', result: 'required' },
            executionOriginV1: {
                v: 1, authority: 'account_automation', surface: 'agent',
                caller: { kind: 'session', sessionId: 's1', starterDepth: 0, turnDepth: 0 },
                serverId: 'creator-cli-profile', serverIdentityId: 'srv_approval_home', accountId: 'account-a',
                sessionId: 's1', machineId: 'machine-exact', actionId: 'discussion.reply', requestId: 'private-native-answer',
                discussionReplyReturn: { serverId: 'srv_approval_home', requestLocalId: 'discussion-follow-v1:question',
                    acceptedTurnId: 'native-turn-question' },
            },
            actionId: 'discussion.reply', summary: 'Review private answer', actionArgs: {
                discussionId: 'discussion', localId: 'private-native-answer',
                content: { v: 1, parts: [{ t: 'text', text: 'Reviewed native answer' }] },
                replyTarget: { kind: 'message', messageId: 'question' },
            },
        });
        await seedApproval(artifactId, request);
        const { ExternalActionResponseEnvelopeV1Schema } = await import('@happier-dev/protocol/actions/externalActionApi');
        const path = '/v1/actions/approval.request.decide';
        // The real UI executor owns consent/CAS and routing. Only the remote
        // Machine's execution response is substituted at the HTTP boundary.
        homes.answer(homeId, path, { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
            expect(envelope.target).toEqual({ kind: 'machine', machineId: 'machine-exact' });
            expect(envelope.input).toEqual({ artifactId, decision: 'approve',
                serverIdentityId: 'srv_approval_home', originServerId: 'creator-cli-profile' });
            return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'approval.request.decide',
                requestId: envelope.requestId, execution: { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' } }) };
        } });
        const result = await executor.execute('approval.request.decide', { artifactId, decision: 'approve' }, context());
        expect(result, JSON.stringify({ result, requests: homes.requests.map(({ serverId, serverUrl, path }) => ({ serverId, serverUrl, path })) }))
            .toMatchObject({ ok: false, errorCode: 'target_unavailable' });
        expect(persistedApproval(artifactId)).toMatchObject({ status: 'approved',
            decision: { kind: 'approve', authority: 'present_user' }, executionOriginV1: request.executionOriginV1 });
        expect(persistedApproval(artifactId).execution).toBeUndefined();
        expect(homes.requestsFor(path)).toHaveLength(1);
        expect(homes.requests.filter(entry => entry.path.startsWith('/v1/discussions'))).toEqual([]);
        expect(outgoing).toEqual([]);
    });
    it('keeps a signed Session Machine effect on the exact daemon replay path', async () => {
        const { artifactId } = await invitationApproval('teams.invitations.create');
        const original = persistedApproval(artifactId);
        if (original.v !== 2 || !original.executionOriginV1.externalActionExecutionAuthorization
            || !original.executionOriginV1.target) throw new Error('expected_signed_origin');
        const actionId = 'paths.list_recent';
        const input = { machineId: 'machine-exact', limit: 10 };
        const origin = original.executionOriginV1;
        const authorization = original.executionOriginV1.externalActionExecutionAuthorization;
        const target = original.executionOriginV1.target;
        const machineRequest = ApprovalRequestSchema.parse({ ...original, actionId, actionArgs: input,
            executionOriginV1: { ...origin, actionId,
                externalActionExecutionAuthorization: { ...authorization, binding: { ...authorization.binding, actionId,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({
                        v: 1, requestId: origin.requestId, target, input,
                    }),
                } },
                externalActionInputSignature: signExternalActionApprovalInputV1({ authorizationToken: authorization.token,
                    actionId, input, target, privateKey: installation.secretKey }),
            },
        });
        await seedApproval('signed-machine-approval', machineRequest);
        const { ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } = await import('@happier-dev/protocol/actions/externalActionApi');
        const path = '/v1/actions/approval.request.decide';
        // The current Account transport addresses the original Machine through
        // Home. Only that remote execution boundary is substituted here.
        homes.answer(homeId, path, { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
            expect(envelope.target).toEqual({ kind: 'machine', machineId: 'machine-exact' });
            expect(envelope.input).toMatchObject({ artifactId: 'signed-machine-approval', decision: 'approve' });
            return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'approval.request.decide',
                requestId: envelope.requestId, execution: { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' } }) };
        } });
        expect(await executor.execute('approval.request.decide', { artifactId: 'signed-machine-approval', decision: 'approve' }, context()))
            .toMatchObject({ ok: false, errorCode: 'target_unavailable' });
        expect(homes.requestsFor(path)).toHaveLength(1);
        expect(outgoing).toEqual([]);
        expect(homes.requestsFor('/v1/teams/invitations/create')).toEqual([]);
    });
    it('records the authenticated Home effect failure and does not retry it on a repeated decision', async () => {
        const { artifactId } = await invitationApproval('teams.invitations.create', false);
        const path = '/v1/teams/invitations/create';
        homes.answer(homeId, path, { status: 403, body: { error: 'permission_denied' } });
        const decide = () => executor.execute('approval.request.decide', { artifactId, decision: 'approve' }, context());
        await expect(decide()).resolves.toMatchObject({ ok: true, result: { status: 'failed', execution: { ok: false } } });
        expect(persistedApproval(artifactId)).toMatchObject({ status: 'failed',
            decision: { kind: 'approve', authority: 'present_user' }, execution: { ok: false } });
        await decide();
        expect(homes.requestsFor(path)).toHaveLength(1);
        expect(outgoing).toEqual([]);
    });
    it.each(['input', 'actionId', 'requester'] as const)('refuses a tampered signed approval %s', async field => {
        const { artifactId } = await invitationApproval('teams.invitations.create');
        const original = persistedApproval(artifactId);
        const tampered = { ...original,
            ...(field === 'input' ? { actionArgs: { ...original.actionArgs as Record<string, unknown>, teamId: 'other-team' } }
                : field === 'actionId' ? { actionId: 'teams.invitations.reissue' }
                : { createdBy: { surface: 'agent', sessionId: 'other-session' } }),
        };
        // Replace the network's stored bytes, including its index, to model tampering before a read.
        const replaced = await homes.artifacts(homeId).handle(`/v1/artifacts/${artifactId}`, {
            method: 'POST', body: JSON.stringify({
                header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(tampered as ApprovalRequest)),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(tampered) }),
                expectedHeaderVersion: homes.artifacts(homeId).list().find(row => row.id === artifactId)?.headerVersion,
                expectedBodyVersion: homes.artifacts(homeId).list().find(row => row.id === artifactId)?.bodyVersion,
            }),
        });
        expect(replaced?.ok).toBe(true);
        await executor.execute('approval.request.decide', { artifactId, decision: 'approve' }, context());
        expect(homes.requestsFor('/v1/teams/invitations/create')).toEqual([]);
        expect(homes.requestsFor('/v1/teams/invitations/reissue')).toEqual([]);
        expect(outgoing).toEqual([]);
        expect(JSON.parse(homes.artifacts(homeId).readPlainBody(artifactId)!).status).not.toBe('executed');

    });
    it('admits the original Account signed HTTP approval decision at foreign Machine custody', async () => {
        const machineId = 'foreign-controller';
        const installationId = 'foreign-installation';
        const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
        const credential = homes.findByServerUrl('https://approval-actions.test')?.token;
        if (!credential) throw new Error('missing_original_account_credential');
        const foreignMachine = { ...createPlainMachineRowFixture({ id: machineId, accountId: 'foreign-owner' }), kind: 'persistent', active: true,
            installationId, installationPublicKey: encodeBase64(installation.publicKey), revokedAt: null,
            replacedByMachineId: null, dataEncryptionKey: null, runnerContentKeyBinding: null,
            access: { custodian: { accountId: 'foreign-owner', displayName: 'Owner' }, role: 'manage',
                resourceMode: 'plain', accessState: 'ready' } } as const;
        homes.answer(homeId, '/v1/machines', { body: [foreignMachine] });
        homes.answer(homeId, `/v1/machines/${machineId}`, { body: { machine: foreignMachine } });
        const actionId = 'machines.managed.rebuild';
        const nativeInput = { homeId: 'srv_approval_home', managedMachineId: 'foreign-child', kind: 'rebuild',
            expectedRevision: 4, reviewedEffectDigest: 'a'.repeat(64) };
        const originalEnvelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: 'original-native-request',
            target: { kind: 'machine', machineId }, input: nativeInput });
        const originalRoot = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'original-native-home-root', binding: {
            accountId: 'account-a', authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId: 'srv_approval_home',
            machineId, installationId, custodianAccountId: 'foreign-owner', accountEncryptionMode: 'plain',
            actionId, requestId: originalEnvelope.requestId, target: originalEnvelope.target,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(originalEnvelope),
        } });
        await seedApproval('foreign-native-approval', ApprovalRequestSchema.parse({ v: 2, status: 'open', createdAtMs: 1,
            updatedAtMs: 1, createdBy: { surface: 'system' }, requestedSurface: 'ui', actionId, actionArgs: nativeInput,
            approval: { result: 'required', flow: 'deferred' }, summary: 'Reviewed rebuild', executionOriginV1: {
                v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' }, serverId: homeId,
                serverIdentityId: 'srv_approval_home', accountId: 'account-a', machineId, target: originalEnvelope.target,
                actionId, requestId: originalEnvelope.requestId, externalActionExecutionAuthorization: originalRoot,
                externalActionInputSignature: 's'.repeat(86),
            } }));
        let decisionRequestId: string | undefined;
        homes.answer(homeId, '/v1/actions/approval.request.decide/execution-authorization', { select: body => {
            const mint = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            decisionRequestId = mint.envelope.requestId;
            expect(decisionRequestId).toBeTruthy();
            expect(mint.envelope).toMatchObject({ requestId: decisionRequestId, target: originalEnvelope.target });
            return { body: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fresh-decision-home-root', binding: {
                accountId: 'account-a', authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId: 'srv_approval_home',
                machineId, installationId, custodianAccountId: 'foreign-owner', accountEncryptionMode: 'plain',
                actionId: 'approval.request.decide', requestId: decisionRequestId, target: mint.envelope.target,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(mint.envelope),
            } }) };
        } });
        const nativeResult = { kind: 'conflict', currentRevision: 5 };
        homes.answer(homeId, '/v1/actions/approval.request.decide', { select: body => {
            const carried = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            expect(openExternalActionRequesterAccountContextV1({ authorization: carried.executionAuthorization,
                purpose: { kind: 'external_action' }, machineId, installationId, serverIdentityId: 'srv_approval_home',
                installationPrivateKey: installation.secretKey })).toEqual({ token: credential });
            if (carried.envelope.v !== 1) throw new Error('expected_plain_account_envelope');
            // The remote HTTP/daemon boundary uses the real canonical Action admission schema.
            const admitted = getActionSpec('approval.request.decide').inputSchema.safeParse(carried.envelope.input);
            if (!admitted.success) return { body: { v: 1, actionId: 'approval.request.decide', requestId: decisionRequestId,
                execution: { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' } } };
            expect(admitted.data).toEqual({ artifactId: 'foreign-native-approval', decision: 'approve',
                serverIdentityId: 'srv_approval_home', originServerId: homeId });
            expect(persistedApproval('foreign-native-approval')).toMatchObject({ status: 'approved', executionOriginV1: {
                requestId: 'original-native-request', externalActionExecutionAuthorization: originalRoot } });
            expect(JSON.stringify(carried)).not.toContain(credential);
            return { body: { v: 1, actionId: 'approval.request.decide', requestId: decisionRequestId,
                execution: { ok: true, result: nativeResult } } };
        } });
        const { createFrontDoorActionExecute } = await import('./frontDoorRuntimeActionExecutor');
        const result = await createFrontDoorActionExecute(executor)('approval.request.decide', {
            artifactId: 'foreign-native-approval', decision: 'approve',
        }, { ...context(), expectedAccountId: 'account-a' });
        expect(result, JSON.stringify({ result, paths: homes.requests.map(request => request.path) }))
            .toEqual({ ok: true, result: nativeResult });
        expect(outgoing).toEqual([]);
        const sent = homes.requestsFor('/v1/actions/approval.request.decide');
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ serverId: homeId, token: credential });
    });
    it('routes durable review-comment actions through the shared HTTP action executor', async () => {
        const path = '/v1/reviews/comments?projectId=project-1&states=open&includeHistory=false&limit=50&stored=true';
        homes.answer(homeId, path, { body: { items: [], cursor: null } });
        await expect(executor.execute('reviews.comments.list', { projectId: 'project-1', states: ['open'] }, context()))
            .resolves.toEqual({ ok: true, result: { items: [], cursor: null } });
        expect(homes.requestsFor(path)).toHaveLength(1);
    });
    it('routes permission grants and webhook endpoints through the Action front door dependencies', async () => {
        vi.mocked(Modal.confirm).mockResolvedValue(true);
        homes.answer(homeId, '/v1/plugins/permissions/grants/list', { body: { grants: [], pendingRequests: [] } });
        await expect(executor.execute('plugins.permissions.grants.list', { pluginId: 'example.plugin' }, context()))
            .resolves.toEqual({ ok: true, result: { grants: [], pendingRequests: [] } });
        expect(homes.requestsFor('/v1/plugins/permissions/grants/list')[0]?.input).toMatchObject({ pluginId: 'example.plugin' });
        const input = {
            webhookContribution: { pluginId: 'example.github', localId: 'events' },
            targetMaterialization: { machineId: 'machine-1', materializationId: 'materialization-1', pluginId: 'example.github' },
            sourceInstanceId: 'channel:github:primary', setup: { kind: 'accountEndpointV1', credential: 'serverGenerated' },
            idempotencyKey: 'ensure-github-primary-0001',
        } as const;
        homes.answer(homeId, '/v1/plugins/webhooks/endpoints/ensure', { body: {
            webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA', revision: 1,
            publicUrl: 'https://example.test/v1/plugins/webhooks/opaque-route', readiness: 'ready',
        } });
        await expect(executor.execute('plugin.webhook.endpoint.ensure', input, context()))
            .resolves.toMatchObject({ ok: true, result: { readiness: 'ready' } });
        expect(homes.requestsFor('/v1/plugins/webhooks/endpoints/ensure')[0]?.input).toEqual(input);
        expect(Modal.confirm).toHaveBeenCalledTimes(1);
    });
    it('routes Account plugin erase recovery through one shared policy confirmation without forwarding generic retry identity metadata', async () => {
        vi.mocked(Modal.confirm).mockResolvedValue(true);
        homes.answer(homeId, '/v1/plugins/data/account-erase', { body: { status: 'erased', changed: false } });
        const { createPluginAccountDataEraseRecoveryController } = await import('@/components/settings/plugins/pluginAccountDataEraseRecoveryController');
        const { createFrontDoorActionExecute } = await import('./frontDoorRuntimeActionExecutor');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const controller = createPluginAccountDataEraseRecoveryController({
            execute: createFrontDoorActionExecute(executor), modal: Modal,
            captureActiveAccountScopeLifetime: captureActiveServerAccountScopeLifetime,
        });
        await controller.eraseKnownPlugin('example.orphaned-plugin');
        expect(homes.requestsFor('/v1/plugins/data/account-erase')[0]?.input).toEqual({ pluginId: 'example.orphaned-plugin' });
        expect(Modal.confirm).toHaveBeenCalledTimes(1);
    });
    it('routes the host-present current-Account sign-out-everywhere action', async () => {
        vi.mocked(Modal.confirm).mockResolvedValue(true);
        homes.answer(homeId, '/v1/auth/sessions/sign-out-everywhere', { body: { status: 'signed_out' } });
        await expect(executor.execute('account.sessions.signOutEverywhere', {}, { ...context(), actionCaller: { kind: 'host' } }))
            .resolves.toEqual({ ok: true, result: { status: 'signed_out' } });
        expect(homes.requestsFor('/v1/auth/sessions/sign-out-everywhere')[0]?.input).toEqual({});
        expect(Modal.confirm).toHaveBeenCalledTimes(1);
    });
    it('routes current-Account API-token Actions through their scoped transport with no caller-selected Account', async () => {
        vi.mocked(Modal.confirm).mockResolvedValue(true);
        const input = { tokenId: apiTokenSummary.tokenId, label: apiTokenSummary.label, expiresAt: apiTokenSummary.expiresAt };
        homes.answer(homeId, '/v1/auth/api-tokens/create', { body: { token, apiToken: apiTokenSummary } });
        homes.answer(homeId, '/v1/auth/api-tokens/list', { body: { tokens: [apiTokenSummary] } });
        homes.answer(homeId, '/v1/auth/api-tokens/revoke', { body: { revoked: true } });
        homes.answer(homeId, '/v1/auth/api-tokens/revoke-all', { body: { revokedCount: 1 } });
        const ctx = { ...context(), actionCaller: { kind: 'host' as const }, authority: 'present_user' as const };
        await expect(executor.execute('account.apiTokens.create', input, ctx)).resolves.toEqual({ ok: true, result: { token, apiToken: apiTokenSummary } });
        await expect(executor.execute('account.apiTokens.list', {}, ctx)).resolves.toEqual({ ok: true, result: { tokens: [apiTokenSummary] } });
        await expect(executor.execute('account.apiTokens.revoke', { tokenId: apiTokenSummary.tokenId }, ctx)).resolves.toEqual({ ok: true, result: { revoked: true } });
        await expect(executor.execute('account.apiTokens.revokeAll', {}, ctx)).resolves.toEqual({ ok: true, result: { revokedCount: 1 } });
        expect(homes.requestsFor('/v1/auth/api-tokens/create')[0]?.input).toMatchObject(input);
        for (const request of homes.requests.filter(({ path }) => path.startsWith('/v1/auth/api-tokens/'))) {
            expect(request.serverId).toBe(homeId);
            expect(request.input).not.toHaveProperty('accountId');
        }
    });
    it('preserves the canonical Action preparation lifecycle for current-Account API-token Actions', async () => {
        homes.answer(homeId, '/v1/auth/api-tokens/list', { body: { tokens: [apiTokenSummary] } });
        const prepared = await executor.prepare('account.apiTokens.list', {}, { ...context(), actionCaller: { kind: 'host' } });
        expect(prepared.kind).toBe('ready');
        expect(homes.requestsFor('/v1/auth/api-tokens/list')).toEqual([]);
        if (prepared.kind !== 'ready') throw new Error('expected_ready_action');
        await expect(prepared.invocation.run()).resolves.toEqual({ ok: true, result: { tokens: [apiTokenSummary] } });
    });
    it.each([
        { decision: 'allow', errorCode: 'permission_actor_unattributable' },
        { decision: 'deny', errorCode: 'permission_request_not_found' },
        { decision: 'abort', errorCode: 'permission_response_invalid' },
    ] as const)('preserves a refused $decision response without optimistic settlement ($errorCode)', async ({ decision, errorCode }) => {
        const { getStorage } = await import('@/sync/domains/state/storage');
        await connectPermissionTransport();
        getStorage().setState(state => ({ sessions: {
            ...state.sessions,
            s1: { ...state.sessions.s1, thinking: true },
        } }));
        const before = getStorage().getState().sessions.s1;
        rpcResult = { ok: false, errorCode, requestId: 'req-1' };
        await expect(executor.execute('session.permission.respond', {
            sessionId: 's1', requestId: 'req-1', turnId: 'turn-1', decision,
        }, context())).resolves.toMatchObject({ ok: false, errorCode });
        // Presence subscriptions may accompany connection setup; only the
        // permission RPC is allowed here, never a composed abort after refusal.
        expect(outgoing.filter(request => typeof request.method === 'string')).toEqual([
            expect.objectContaining({ method: 's1:' + RPC_METHODS.SESSION_PERMISSION_RESPOND, params: expect.objectContaining({ id: 'req-1', turnId: 'turn-1', approved: decision === 'allow' }) }),
        ]);
        expect(getStorage().getState().sessions.s1).toBe(before);
    });
    it.each(['permission', 'user-action'] as const)('refuses an unapplied %s response before local recovery or composed abort', async family => {
        const { getStorage } = await import('@/sync/domains/state/storage');
        const store = getStorage();
        store.getState().applySessions([{ ...store.getState().sessions.s1, thinking: true }]);
        store.getState().markSessionOptimisticThinking('s1');
        const original = store.getState().sessions.s1;
        rpcResult = { ok: false, errorCode: 'permission_request_not_found', requestId: 'missing-request' };
        const { sessionRespondToPermission, sessionAllowWithAnswers } = await import('../sessions');
        const pending = family === 'permission'
            ? sessionRespondToPermission('s1', { id: 'missing-request', approved: false, decision: 'abort' }, { serverId: homeId })
            : sessionAllowWithAnswers('s1', 'missing-request', { question: ['answer'] }, { serverId: homeId });
        await expect(pending).rejects.toMatchObject({ rpcErrorCode: 'permission_request_not_found' });
        expect(store.getState().sessions.s1).toBe(original);
        expect(outgoing.map(request => request.method)).toEqual(['s1:' + (family === 'permission'
            ? RPC_METHODS.SESSION_PERMISSION_RESPOND : RPC_METHODS.SESSION_USER_ACTION_ANSWER)]);
    });
    it('projects successful void permission RPC responses through the canonical Action output', async () => {
        await connectPermissionTransport();
        rpcResult = undefined;
        await expect(executor.execute('session.permission.respond', { sessionId: 's1', requestId: 'req-1', decision: 'allow' }, context()))
            .resolves.toEqual({ ok: true, result: { ok: true } });
    });
    it.each(['permission', 'user-action'] as const)('retains an unconfirmed %s answer when the transport loses its typed reply', async family => {
        await connectPermissionTransport();
        // An untyped failed acknowledgement cannot establish whether the responder applied the answer.
        rpcAcknowledgement = { ok: false, error: 'Reply unavailable' };
        const result = family === 'permission'
            ? executor.execute('session.permission.respond', {
                sessionId: 's1', requestId: 'req-1', turnId: 'turn-1', decision: 'approved',
            }, context())
            : executor.execute('session.user_action.answer', {
                sessionId: 's1', requestId: 'req-1', answers: [{ question: 'Continue?', values: ['Yes'] }],
            }, context());
        await expect(result).resolves.toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN });
        expect(outgoing.filter(request => request.method === 's1:' + (family === 'permission'
            ? RPC_METHODS.SESSION_PERMISSION_RESPOND : RPC_METHODS.SESSION_USER_ACTION_ANSWER)))
            .toHaveLength(1);
    });
    it('preserves a permission transport refusal that proves the answer was not applied', async () => {
        await connectPermissionTransport();
        rpcAcknowledgement = { ok: false, error: 'No responder', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE };
        await expect(executor.execute('session.permission.respond', {
            sessionId: 's1', requestId: 'req-1', decision: 'approved',
        }, context())).resolves.toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
    });
    it.each(['permission', 'user-action'] as const)('retains an unconfirmed %s answer when its issued request is cancelled', async family => {
        await connectPermissionTransport();
        const controller = new AbortController();
        rpcAcknowledgement = new Promise(() => {});
        const pending = family === 'permission'
            ? executor.execute('session.permission.respond', {
                sessionId: 's1', requestId: 'req-1', turnId: 'turn-1', decision: 'approved',
            }, { ...context(), signal: controller.signal })
            : executor.execute('session.user_action.answer', {
                sessionId: 's1', requestId: 'req-1', answers: [{ question: 'Continue?', values: ['Yes'] }],
            }, { ...context(), signal: controller.signal });
        const method = 's1:' + (family === 'permission'
            ? RPC_METHODS.SESSION_PERMISSION_RESPOND : RPC_METHODS.SESSION_USER_ACTION_ANSWER);
        await vi.waitFor(() => expect(outgoing.filter(request => request.method === method)).toHaveLength(1));
        controller.abort();
        const result = await pending;
        expect(result).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN });
        if (result.ok) throw new Error('Expected an unconfirmed answer');
        const { readPermissionActionDisposition } = await import('@/components/tools/shell/permissions/permissionActionFailure');
        expect(readPermissionActionDisposition({ code: result.errorCode })).toBe('outcomeUnknown');
        expect(outgoing.filter(request => request.method === method)).toHaveLength(1);
    });
    it('keeps an applied permission receipt when its Account retires as the reply is admitted', async () => {
        await connectPermissionTransport();
        const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        // Retire the real Account at the network reply's admission checkpoint,
        // after the transport received it, rather than mocking a currentness owner.
        rpcResult = { get ok() { retireActiveServerAccountScopeLifetime(); return true; } };
        await expect(executor.execute('session.permission.respond', {
            sessionId: 's1', requestId: 'req-1', decision: 'approved', mode: 'acceptEdits',
        }, context())).resolves.toEqual({ ok: true, result: { ok: true } });
        const { getStorage } = await import('@/sync/domains/state/storage');
        expect(getStorage().getState().sessions.s1?.permissionMode).not.toBe('acceptEdits');
    });
    it('routes owner remote grant management through the canonical session Action transport', async () => {
        rpcResult = { grants: [], nextCursor: null };
        await expect(executor.execute('session.permission.remote.grants.list', { sessionId: 's1' }, context()))
            .resolves.toEqual({ ok: true, result: { grants: [], nextCursor: null } });
        expect(outgoing.at(-1)).toMatchObject({ method: 's1:session.permission.remote.grants.list', params: { sessionId: 's1', limit: 50 } });
    });
    it.each(['applied', 'refused'] as const)('routes user-action answers through the canonical session user-action RPC method (%s)', async outcome => {
        rpcResult = outcome === 'refused'
            ? { ok: false, errorCode: 'permission_response_invalid', requestId: 'user-action-1' } : undefined;
        const result = await executor.execute('session.user_action.answer', {
            sessionId: 's1', requestId: 'user-action-1', decision: 'approve',
            answers: [{ question: 'Where should this run?', values: ['Washington, D.C.', 'Virginia', 'A custom, exact answer'] }],
            reason: ' approved from UI ', updatedPermissions: { allowedTools: ['shell'] },
        }, context());
        expect(result).toEqual(outcome === 'refused'
            ? { ok: false, errorCode: 'permission_response_invalid', error: 'permission_response_invalid' }
            : { ok: true, result: { ok: true } });
        expect(outgoing.at(-1)).toMatchObject({ method: 's1:' + RPC_METHODS.SESSION_USER_ACTION_ANSWER, params: {
            id: 'user-action-1', approved: true, answers: { 'Where should this run?': ['Washington, D.C.', 'Virginia', 'A custom, exact answer'] },
            reason: 'approved from UI', updatedPermissions: { allowedTools: ['shell'] },
        } });
    });
    it('routes session.message.send through the active readiness barrier', async () => {
        const features = createRootLayoutFeaturesResponse({ capabilities: {
            serverIdentity: { serverIdentityId: 'srv_approval_home' },
            session: { ...DEFAULT_SESSION_CAPABILITIES, pendingInput: { protocolVersion: PENDING_INPUT_PROTOCOL_VERSION_V4 } },
        } });
        homes.answer(homeId, '/v1/features', { body: features });
        homes.answer(homeId, '/v1/features/authenticated', { body: features });
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        primeServerFeaturesSnapshot({ serverId: homeId, snapshot: { status: 'ready', features } });
        homes.answer(homeId, 'POST /v2/sessions/s1/pending', { select: (input) => {
            if (!input || typeof input !== 'object') throw new Error('Expected Pending enqueue request');
            return { body: { didWrite: true, pendingCount: 1, pendingVersion: 1,
                requestedAction: Reflect.get(input, 'requestedAction'),
                pending: { localId: Reflect.get(input, 'localId'), content: Reflect.get(input, 'content'),
                    status: 'queued', position: 1, createdAt: 1, updatedAt: 1,
                    discardedAt: null, discardedReason: null, authorAccountId: 'account-a' } } };
        } });
        const result = await executor.execute('session.message.send', { sessionId: 's1', message: 'Hello from action', localId: 'ui-input-1' }, context());
        expect(result.ok, result.ok ? undefined : `${result.errorCode}: ${result.error}`).toBe(true);
        expect(result).toMatchObject({ ok: true, result: { status: 'accepted', localId: 'ui-input-1' } });
        expect(homes.requestsFor('/v2/sessions/s1/pending')[0]?.input).toMatchObject({
            localId: 'ui-input-1', requestedAction: { v: 1, kind: 'steer_if_active' },
        });
    });
    it('fails an Account approval with missing Home identity before replay', async () => {
        await expect(executor.execute('approval.request.decide', { artifactId: 'artifact-1', decision: 'approve' }, context()))
            .resolves.toMatchObject({ ok: true, result: { status: 'failed', execution: { ok: false, errorCode: 'approval_stale' } } });
        expectFailedApproval('artifact-1');
    });
    it('requires an exact Home scope before creating a surfaced UI approval', async () => {
        await homes.requireUiApproval(homeId, 'review.start');
        const signedOutHome = await homes.addHome({ name: 'Signed out', serverUrl: 'https://signed-out-approval.test', accountId: null, active: false });
        await expect(executor.execute('review.start', { sessionId: 's1', engineIds: ['codex'], instructions: 'Needs approval' }, {
            surface: 'ui', serverId: signedOutHome,
        })).rejects.toThrow('action_home_signed_out');
        expect(homes.artifacts(signedOutHome).list()).toEqual([]);
        expect(outgoing).toEqual([]);
    });
    it('does not use local Session cache absence to bypass exact-daemon approval replay', async () => {
        // Stop is Machine-placed; title changes now belong to the Account owner.
        await seedApproval('artifact-stop-no-cache', approvalRequest('session.stop'));
        const { getStorage } = await import('@/sync/domains/state/storage');
        getStorage().setState({ sessions: {} });
        await expect(executor.execute('approval.request.decide', { artifactId: 'artifact-stop-no-cache', decision: 'approve' }, context()))
            .resolves.toMatchObject({ ok: true, result: { status: 'failed', execution: { errorCode: 'approval_origin_unavailable' } } });
        expectFailedApproval('artifact-stop-no-cache', 'approval_origin_unavailable');
    });
    it('does not replay an approved MCP stop locally without its exact daemon origin', async () => {
        await seedApproval('artifact-stop', approvalRequest('session.stop'));
        await expect(executor.execute('approval.request.decide', { artifactId: 'artifact-stop', decision: 'approve' }, context()))
            .resolves.toMatchObject({ ok: true, result: { status: 'failed', execution: { errorCode: 'approval_origin_unavailable' } } });
        expectFailedApproval('artifact-stop', 'approval_origin_unavailable');
    });
    it('fails a legacy directory approval safely when immutable execution origin is unavailable', async () => {
        await seedApproval('artifact-directory-spawn', ApprovalRequestSchema.parse({
            v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'mcp' }, requestedSurface: 'mcp',
            actionId: 'session.spawn_new', actionArgs: {
                creationKey: 'api:directory-approval-1', executionTarget: { serverId: homeId, machineId: 'machine-target' },
                directory: '/repo/new-directory', organizationPlacement: { folderId: null, tagIds: [] },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                initialInput: { text: 'Inspect this repository.' },
            },
            sessionCreationDirectoryApproval: { v: 1, executionTarget: { serverId: homeId, machineId: 'machine-target' }, directory: '/repo/new-directory' },
            summary: 'Create session', serverId: homeId,
        }));
        await expect(executor.execute('approval.request.decide', { artifactId: 'artifact-directory-spawn', decision: 'approve' }, context()))
            .resolves.toMatchObject({ ok: true, result: { status: 'failed', execution: { errorCode: 'approval_stale' } } });
        expectFailedApproval('artifact-directory-spawn');
    });
    it('does not let an approval built from a stale open read overwrite a rejection committed before its write', async () => {
        let rejected: unknown;
        homes.artifacts(homeId).beforeNextUpdate(async () => {
            rejected = await executor.execute('approval.request.decide', { artifactId: 'artifact-1', decision: 'reject' }, context());
        });
        const approved = await executor.execute('approval.request.decide', { artifactId: 'artifact-1', decision: 'approve' }, context());
        expect(rejected).toMatchObject({ ok: true, result: { status: 'rejected' } });
        expect(approved).toMatchObject({ ok: false });
        expect(persistedApproval('artifact-1')).toMatchObject({ status: 'rejected', decision: { kind: 'reject' } });
        expect(outgoing).toEqual([]);
    });
    it('routes V2 replay by the current profile while carrying stable Home and immutable origin evidence', async () => {
        homes.answer(homeId, '/v1/machines/machine-exact', { body: { machine: {
            ...createPlainMachineRowFixture({ id: 'machine-exact', accountId: 'account-a' }),
            id: 'machine-exact', kind: 'persistent', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        } } });
        const { replayApprovedApprovalRequestAtExactDaemon } = await import('./defaultActionExecutor');
        await replayApprovedApprovalRequestAtExactDaemon({ artifactId: 'approval-cross-device', executionTarget: {
            serverId: homeId, serverIdentityId: 'srv_approval_home', originServerId: 'creator-local-home', machineId: 'machine-exact',
        } });
        expect(outgoing).toMatchObject([{ method: 'machine-exact:' + RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED,
            timeoutMs: null, params: { artifactId: 'approval-cross-device' } }]);
        expect(homes.requestsFor('/v1/machines/read-batch')[0]?.serverId).toBe(homeId);
    });
    it.each(['cli', 'ui'] as const)('replays an approved daemon-retained plugin install without issuing a second decision Action (%s)', async surface => {
        homes.answer(homeId, '/v1/machines/machine-exact', { body: { machine: {
            ...createPlainMachineRowFixture({ id: 'machine-exact', accountId: 'account-a' }),
            id: 'machine-exact', kind: 'persistent', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        } } });
        const pendingReview = {
            kind: 'reviewRequired' as const,
            reviewKind: 'installation' as const,
            pendingChangeId: 'pending-plugin-install',
            reason: 'firstInstall' as const,
            currentVersion: null,
            authorityExpansion: [],
            review: createPluginInstallationReviewFixture({ pluginId: 'acme.plugin', version: '1.0.0' }),
        };
        const actionArgs = { path: '/plugins/acme', dev: true };
        const target = { kind: 'machine' as const, machineId: 'machine-exact' };
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({
            v: 1, token: 'plugin-install-home-proof', binding: {
                accountId: 'account-a', authentication: { kind: 'account', tokenEpoch: 0 },
                serverIdentityId: 'srv_approval_home', machineId: target.machineId,
                installationId: 'installation-1', custodianAccountId: 'account-a', accountEncryptionMode: 'plain',
                actionId: 'plugins.install', requestId: 'plugin-install-request', target,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({
                    v: 1, requestId: 'plugin-install-request', target, input: actionArgs,
                }),
            },
        });
        await seedApproval('approval-plugin-install', ApprovalRequestSchema.parse({
            v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: surface === 'ui' ? 'system' : 'cli' }, requestedSurface: surface,
            approval: { flow: 'deferred', result: 'optional' },
            executionOriginV1: {
                v: 1, authority: 'present_user', surface, caller: { kind: 'host' },
                serverId: homeId, serverIdentityId: 'srv_approval_home', accountId: 'account-a',
                machineId: 'machine-exact', actionId: 'plugins.install', requestId: 'plugin-install-request',
                target, externalActionExecutionAuthorization: authorization,
                externalActionInputSignature: signExternalActionApprovalInputV1({
                    authorizationToken: authorization.token, actionId: 'plugins.install', input: actionArgs,
                    target, privateKey: installation.secretKey,
                }),
            },
            actionId: 'plugins.install', actionArgs,
            summary: 'Install plugin', preview: { actionId: 'plugins.install',
                actionArgs: { path: '/plugins/acme', dev: true }, summary: 'Install plugin',
                pluginInstall: { permissionsDisclosure: 'daemonEvaluated', pendingReview } },
        }));
        rpcResult = { ok: true, result: { status: 'executed', execution: { ok: true,
            result: { ok: true, kind: 'plugins_install', outcome: 'applied' } } } };
        await expect(executor.execute('approval.request.decide', {
            artifactId: 'approval-plugin-install', decision: 'approve',
        }, context())).resolves.toMatchObject({ ok: true, result: { status: 'executed' } });
        expect(outgoing).toMatchObject([{ method: 'machine-exact:' + RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED,
            params: { artifactId: 'approval-plugin-install' } }]);
        expect(homes.requestsFor('/v1/actions/approval.request.decide')).toEqual([]);
    });
});
