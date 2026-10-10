import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalRequestSchema } from '@happier-dev/protocol';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import tweetnacl from 'tweetnacl';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema,
    ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
// Physical Machine dispatch is outside this process. Policy, original-Home
// capture, C41 reads, preview construction and Artifact custody stay real.
const machineDispatch = vi.hoisted(() => vi.fn());
const requesterConsent = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm: requesterConsent } }).module;
});
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineDispatch,
}));
const { createFrontDoorActionExecute } = await import('./frontDoorRuntimeActionExecutor');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { captureLazyActionAccountContext } = await import('./actionAccountContext');

describe('requester credential disclosure at the human Action front door', () => {
    beforeEach(async () => { await harness.reset(); machineDispatch.mockReset(); requesterConsent.mockReset(); });
    afterEach(() => standardCleanup());

    it.each(['accept', 'missing-key', 'lost-home', 'retire', 'substituted-origin'] as const)('uses fresh Bob private custody for an original native Ask decision (%s)', async scenario => {
        const homeId = 'srv_native_decision_requester';
        const serverUrl = 'https://native-decision-requester.test';
        const serverId = await harness.addHome({ name: 'Requester Home', serverUrl, serverIdentityId: homeId,
            accountId: 'bob', currentAccount: true });
        const token = harness.findByServerUrl(serverUrl)?.token;
        if (!token) throw new Error('Missing Bob credentials');
        const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
        const machineId = 'alice-controller';
        harness.answer(serverId, '/v1/machines', { body: [{ id: machineId, kind: 'persistent', active: true,
            installationId: 'alice-installation', ...(scenario === 'missing-key' ? {} : { installationPublicKey: encodeBase64(installation.publicKey) }),
            revokedAt: null, replacedByMachineId: null, dataEncryptionKey: null, runnerContentKeyBinding: null,
            access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } }] });
        const actionId = 'machines.managed.rebuild';
        const nativeInput = { homeId, managedMachineId: 'alice-child', kind: 'rebuild', expectedRevision: 4,
            reviewedEffectDigest: 'a'.repeat(64) };
        const nativeEnvelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: 'original-native-request',
            target: { kind: 'machine', machineId }, input: nativeInput });
        const originalAccount = scenario === 'substituted-origin' ? 'mallory' : 'bob';
        const nativeRoot = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'original-native-home-root', binding: {
            accountId: originalAccount, authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId: homeId,
            machineId, installationId: 'alice-installation', custodianAccountId: 'alice', accountEncryptionMode: 'plain',
            actionId, requestId: nativeEnvelope.requestId, target: nativeEnvelope.target,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(nativeEnvelope),
        } });
        const request = ApprovalRequestSchema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'system' }, requestedSurface: 'ui', actionId, actionArgs: nativeInput,
            approval: { result: 'required', flow: 'deferred' }, summary: 'Reviewed rebuild',
            executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' },
                serverId, serverIdentityId: homeId, accountId: originalAccount, machineId, target: nativeEnvelope.target,
                actionId, requestId: nativeEnvelope.requestId, externalActionExecutionAuthorization: nativeRoot,
                externalActionInputSignature: 's'.repeat(86) },
        });
        const account = await captureLazyActionAccountContext(serverId);
        let artifactId: string;
        try { artifactId = await account.createArtifact(buildApprovalRequestArtifactHeaderV1(request), JSON.stringify(request)); }
        finally { account.dispose(); }
        requesterConsent.mockResolvedValue(false);
        let boxedDecisions = 0;
        // The mounted handler supplies no id; consume the existing UI host's
        // invocation identity rather than adding a second nonce owner.
        let decisionRequestId: string | undefined;
        harness.answer(serverId, '/v1/actions/approval.request.decide/execution-authorization', { select: async body => {
            const mint = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            expect(mint.envelope.requestId).toBeTruthy();
            decisionRequestId = mint.envelope.requestId;
            expect(mint.envelope).toMatchObject({ requestId: decisionRequestId, target: { kind: 'machine', machineId },
                input: expect.objectContaining({ artifactId, decision: 'approve' }) });
            if (scenario === 'retire') await harness.switchAccount(serverId, 'carol');
            return { body: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fresh-decision-home-root', binding: {
                accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId: homeId,
                machineId, installationId: 'alice-installation', custodianAccountId: 'alice', accountEncryptionMode: 'plain',
                actionId: 'approval.request.decide', requestId: decisionRequestId, target: mint.envelope.target,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(mint.envelope),
            } }) };
        } });
        const nativeResult = { kind: 'conflict', currentRevision: 5 };
        harness.answer(serverId, '/v1/actions/approval.request.decide', { select: body => {
            const carried = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            expect(openExternalActionRequesterAccountContextV1({ authorization: carried.executionAuthorization,
                purpose: { kind: 'external_action' }, machineId, installationId: 'alice-installation', serverIdentityId: homeId,
                installationPrivateKey: installation.secretKey })).toEqual({ token });
            expect(JSON.stringify(carried)).not.toContain(token);
            const stored = JSON.parse(harness.artifacts(serverId).readPlainBody(artifactId) ?? 'null');
            expect(stored).toMatchObject({ status: 'approved', executionOriginV1: {
                requestId: 'original-native-request', externalActionExecutionAuthorization: nativeRoot } });
            expect(JSON.stringify(stored)).not.toContain('requesterAccountContext');
            boxedDecisions += 1;
            return { body: { v: 1, actionId: 'approval.request.decide', requestId: decisionRequestId,
                execution: { ok: true, result: nativeResult } } };
        } });
        machineDispatch.mockResolvedValue({ ok: false, errorCode: 'missing_private_requester', error: 'missing_private_requester' });
        if (scenario === 'lost-home') {
            const { removeServerProfile } = await import('@/sync/domains/server/serverProfiles');
            await removeServerProfile(serverId);
        }
        const pending = createFrontDoorActionExecute(createDefaultActionExecutor())('approval.request.decide',
            { artifactId, decision: 'approve' }, { surface: 'ui', serverId, expectedAccountId: 'bob' });
        if (scenario === 'lost-home') {
            await expect(pending).rejects.toThrow('action_home_not_found');
            expect(machineDispatch).not.toHaveBeenCalled();
            expect(boxedDecisions).toBe(0);
            return;
        }
        const result = await pending;
        expect(requesterConsent).not.toHaveBeenCalled();
        expect(machineDispatch).not.toHaveBeenCalled();
        expect(boxedDecisions, JSON.stringify(result)).toBe(scenario === 'accept' ? 1 : 0);
        if (scenario === 'accept') expect(result).toEqual({ ok: true, result: nativeResult });
        else if (result.ok) expect(result.result).toMatchObject({ status: 'failed', execution: { ok: false } });
        else expect(result.errorCode).toBeTruthy();
    });

    it.each(['ui', 'voice'] as const)('honors an ordinary foreign spawn waiver without a second consent modal (%s)', async surface => {
        const serverId = await harness.addHome({ name: 'Original requester Home', serverUrl: 'https://requester-send.test',
            accountId: 'bob', currentAccount: true });
        const home = harness.findByServerUrl('https://requester-send.test');
        if (!home?.token) throw new Error('Missing original requester credential');
        harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'session.spawn_new': [surface] } },
        } }, version: 1 } });
        harness.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
        const custodian = { accountId: 'alice', displayName: 'Alice' };
        harness.answer(serverId, '/v1/machines/alice-machine/access', { body: {
            machineId: 'alice-machine', custodian,
            access: { custodian, role: 'use', resourceMode: 'plain', accessState: 'ready' },
            canManage: false, grants: [], ownDirectGrant: true, ownAccessSources: [],
        } });
        requesterConsent.mockResolvedValue(false);
        machineDispatch.mockImplementation(async () => {
            return { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' };
        });
        const result = await createFrontDoorActionExecute(createDefaultActionExecutor())('session.spawn_new', {
            executionTarget: { serverId, machineId: 'alice-machine' },
            directory: { kind: 'path', path: '/workspace/project' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        }, { surface, serverId, actionRequestId: `requester-send-${surface}` });
        const reachedRequesterSender = machineDispatch.mock.calls.some(([request]) => request?.payload?.kind === 'requester_session_bootstrap_v1');
        const outcome = result.ok && result.result && typeof result.result === 'object' && 'type' in result.result
            ? result.result.type : result.ok ? 'other_success' : result.errorCode;
        expect(requesterConsent, JSON.stringify({ ok: result.ok, outcome, reachedRequesterSender })).not.toHaveBeenCalled();
        expect(reachedRequesterSender).toBe(true);
        expect(result).toEqual({ ok: true, result: { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' } });
        expect(machineDispatch).toHaveBeenCalledOnce();
    });

    it.each([
        { surface: 'ui', route: 'native' }, { surface: 'voice', route: 'native' },
        { surface: 'ui', route: 'provider' }, { surface: 'ui', route: 'auth-free' },
    ] as const)('discloses the original requester custody before a $surface $route Ask can launch', async ({ surface, route }) => {
        const serverId = await harness.addHome({ name: 'Original requester Home', serverUrl: 'https://requester-disclosure.test',
            accountId: 'bob', currentAccount: true });
        const home = harness.findByServerUrl('https://requester-disclosure.test');
        if (!home?.token) throw new Error('Missing original requester credential');
        harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, actions: { 'session.spawn_new': { approvalRequiredSurfaces: [surface] } } },
        } }, version: 1 } });
        const custodian = { accountId: 'alice', displayName: 'Alice' };
        harness.answer(serverId, '/v1/machines/alice-machine/access', { body: {
            machineId: 'alice-machine', custodian,
            access: { custodian, role: 'use', resourceMode: 'plain', accessState: 'ready' },
            canManage: false, grants: [], ownDirectGrant: true, ownAccessSources: [],
        } });
        const agentTargetKey = 'agent:happier.agent.claude/claude';
        if (route !== 'native') {
            const { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
                ProviderConnectionsCatalogV1Schema } = await import('@happier-dev/protocol/providers/connections/connectionRowsV1');
            const { DaemonProviderModelProjectionResponseV1Schema } = await import('@happier-dev/protocol/rpc');
            const connection = { v: 1, id: 'pc-selected', source: { kind: 'custom', template: {
                v: 1, name: 'Gateway', endpointTemplates: [{ id: 'api', protocol: 'anthropic',
                    baseUrl: 'https://private-provider-endpoint.test', capabilities: {
                        streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown',
                    } }], catalog: { source: 'manual', manualModelPolicy: 'allowed' },
                ...(route === 'provider' ? { credential: { kind: 'apiKey', slotId: 'apiKey', required: true,
                    transports: [{ id: 'runtime-key', protocols: ['anthropic'], uses: ['runtime'], destination: {
                        kind: 'httpHeader', name: 'authorization', format: 'bearer',
                    } }] } } : {}),
            } }, role: 'named', displayName: 'Work', displayNameMode: 'custom', deployment: { kind: 'external' },
                revision: 1, createdAt: 1, updatedAt: 1 };
            const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
                connections: [connection, { ...connection, id: 'pc-unused', displayName: 'Unused neighbor' }],
                secretBindingsByConnectionId: { 'pc-selected': { account: { apiKey: 'happier:shared-secret:v1:private-selected-ref' } },
                    'pc-unused': { account: { apiKey: 'happier:shared-secret:v1:private-unused-ref' } } },
            });
            harness.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
            harness.answer(serverId, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, { body: {
                status: 'present', revision: 1, content: { t: 'plain', v: catalog },
            } });
            const modelProjection = DaemonProviderModelProjectionResponseV1Schema.parse({ status: 'success', agentTargetKey,
                groups: [{ connectionId: 'pc-selected', providerName: 'Gateway', connectionName: 'Work',
                    connectionRole: 'named', connectionDisplayNameMode: 'custom', connectionRevision: 1,
                    modelLoadAction: 'descriptor_absent', authorization: { authorized: true }, manualModelPolicy: 'allowed',
                    supportsFreeformModelIds: true, suppressedConnectedServiceIds: ['anthropic', 'claude-subscription'], rows: [],
                }],
            });
            machineDispatch.mockImplementation(async request => request.method === 'daemon.providers.model.projection'
                ? modelProjection : { ok: false, errorCode: 'unsupported', error: 'unsupported' });
        }
        // A different focused Home must not become the preview's actor or target.
        await harness.addHome({ name: 'Other Home', serverUrl: 'https://requester-disclosure-other.test', accountId: 'carol' });
        const controller = new AbortController();
        const pending = createFrontDoorActionExecute(createDefaultActionExecutor())('session.spawn_new', {
            executionTarget: { serverId, machineId: 'alice-machine' },
            directory: { kind: 'path', path: '/workspace/project' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
            ...(route !== 'native' ? { modelSelection: { v: 1, ref: {
                agentTargetKey, providerConnectionId: 'pc-selected', modelId: 'selected-model',
            }, updatedAt: 1 } } : {}),
            connectedServices: { v: 2, bindingsByServiceId: {
                'happier.agent.claude/anthropic': { source: 'connected', selection: 'profile', profileId: 'private-selected-account' },
                'happier.agent.claude/claude-subscription': { source: 'native' },
            } },
        }, { surface, serverId, actionRequestId: `requester-disclosure-${surface}`, signal: controller.signal });
        try {
            const approval = await waitForHomeGovernance(() => {
                const row = harness.artifacts(serverId).list().find(row => {
                    const body = harness.artifacts(serverId).readPlainBody(row.id);
                    return body !== null && ApprovalRequestSchema.safeParse(JSON.parse(body)).success;
                });
                expect(row).toBeDefined();
                return row!;
            });
            const body = harness.artifacts(serverId).readPlainBody(approval.id);
            const request = ApprovalRequestSchema.parse(JSON.parse(body ?? 'null'));
            expect(request).toMatchObject({ status: 'open', actionId: 'session.spawn_new', preview: {
                requesterCredentialDisclosure: {
                    disposition: 'ordinary_requester', accountId: 'bob', machineId: 'alice-machine',
                    fullSignIn: true, selectedPurposeRuntimeAuth: true, hostCanInspectLocalProcess: true,
                },
            } });
            const { readApprovalPreviewSummary } = await import('@/components/approvals/ApprovalPreviewCard');
            const { t } = await import('@/text');
            // Both the Approval detail and transcript prompt consume this
            // existing summary presenter; safe facts alone are not disclosure.
            const summary = readApprovalPreviewSummary(request.preview);
            expect(summary).toContain(t('machineRequester.fullSignIn', { machine: 'alice-machine' }));
            expect(summary).toContain(t('machineRequester.osVisibility', { owner: 'Alice', machine: 'alice-machine' }));
            if (route === 'native') {
                expect(summary).toContain('Anthropic');
                expect(summary).toContain('Claude');
            } else {
                expect(summary).not.toContain('Anthropic');
                expect(summary).not.toContain('Claude');
                if (route === 'provider') expect(summary).toContain('Gateway · Work');
                else expect(summary).not.toContain('Gateway');
                expect(summary).not.toContain('Unused neighbor');
                expect(summary).not.toContain('private-selected-ref');
                expect(summary).not.toContain('private-provider-endpoint');
            }
            expect(summary).not.toContain('Linear');
            expect(summary).not.toContain('private-selected-account');
            expect(body).not.toContain(home.token);
            expect(body).not.toContain('requesterBootstrap');
            expect(machineDispatch.mock.calls.some(([request]) => request?.payload?.kind === 'requester_session_bootstrap_v1')).toBe(false);
            const reads = harness.requestsFor('/v1/machines/alice-machine/access');
            expect(reads.length).toBeGreaterThan(0);
            expect(reads.every(read => read.serverId === serverId && read.token === home.token)).toBe(true);
            expect(harness.artifacts(harness.findByServerUrl('https://requester-disclosure-other.test')!.serverId).list()).toEqual([]);
        } finally {
            controller.abort();
            await pending;
        }
    });
});
