import { describe, expect, it, onTestFinished } from 'vitest';
import nacl from 'tweetnacl';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema, projectExternalActionHttpError } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { upsertServerProfile, setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { captureLazyActionAccountContext } from './actionAccountContext';
import { createUiAccountAction } from './accountActionDeps';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { storage } from '@/sync/domains/state/storage';
import { createWorkflowActionHttpTransport } from '@/dev/testkit/fixtures/workflowActionHttpTransport';
import { createWorkflowInvocationIndexFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { WorkflowInvocationGetResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { admitPresentUserConfirmationV1 } from '../../../../../../packages/protocol/src/actions/executor/approvalReview';
import { bindPresentUserActionConfirmation } from './presentUserConfirmation';
import { createNotificationConfigurationAction } from './notificationConfigurationAction';
import { ApprovalRequestV2Schema, type ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { projectExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';

installApprovalCommonModuleMocks();

async function captureTransportAccount(signal?: AbortSignal) {
    const serverId = 'srv_private_transport';
    const serverUrl = 'https://private-transport.example.test';
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'requester', tokenEpoch: 1,
        provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
    await upsertServerProfile({ serverUrl, name: 'Private transport Home' });
    await setServerProfileIdentityForUrl(serverUrl, serverId);
    expect(await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId }, { token })).toBe(true);
    const account = await captureLazyActionAccountContext(serverId, signal);
    onTestFinished(() => account.dispose());
    return account;
}

describe('private Account Action origination', () => {
    it.each(['owner', 'unknown', 'other_account', 'other_home'] as const)('preserves only qualified host requester attribution (%s)', async scenario => {
        const account = await captureTransportAccount();
        const cause = { requestRef: 'original-user-input',
            requester: scenario === 'unknown' ? null : { accountId: scenario === 'other_account' ? 'other-person' : account.accountId,
                serverId: scenario === 'other_home' ? 'srv_other_home' : account.serverIdentityId! },
            persona: { serverId: account.serverIdentityId!, sessionId: 'original-session' }, origin: null };
        const projected = projectExternalActionRequesterInvocationV1({ actionId: 'session.message.send', account,
            target: { kind: 'machine', machineId: 'original-machine' },
            context: { surface: 'mcp', authority: 'account_automation', actionCaller: { kind: 'host' },
                runtimeAccountId: account.accountId, serverId: account.serverId, serverIdentityId: account.serverIdentityId!,
                actionRequestAttributionV1: cause } });
        if (scenario === 'other_account' || scenario === 'other_home') expect(projected).toBeNull();
        else expect(projected).toMatchObject({ actionRequestAttributionV1: cause });
    });
    it.each(['installed', 'different'] as const)('replays a signed daemon Artifact with the %s signer through the real relay', async signer => {
        const account = await captureTransportAccount();
        const serverIdentityId = account.serverIdentityId!;
        const actionId = 'notifications.webhooks.test';
        const input = { channelId: 'configured-channel' };
        const requestId = 'signed-notification-request';
        const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(37));
        const signingKey = signer === 'installed' ? installation : nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(38));
        const machine = { ...createPlainMachineRowFixture({ id: 'signed-review-machine', accountId: account.accountId }),
            installationId: 'signed-review-installation', installationPublicKey: encodeBase64(installation.publicKey),
            revokedAt: null, replacedByMachineId: null };
        const target = { kind: 'machine' as const, machineId: machine.id };
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'signed-notification-root', binding: {
            accountId: account.accountId, authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId,
            machineId: machine.id, installationId: machine.installationId, custodianAccountId: account.accountId,
            accountEncryptionMode: 'plain', actionId, requestId, target,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId, target, input }),
        } });
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => account.accountId, encryptionMode: 'plain' });
        const initialState = storage.getState();
        onTestFinished(() => storage.setState(initialState, true));
        let accepted = 0;
        let deferred = 0;
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            const artifactResponse = artifacts.handle(path, init);
            if (artifactResponse) return await artifactResponse;
            if (path === '/v1/auth/ping' || path === '/health') return Response.json({});
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
            if (path === `/v1/machines/${machine.id}`) return Response.json({ machine: { ...machine, kind: 'persistent' } });
            if (path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(init?.body,
                id => id === machine.id ? machine : null);
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(JSON.parse(String(init?.body)));
            if (request.envelope.v !== 1) throw new Error('Expected plain Account invocation');
            if (path.endsWith('/execution-authorization')) return Response.json(ExternalActionExecutionAuthorizationV1Schema.parse({
                ...authorization, binding: { ...authorization.binding, requestId: request.envelope.requestId,
                    target: request.envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope) },
            }));
            expect(path).toBe(`/v1/actions/${actionId}`);
            const opened = openExternalActionRequesterAccountContextV1({ authorization: request.executionAuthorization,
                purpose: { kind: 'external_action' }, machineId: machine.id, installationId: machine.installationId,
                serverIdentityId, installationPrivateKey: installation.secretKey, includeInvocation: true });
            if (!opened?.invocation) throw new Error('Expected private invocation');
            expect(opened.invocation).toMatchObject({ surface: 'ui', authority: 'present_user', caller: { kind: 'host' } });
            const admitted = admitPresentUserConfirmationV1(actionId, request.envelope.input, {
                surface: opened.invocation.surface, authority: opened.invocation.authority, actionCaller: opened.invocation.caller,
                presentUserConfirmation: opened.invocation.presentUserConfirmation,
                serverId: account.serverId, serverIdentityId, runtimeAccountId: account.accountId,
                actionRequestId: request.envelope.requestId, externalActionTarget: request.envelope.target,
                externalActionExecutionAuthorization: request.executionAuthorization,
            });
            if (admitted) accepted++; else deferred++;
            return Response.json({ v: 1, actionId, requestId: request.envelope.requestId, execution: admitted
                ? { ok: true, result: { status: 'delivered' } }
                : { ok: false, errorCode: 'approval_request_conflict', error: 'approval_request_conflict' } });
        });
        onTestFinished(resetRuntimeFetch);
        const artifactId = 'signed-webhook-review';
        const producer = createActionExecutor(createActionExecutorBoundaryFixture({
            approvalsCreate: async ({ request }) => {
                const response = await artifacts.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({
                    id: artifactId, header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(request)),
                    body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                }) });
                expect(response?.ok).toBe(true);
                return { artifactId };
            },
        }));
        expect(await producer.execute(actionId, input, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId: account.serverId, serverIdentityId, runtimeAccountId: account.accountId,
            actionRequestId: requestId, defaultSessionId: null, defaultSessionMachineId: machine.id,
            externalActionTarget: target, externalActionExecutionAuthorization: authorization,
            signExternalActionApprovalInput: args => signExternalActionApprovalInputV1({ authorizationToken: args.authorization.token,
                actionId: args.actionId, input: args.input, target: args.target, privateKey: signingKey.secretKey }),
        })).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId } });
        const original = ApprovalRequestV2Schema.parse(JSON.parse(artifacts.readPlainBody(artifactId)!));
        expect(original.executionOriginV1.externalActionExecutionAuthorization).toEqual(authorization);
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const result = await createDefaultActionExecutor().execute('approval.request.decide', { artifactId, decision: 'approve' },
            { surface: 'ui', serverId: account.serverId });
        if (signer === 'installed') {
            expect(result).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true, result: { status: 'delivered' } } } });
            expect({ accepted, deferred }).toEqual({ accepted: 1, deferred: 0 });
        } else {
            expect(result).toMatchObject({ ok: false, errorCode: 'approval_stale' });
            expect({ accepted, deferred }).toEqual({ accepted: 0, deferred: 0 });
        }
        const retained = ApprovalRequestV2Schema.parse(JSON.parse(artifacts.readPlainBody(artifactId)!));
        expect(retained.executionOriginV1).toEqual(original.executionOriginV1);
    });
    it.each([
        { placement: 'explicit', review: 'native' }, { placement: 'automatic', review: 'native' },
        { placement: 'explicit', review: 'native-dialog' }, { placement: 'automatic', review: 'native-dialog' },
        { placement: 'explicit', review: 'artifact' }, { placement: 'automatic', review: 'artifact' },
    ] as const)('carries the admitted $review review through the real relay ($placement placement)', async ({ placement, review }) => {
        const account = await captureTransportAccount();
        const serverIdentityId = account.serverIdentityId!;
        const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(13));
        const machine = { ...createPlainMachineRowFixture({ id: 'reviewed-machine', accountId: account.accountId }),
            installationId: 'reviewed-installation', installationPublicKey: encodeBase64(installation.publicKey) };
        const initialState = storage.getState();
        const visible = createMachineFixture({ id: machine.id, activeAt: Date.now(), access: machine.access });
        storage.setState({ machines: { [machine.id]: visible }, machineListByServerId: { [account.serverId]: [visible] },
            machineListStatusByServerId: { [account.serverId]: 'idle' } });
        onTestFinished(() => storage.setState(initialState, true));
        const actionId = 'notifications.webhooks.test';
        const input = { channelId: 'configured-channel' };
        let accepted = 0;
        let deferred = 0;
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/auth/ping' || path === '/health') return Response.json({});
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(init?.body,
                id => id === machine.id ? machine : null);
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(JSON.parse(String(init?.body)));
            if (request.envelope.v !== 1) throw new Error('Expected plain Account invocation');
            if (path.endsWith('/execution-authorization')) return Response.json(ExternalActionExecutionAuthorizationV1Schema.parse({
                v: 1, token: 'reviewed-root', binding: { accountId: account.accountId, authentication: { kind: 'account', tokenEpoch: 1 },
                    serverIdentityId, machineId: machine.id, installationId: machine.installationId, custodianAccountId: account.accountId,
                    accountEncryptionMode: 'plain', actionId, requestId: request.envelope.requestId, target: request.envelope.target,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope) },
            }));
            expect(path).toBe(`/v1/actions/${actionId}`);
            // HTTP is the boundary. Decode the real private carrier and exercise
            // the receiving review owner; no internal admission helper is mocked.
            const opened = openExternalActionRequesterAccountContextV1({ authorization: request.executionAuthorization,
                purpose: { kind: 'external_action' }, machineId: machine.id, installationId: machine.installationId,
                serverIdentityId, installationPrivateKey: installation.secretKey, includeInvocation: true });
            if (!opened?.invocation) throw new Error('Expected private invocation');
            const admitted = admitPresentUserConfirmationV1(actionId, request.envelope.input, {
                surface: opened.invocation.surface, authority: opened.invocation.authority, actionCaller: opened.invocation.caller,
                presentUserConfirmation: opened.invocation.presentUserConfirmation,
                serverId: account.serverId, serverIdentityId, runtimeAccountId: account.accountId,
                actionRequestId: request.envelope.requestId, externalActionTarget: request.envelope.target,
                externalActionExecutionAuthorization: request.executionAuthorization,
            });
            if (admitted) accepted++; else deferred++;
            return Response.json({ v: 1, actionId, requestId: request.envelope.requestId, execution: { ok: true,
                result: admitted ? { status: 'delivered' } : { kind: 'approval_request_created', artifactId: 'remote-review', actionId } } });
        });
        onTestFinished(resetRuntimeFetch);
        let stored: ApprovalRequestV2 | null = null;
        const execute = createActionExecutor(createActionExecutorBoundaryFixture({
            notificationConfigurationAction: createNotificationConfigurationAction(account),
            // The person's native dialog is the system boundary; policy and relay admission stay real.
            presentUserActionConfirmation: async () => true,
            // Persistence is the boundary; use the real Artifact transition/CAS owner.
            approvalsCreate: async ({ request }) => {
                stored = ApprovalRequestV2Schema.parse(structuredClone(request));
                return { artifactId: 'webhook-review' };
            },
            approvalsGet: async () => structuredClone(stored),
            approvalsUpdate: async ({ request }) => {
                if (!stored) throw new Error('Missing review');
                const next = ApprovalRequestV2Schema.parse(request);
                const transition = decideApprovalRequestTransition(stored, next);
                if (!transition.ok) return transition;
                stored = structuredClone(next);
                return { ok: true };
            },
            isApprovalExecutionOriginCurrent: async ({ origin, reportStale }) => {
                const { isApprovalExecutionOriginCurrentForAccountContext } = await import('./defaultActionExecutor');
                account.assertCurrent();
                return isApprovalExecutionOriginCurrentForAccountContext({ origin,
                    accountServerId: account.serverId, accountId: account.accountId, reportStale });
            },
        }), { confirmUiDefault: true });
        const context = bindPresentUserActionConfirmation(actionId, input, {
            surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: account.serverId,
            serverIdentityId, runtimeAccountId: account.accountId, actionRequestId: 'reviewed-diagnostic',
            defaultSessionId: null,
            ...(placement === 'explicit' ? { externalActionTarget: { kind: 'machine' as const, machineId: machine.id } } : {}),
        });
        if (review === 'native') {
            expect(await execute.execute(actionId, input, context)).toEqual({ ok: true, result: { status: 'delivered' } });
        } else if (review === 'native-dialog') {
            expect(await execute.execute(actionId, input, { ...context, presentUserConfirmation: undefined }))
                .toEqual({ ok: true, result: { status: 'delivered' } });
        } else {
            const askContext = { ...context, presentUserConfirmation: undefined,
                actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {
                    [actionId]: { approvalRequiredSurfaces: ['ui'] },
                } }) };
            expect(await execute.execute(actionId, input, askContext)).toMatchObject({ ok: true,
                result: { kind: 'approval_request_created', artifactId: 'webhook-review' } });
            expect(await execute.execute('approval.request.decide', { artifactId: 'webhook-review', decision: 'approve' }, askContext))
                .toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true, result: { status: 'delivered' } } } });
        }
        expect({ accepted, deferred }).toEqual({ accepted: 1, deferred: 0 });
        // Automation has no native review: preserve the pending approval rather
        // than claiming a network outage or pretending the test was delivered.
        expect(await createNotificationConfigurationAction(account)({ actionId, input, context: {
            ...context, presentUserConfirmation: undefined, surface: 'agent', authority: 'account_automation',
        } })).toEqual({ kind: 'approval_request_created', artifactId: 'remote-review', actionId });
        expect({ accepted, deferred }).toEqual({ accepted: 1, deferred: 1 });
    });
    it.each([
        { workspaceWrites: 'deny' as const },
        { workspaceWrites: 'deny' as const, agentStartWorkspaceWrites: 'allow' as const },
        { workspaceWrites: 'allow' as const, agentStartWorkspaceWrites: 'deny' as const },
    ])('preserves bounded Account provenance and the stricter workspace policy %#', async workspacePolicy => {
        const { createUiAccountActionTransport } = await import('./accountActionTransport');
        const caller = { kind: 'plugin' as const, pluginId: 'happier.triage', contributionLocalId: 'sessions/run-configured-v1',
            occurrenceId: '["@happier-dev/plugins-triage","happier.triage","0.0.0"]' };
        const mountedCaller = { ...caller, pluginVersion: '0.0.0', contributionQualifiedId: 'happier.triage/sessions/run-configured-v1',
            originSurface: 'ui' as const, initiatingCaller: { kind: 'host' as const } };
        const input = { message: 'Review requested' };
        const account = await captureTransportAccount();
        const execute = createUiAccountActionTransport({ account,
            resolveFallbackMachineId: () => 'machine', transport: async request => {
                expect(request.invocation).toEqual({ caller, surface: 'plugin', authority: 'account_automation',
                    callerPermissionMode: 'read-only', callerInputConstraints: { models: null, permissionModes: ['read-only'] }, workspaceWrites: 'deny' });
                expect(request.payload).toEqual(input);
                return { ok: true, result: { attemptedChannels: 1, deliveredChannels: 1 } };
            } });
        expect(await execute({ actionId: 'notifications.notify_me', input, context: { serverId: account.serverId, runtimeAccountId: account.accountId,
            surface: 'plugin', authority: 'account_automation', actionCaller: mountedCaller, callerPermissionMode: 'read-only',
            callerInputConstraints: { models: null, permissionModes: ['read-only'] }, ...workspacePolicy } }))
            .toEqual({ ok: true, result: { attemptedChannels: 1, deliveredChannels: 1 } });
    });
    it.each(['session.message.send', 'action.spec.get'] as const)('settles a late %s receipt under the real Account policy', async actionId => {
        const { createUiAccountActionTransport } = await import('./accountActionTransport');
        const presentation = new AbortController();
        const account = await captureTransportAccount(presentation.signal);
        const receipt = { acknowledged: true };
        const execute = createUiAccountActionTransport({ account, resolveFallbackMachineId: () => 'machine',
            transport: async () => { presentation.abort(); return receipt; } });
        const result = await execute({ actionId, input: {}, context: { serverId: account.serverId, runtimeAccountId: account.accountId,
            surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, signal: presentation.signal } });
        expect(result).toEqual(actionId === 'session.message.send' ? receipt
            : { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' });
    });
    it('preserves the bound Home admission refusal through the real UI Account relay', async () => {
        const account = await captureTransportAccount();
        if (!account.serverIdentityId) throw new Error('Expected captured Home identity');
        const serverIdentityId = account.serverIdentityId;
        const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(11));
        const machine = { ...createPlainMachineRowFixture({ id: 'e8ba6137-c57d-49cb-a517-91498c91de02', accountId: account.accountId }),
            installationId: 'installation', installationPublicKey: encodeBase64(installation.publicKey) };
        const actionId = 'workflow.run.invocations.get';
        const input = { runId: 'f132a063-1031-4a7c-8c92-01d0fa231203', invocationId: '34141d15-4f5e-4315-bf1b-ddfaa6ccd42c' };
        const nativeResult = WorkflowInvocationGetResultV1Schema.parse({ invocation: {
            index: createWorkflowInvocationIndexFixture({ id: input.invocationId, runId: input.runId }),
            progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'step-2', scope: [] },
                blockKind: 'step', attempt: '0', logicalInvocationRecordId: input.invocationId }, parentRevision: 1,
        } });
        const invocation = { caller: { kind: 'host' as const }, surface: 'ui' as const, authority: 'present_user' as const };
        const http = createWorkflowActionHttpTransport({ accountId: () => account.accountId,
            fixtureResponse: async () => { throw new Error('Unexpected Workflow storage request'); } });
        let responseKind: 'admitted' | 'refused' | 'unauthenticated' | 'misbound' | 'malformed' = 'admitted';
        let actionRequests = 0;
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(init?.body,
                id => id === machine.id ? machine : null);
            if (!path.startsWith('/v1/actions/')) return http.fetch(url, init);
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(JSON.parse(String(init?.body)));
            expect(request.envelope.input).toEqual(input);
            if (path.endsWith('/execution-authorization')) {
                if (responseKind !== 'admitted') {
                    const refusal = projectExternalActionHttpError(responseKind === 'unauthenticated' ? 'invalid_token' : 'target_unavailable',
                        responseKind === 'misbound' ? 'another-request' : request.envelope.requestId);
                    return Response.json(responseKind === 'malformed' ? { ...refusal.payload, privateDiagnostic: 'not-public' } : refusal.payload,
                        { status: refusal.statusCode });
                }
                return Response.json(ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-root', binding: {
                    accountId: account.accountId, authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId,
                    machineId: machine.id, installationId: machine.installationId, custodianAccountId: account.accountId,
                    accountEncryptionMode: 'plain', actionId, requestId: request.envelope.requestId, target: request.envelope.target,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
                } }));
            }
            expect(path).toBe(`/v1/actions/${actionId}`);
            expect(openExternalActionRequesterAccountContextV1({ authorization: request.executionAuthorization,
                purpose: { kind: 'external_action' }, machineId: machine.id, installationId: machine.installationId,
                serverIdentityId, installationPrivateKey: installation.secretKey, includeInvocation: true }))
                .toEqual({ credentials: { token: account.credentials.token }, invocation });
            actionRequests += 1;
            return Response.json({ v: 1, actionId, requestId: request.envelope.requestId, execution: { ok: true, result: nativeResult } });
        });
        onTestFinished(resetRuntimeFetch);
        const execute = createUiAccountAction({ account });
        const call = () => execute({ actionId, input, context: { serverId: account.serverId, runtimeAccountId: account.accountId,
            externalActionTarget: { kind: 'machine', machineId: machine.id }, actionRequestId: 'workflow-read',
            surface: invocation.surface, actionCaller: invocation.caller, authority: invocation.authority } });
        expect(await call()).toEqual(nativeResult);
        responseKind = 'refused';
        expect(await call()).toEqual({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' });
        responseKind = 'unauthenticated';
        expect(await call()).toEqual({ ok: false, errorCode: 'invalid_token', error: 'invalid_token' });
        for (const kind of ['misbound', 'malformed'] as const) {
            responseKind = kind;
            expect(await call()).toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
        }
        expect(actionRequests).toBe(1);
        const { createFrontDoorActionExecute } = await import('./frontDoorRuntimeActionExecutor');
        const frontDoor = createFrontDoorActionExecute(undefined, { workflowAction: args => execute(args) });
        const frontDoorCall = () => frontDoor(actionId, input, { surface: 'ui', serverId: account.serverId,
            expectedAccountId: account.accountId, externalActionTarget: { kind: 'machine', machineId: machine.id } });
        responseKind = 'admitted';
        expect(await frontDoorCall()).toEqual({ ok: true, result: nativeResult });
        for (const [kind, errorCode] of [['unauthenticated', 'invalid_token'], ['misbound', 'admission_unavailable']] as const) {
            responseKind = kind;
            expect(await frontDoorCall()).toMatchObject({ ok: false, errorCode });
        }
        expect(actionRequests).toBe(2);
    });

    it.each(['requester', 'foreign-custodian'])('retains bounded Plugin provenance at %s custody', async custodianAccountId => {
        const serverId = `srv_private_${custodianAccountId}`;
        const serverUrl = `https://private-${custodianAccountId}.example.test`;
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'requester', tokenEpoch: 1,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
        await upsertServerProfile({ serverUrl, name: 'Private Action Home' });
        await setServerProfileIdentityForUrl(serverUrl, serverId);
        expect(await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId }, { token })).toBe(true);
        const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
        const invocation = { caller: { kind: 'plugin' as const, pluginId: 'happier.test', contributionLocalId: 'switch', occurrenceId: 'occurrence' },
            surface: 'plugin' as const, authority: 'account_automation' as const, callerPermissionMode: 'read-only' as const,
            callerInputConstraints: { models: null, permissionModes: ['read-only' as const] }, workspaceWrites: 'deny' as const,
            defaultSessionId: 'invoking-session' };
        const input = { sessionId: 'source', expectedCurrentAgentId: 'claude', selection: { v: 1, agentId: 'codex' },
            input: { localId: 'retained', text: 'Expanded prompt', meta: { displayText: 'Attachment' } } };
        const machine = { ...createPlainMachineRowFixture({ id: 'machine', accountId: custodianAccountId }), active: false,
            installationId: 'installation', installationPublicKey: encodeBase64(installation.publicKey),
            access: { custodian: { accountId: custodianAccountId, displayName: custodianAccountId },
                role: 'use' as const, resourceMode: 'plain' as const, accessState: 'ready' as const } };
        let admitted = false;
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            expect(new URL(String(url)).origin).toBe(serverUrl);
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(init?.body,
                id => id === machine.id ? machine : null);
            expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(JSON.parse(String(init?.body)));
            if (request.envelope.v !== 1) throw new Error('Expected the keyless Plain Account envelope');
            expect(request.envelope.input).toEqual(input);
            expect(request.envelope.target).toEqual({ kind: 'machine', machineId: 'machine', project: { machineId: 'machine', directory: '/repo' } });
            if (path.endsWith('/execution-authorization')) return Response.json(ExternalActionExecutionAuthorizationV1Schema.parse({
                v: 1, token: 'home-root', binding: { accountId: 'requester', authentication: { kind: 'account', tokenEpoch: 1 },
                    serverIdentityId: serverId, machineId: 'machine', installationId: 'installation', custodianAccountId,
                    accountEncryptionMode: 'plain', actionId: 'session.agent.transition', requestId: request.envelope.requestId,
                    target: request.envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope) } }));
            expect(path).toBe('/v1/actions/session.agent.transition');
            expect(JSON.stringify(request)).not.toContain(token);
            expect(JSON.stringify(request)).not.toContain('callerPermissionMode');
            expect(openExternalActionRequesterAccountContextV1({ authorization: request.executionAuthorization,
                purpose: { kind: 'external_action' }, machineId: 'machine', installationId: 'installation', serverIdentityId: serverId,
                installationPrivateKey: installation.secretKey, includeInvocation: true })).toEqual({ credentials: { token }, invocation });
            admitted = true;
            return Response.json({ v: 1, actionId: 'session.agent.transition', requestId: request.envelope.requestId,
                execution: { ok: true, result: { type: 'rejected', code: 'unsupported_operation', sourceEffect: 'none' } } });
        });
        onTestFinished(resetRuntimeFetch);
        const account = await captureLazyActionAccountContext(serverId);
        onTestFinished(() => account.dispose());
        const result = await createUiAccountAction({ account })({ actionId: 'session.agent.transition', input: { ...input, optional: undefined }, context: {
            serverId, runtimeAccountId: account.accountId, externalActionTarget: { kind: 'machine', machineId: 'machine', project: { machineId: 'machine', directory: '/repo' } },
            actionRequestId: 'request', actionCaller: invocation.caller, surface: invocation.surface, authority: invocation.authority,
            callerPermissionMode: invocation.callerPermissionMode, callerInputConstraints: invocation.callerInputConstraints,
            workspaceWrites: invocation.workspaceWrites, defaultSessionId: invocation.defaultSessionId,
        } });
        expect(result).toEqual({ type: 'rejected', code: 'unsupported_operation', sourceEffect: 'none' });
        expect(admitted).toBe(true);
    });

    it.each([
        {},
        { surface: 'ui', authority: 'present_user' },
        { surface: 'plugin', authority: 'present_user', actionCaller: { kind: 'plugin', pluginId: 'happier.test', contributionLocalId: 'switch' } },
        { surface: 'api', authority: 'account_automation', actionCaller: { kind: 'host' }, externalActionCredential: {
            accountId: 'requester', principalId: 'api-principal', credentialId: 'api-credential', grant: { v: 1 } } },
    ])('refuses absent or invalid origin before Account transport %#', async origin => {
        let issued = false;
        const { createUiAccountActionTransport } = await import('./accountActionTransport');
        const account = await captureTransportAccount();
        const execute = createUiAccountActionTransport({ account,
            resolveFallbackMachineId: () => 'machine', transport: async () => { issued = true; return { ok: true }; } });
        // Malformed host-private ingress is a boundary fixture, deliberately outside the valid context type.
        const context = { ...origin, serverId: account.serverId, runtimeAccountId: account.accountId } as ActionExecutorContext;
        expect(await execute({ actionId: 'session.agent.transition', input: {}, context }))
            .toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
        expect(issued).toBe(false);
    });
});
