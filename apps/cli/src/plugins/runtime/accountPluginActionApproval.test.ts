import fastify from 'fastify';
import { join } from 'node:path';
import { Server, type Socket } from 'socket.io';
import { afterEach, expect, it, vi } from 'vitest';
import { ArtifactJsonCreateHttpInputV1Schema, decodePlainArtifactStoredContent, FeaturesResponseSchema,
    sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol';
import { QualifiedConnectedAccountCredentialSnapshotV4Schema, QualifiedConnectedAccountConfigurationSnapshotV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { QualifiedConnectedAccountListResponseV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { normalizeActionsSettingsV1, setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { StoredTargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { PluginAccountStorageMutationRequestV1Schema, PluginAccountStorageMutationResponseV1Schema,
    PluginAccountStorageReadResponseV1Schema } from '@happier-dev/protocol/plugins/data/accountKvV1';
import * as accountChanges from '@/api/observeAccountChanges';
import { readStoredCredentialsForServerId, removeStoredCredentialsForServerId, writeStoredCredentialsForServerId } from '@/persistence';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { registerAccountHomeHttp } from '@/session/actions/widgetApproval.testkit';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { registerAuthoredAccountActionRelease } from './accountPluginActions.testkit';
import { readCurrentAccountPluginExecutionSelection } from './accountPluginActivationSource';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentReadActionInputV1Schema } from '@happier-dev/protocol/plugins/availability';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { PLUGIN_MANIFEST as azureManifest } from '../../../../../packages/plugins/scm-azure-devops/src/manifest';
import { encodeAzureSourceConfiguration } from '../../../../../packages/plugins/scm-azure-devops/src/triage/configuration';
import { normalizeAzureDevOpsBaseUrl } from '../../../../../packages/plugins/scm-azure-devops/src/triage/origin';
import { buildAzureCollisionScope } from '../../../../../packages/plugins/scm-azure-devops/src/triage/identity';
import { AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS } from '../../../../../packages/plugins/scm-azure-devops/src/triage/mutationActions';
import { AZURE_DEVOPS_CONNECTED_ACCOUNT_ID, AZURE_DEVOPS_TRIAGE_PURPOSE } from '../../../../../packages/plugins/scm-azure-devops/src/triage/descriptor';

const provider = vi.hoisted(() => ({ request: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>() }));
// test-policy-boundary: Undici is the provider HTTP transport; Account admission and credential materialization stay real.
vi.mock('undici', async importOriginal => ({ ...await importOriginal<typeof import('undici')>(),
    fetch: (url: string, init?: RequestInit) => provider.request(url, init),
}));

afterEach(() => vi.restoreAllMocks());

it.each([
    { scenario: 'approve', surface: 'cli' },
    { scenario: 'approve', surface: 'agent' },
    { scenario: 'approve', surface: 'mcp' },
    { scenario: 'azure_approve', surface: 'agent' },
    { scenario: 'azure_approve', surface: 'mcp' },
    { scenario: 'machine_provenance', surface: 'cli' },
    { scenario: 'reject', surface: 'cli' },
    { scenario: 'disable', surface: 'cli' },
    { scenario: 'uncertain', surface: 'cli' },
    { scenario: 'cancel', surface: 'cli' },
    { scenario: 'caller_retire', surface: 'cli' },
    { scenario: 'callee_retire_during_caller_read', surface: 'cli' },
    { scenario: 'credential_rotate', surface: 'cli' },
    { scenario: 'credential_rotate_read', surface: 'cli' },
] as const)(
    'keeps public Account Ask in live custody until a separate CLI decides: $surface $scenario', async ({ scenario, surface }) => {
        const app = fastify();
        const sockets = new Server(app.server, { path: '/v1/updates' });
        const registrations = new Map<string, Socket>();
        // Home relays the decision to the original CLI's real live waiter.
        // This network boundary never manufactures a Machine approval owner.
        sockets.on('connection', socket => {
            socket.on(SOCKET_RPC_EVENTS.REGISTER, (packet: { method: string }) => {
                registrations.set(packet.method, socket);
                socket.emit(SOCKET_RPC_EVENTS.REGISTERED, packet);
            });
            socket.on(SOCKET_RPC_EVENTS.UNREGISTER, (packet: { method: string }) => registrations.delete(packet.method));
            socket.on('disconnect', () => {
                for (const [method, owner] of registrations) if (owner === socket) registrations.delete(method);
            });
            socket.on(SOCKET_RPC_EVENTS.CALL, (packet, ack) => {
                const owner = registrations.get(packet.method);
                if (!owner?.connected) return ack({ ok: false, error: 'method_not_found' });
                owner.emit(SOCKET_RPC_EVENTS.REQUEST, { ...packet, callerAuthority: 'present_user' },
                    (result: unknown) => ack({ ok: true, result }));
            });
        });
        const rotatesCredentials = scenario === 'credential_rotate' || scenario === 'credential_rotate_read';
        const azure = scenario === 'azure_approve';
        const nested = scenario === 'caller_retire' || scenario === 'callee_retire_during_caller_read';
        const serverId = rotatesCredentials ? 'account-approval-rotation' : 'account-approval';
        const serverIdentityId = `srv_${serverId}`;
        const accountId = `account-owner-${surface}-${scenario}`;
        const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
            encryption: null, credentialProvenance: 'stored_session' as const };
        const rotateStoredCredentials = () => writeStoredCredentialsForServerId(serverId,
            { ...credentials, token: `${credentials.token}-rotated` });
        const azureProjectRoot = join(import.meta.dirname, '../../../../../packages/plugins/scm-azure-devops');
        const { pluginId, providerPluginId, artifacts, setEnabled, setPluginEnabled } = await registerAuthoredAccountActionRelease(app, accountId,
            { includeAccountProvider: nested, ...(azure ? { primary: {
                manifest: azureManifest, projectRoot: azureProjectRoot, entryPath: join(azureProjectRoot, 'src/accountRuntime.ts'),
                artifactId: 'azure-devops-account-runtime', activateExport: 'activate', manifestExport: null,
            } } : {}) });
        const effectPluginId = nested ? providerPluginId : pluginId;
        if (!effectPluginId) throw new Error('Missing separately authored Account provider');
        const localId = azure ? AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS.abandon : nested ? 'record-source' : 'write';
        const rootSettings = setActionApprovalOverride({
            settings: normalizeActionsSettingsV1(undefined),
            actionId: formatQualifiedPluginActionId({ pluginId, localId }),
            surface, approvalRequired: true,
        });
        const homeFeatures = registerAccountHomeHttp(app, { accountId, serverId: serverIdentityId,
            settings: { actionsSettingsV1: nested ? setActionApprovalOverride({
                settings: rootSettings, actionId: formatQualifiedPluginActionId({ pluginId: effectPluginId, localId: 'record' }),
                surface: 'plugin', approvalRequired: true,
            }) : rootSettings } });
        const features = azure ? FeaturesResponseSchema.parse({ ...homeFeatures, capabilities: {
            ...homeFeatures.capabilities, connectedServices: { qualifiedAccounts: { protocolVersion: 4 } },
        } }) : homeFeatures;
        let approvalArtifactId: string | undefined;
        const readApproval = () => {
            if (!approvalArtifactId) throw new Error('Missing approval Artifact');
            const value = decodePlainArtifactStoredContent(artifacts.read(approvalArtifactId)!.body);
            if (!value || typeof value !== 'object' || !('body' in value) || typeof value.body !== 'string') throw new Error('Missing approval body');
            return StoredTargetActionApprovalRequestV1Schema.parse(JSON.parse(value.body));
        };
        let stored: ReturnType<typeof PluginAccountStorageReadResponseV1Schema.parse> = { status: 'absent' };
        let writes = 0;
        const azureBase = 'https://dev.azure.com/acme';
        const azureOrigin = normalizeAzureDevOpsBaseUrl(azureBase);
        if (!azureOrigin.ok) throw new Error('Invalid Azure fixture base');
        const repositoryId = 'f4b7c1a2-3d4e-4f50-9a6b-7c8d9e0f1a2b';
        const azureAccount = { service: { pluginId, localId: AZURE_DEVOPS_CONNECTED_ACCOUNT_ID }, accountId: 'selected-azure' };
        if (azure) {
            const credentialRevision = 'csr_0123456789ABCDEFGHJKMNPQRS';
            const configurationRevision = 'configuration-1';
            app.get('/v4/connect/qualified/credential', request => {
                expect(request.headers.authorization).toBe(`Bearer ${credentials.token}`);
                return QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: azureAccount,
                    authenticationModeId: 'manual', revisionSemantics: 'revisioned', credentialRevision,
                    configurationRevision, metadata: { scopes: [] },
                    content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain',
                        payload: { v: 1, values: { token: 'azure-private-pat' } }, randomBytes: length => new Uint8Array(length) }),
                });
            });
            app.get('/v4/connect/qualified/configuration', () => QualifiedConnectedAccountConfigurationSnapshotV4Schema.parse({
                target: { kind: 'account', ref: azureAccount }, authenticationModeId: 'manual', revisionSemantics: 'revisioned',
                credentialRevision, configurationRevision,
                configurationContent: sealQualifiedConnectedAccountContentEnvelope({ kind: 'configuration', accountMode: 'plain',
                    payload: { values: { base: azureBase }, secretRefs: {} }, randomBytes: length => new Uint8Array(length) }),
            }));
            app.get('/v4/connect/qualified/accounts', () => QualifiedConnectedAccountListResponseV4Schema.parse({ service: azureAccount.service,
                accounts: [{ ref: azureAccount, authenticationModeId: 'manual', status: 'connected', revisionSemantics: 'revisioned',
                    credentialRevision, configurationRevision, configurationReady: true, scopes: [] }],
            }));
        }
        provider.request.mockReset();
        provider.request.mockImplementation(async (url, init) => {
            expect(azure).toBe(true);
            expect(new URL(url).origin).toBe('https://dev.azure.com');
            expect(new Headers(init?.headers).get('authorization')).toBe(`Basic ${Buffer.from(':azure-private-pat').toString('base64')}`);
            if (new URL(url).pathname.endsWith('/_apis/connectionData')) {
                return Response.json({ authenticatedUser: { id: 'd6245f20-2af8-44f4-9451-8107cb2767db', providerDisplayName: 'Alex' } });
            }
            expect(new URL(url).pathname.toLowerCase()).toMatch(/\/pullrequests\/17$/u);
            if (init?.method === 'PATCH') {
                expect(readApproval().status).toBe('executing');
                expect(JSON.parse(init.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : String(init.body)))
                    .toEqual({ status: 'abandoned' });
                writes++;
            }
            return Response.json({ pullRequestId: 17,
                repository: { id: repositoryId, name: 'payments', project: { id: '5feb1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d', name: 'Payments' },
                    url: `${azureBase}/_apis/git/repositories/${repositoryId}` },
                title: 'Approval custody', status: writes ? 'abandoned' : 'active', isDraft: false,
                createdBy: { id: 'd6245f20-2af8-44f4-9451-8107cb2767db', displayName: 'Alex', uniqueName: 'alex@example.test' },
                creationDate: '2026-08-01T00:00:00Z', sourceRefName: 'refs/heads/feature', targetRefName: 'refs/heads/main',
                mergeStatus: 'succeeded', reviewers: [],
            });
        });
        let rotatedDuringRead = false;
        let retiredCalleeDuringCallerRead = false;
        app.addHook('onSend', async (request, _reply, payload) => {
            if (scenario !== 'callee_retire_during_caller_read' || !approvalArtifactId
                || request.url !== PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read']
                || readApproval().qualifiedActionId !== `${pluginId}/actions/record-source`
                || readApproval().status !== 'executing') return payload;
            const read = PluginAvailabilityIntentReadActionInputV1Schema.parse(request.body);
            if (read.pluginId === pluginId && !retiredCalleeDuringCallerRead) {
                // Disable only the executing callee while the live caller's
                // currentness read settles, regardless of validation order.
                setPluginEnabled(effectPluginId, false);
                retiredCalleeDuringCallerRead = true;
            }
            return payload;
        });
        app.get(`/v1/account/plugin-storage/${effectPluginId}`, async request => {
            if (scenario === 'credential_rotate_read' && !rotatedDuringRead) {
                // The handler has already entered. Home accepts its captured
                // bearer, then the stored sign-in changes before this read ends.
                expect(request.headers.authorization).toBe(`Bearer ${credentials.token}`);
                await rotateStoredCredentials();
                rotatedDuringRead = true;
            }
            return stored;
        });
        app.post(`/v1/account/plugin-storage/${effectPluginId}`, async (request, reply) => {
            if (rotatesCredentials) expect(request.headers.authorization).toBe(`Bearer ${credentials.token}`);
            const mutation = PluginAccountStorageMutationRequestV1Schema.parse(request.body);
            expect(readApproval().status).toBe('executing');
            expect(mutation.expectedRevision).toBe('absent');
            if (!mutation.content) throw new Error('Expected a public fixture write');
            writes++;
            stored = PluginAccountStorageReadResponseV1Schema.parse({ status: 'present', revision: 1, content: mutation.content });
            // The Home may commit and lose its acknowledgement. This must not
            // turn a second approval decision into another write attempt.
            if (scenario === 'uncertain') return reply.code(503).send({ error: 'acknowledgement_lost' });
            return PluginAccountStorageMutationResponseV1Schema.parse({ status: 'updated', revision: 1 });
        });
        const createdApprovals: string[] = [];
        let publishArtifactId: ((id: string) => void) | undefined;
        const nextApprovalArtifact = () => new Promise<string>(resolve => {
            const artifactId = createdApprovals.shift();
            if (artifactId) resolve(artifactId);
            else publishArtifactId = resolve;
        });
        // Account change observation is the external socket adapter. The real
        // Artifact reader, decision writer, approval coordinator and invocation
        // policy remain bound by the normal CLI composition.
        const observers = new Set<Readonly<{ entityId?: string; onChange: () => void }>>();
        vi.spyOn(accountChanges, 'observeAccountChanges').mockImplementation((options, handlers) => {
            const observer = { entityId: options.entityId, onChange: handlers.onChange };
            observers.add(observer);
            return { dispose: async () => { observers.delete(observer); } };
        });
        app.addHook('onSend', async (request, reply, payload) => {
            if (request.method !== 'POST' || reply.statusCode >= 400) return payload;
            const created = request.url === '/v1/artifacts'
                ? ArtifactJsonCreateHttpInputV1Schema.parse(request.body).id : undefined;
            const updated = request.routeOptions.url === '/v1/artifacts/:id'
                ? (request.params as { id: string }).id : undefined;
            const artifactId = created ?? updated;
            if (!artifactId) return payload;
            if (created) {
                if (publishArtifactId) { const publish = publishArtifactId; publishArtifactId = undefined; publish(artifactId); }
                else createdApprovals.push(artifactId);
            }
            for (const observer of observers) {
                if (observer.entityId === undefined || observer.entityId === artifactId) observer.onChange();
            }
            return payload;
        });
        await app.listen({ host: '127.0.0.1', port: 0 });
        const address = app.server.address();
        if (!address || typeof address === 'string') throw new Error('Missing Account Home address');
        const endpoint = `http://127.0.0.1:${address.port}`;
        const restore = installAxiosFastifyAdapter({ app, origin: endpoint });
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(features));
        const controller = new AbortController();
        if (rotatesCredentials) {
            await writeStoredCredentialsForServerId(serverId, credentials);
            expect(await readStoredCredentialsForServerId(serverId)).toEqual(credentials);
        }
        const original = createCliActionExecutorFromCredentials({ credentials, serverId, serverIdentityId,
            serverApiUrl: endpoint,
            ...(scenario === 'machine_provenance' ? { machineId: 'contextual-machine' } : {}),
            ...(rotatesCredentials ? { readCredentials: () => readStoredCredentialsForServerId(serverId) } : {}) });
        let settled = false;
        const invoking = original.execute('action.invoke', { action: { pluginId, localId },
            input: azure ? { v: 1, instance: { v: 1,
                instance: { source: { pluginId, localId: 'azure-devops-forge' }, sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05' },
                binding: { purpose: AZURE_DEVOPS_TRIAGE_PURPOSE, account: azureAccount }, localInstanceKey: azureBase,
                configuration: encodeAzureSourceConfiguration(azureOrigin.origin) },
                localRef: { kindId: 'pull-request', collisionScope: buildAzureCollisionScope({ origin: azureOrigin.origin, repositoryId }), entryId: '17' },
                routingToken: 'acme/Payments/payments',
            } : nested ? { key: 'approved' } : { key: 'approved', value: 'written once' } }, { surface, signal: controller.signal,
            runtimeAccountId: accountId, serverId, serverIdentityId,
            ...(scenario === 'machine_provenance' ? { defaultSessionMachineId: 'contextual-machine' } : {}),
        }).then(result => { settled = true; return result; });
        const deciding = createCliActionExecutorFromCredentials({ credentials, serverId, serverApiUrl: endpoint,
            serverIdentityId });
        const decisionContext = { surface: 'cli' as const, authority: 'present_user' as const,
            runtimeAccountId: accountId, serverId, serverIdentityId };
        const waitForApproval = async () => {
            const artifactId = await Promise.race([nextApprovalArtifact(), invoking.then(result => {
                throw new Error(`Account write settled before approval: ${JSON.stringify(result)}`);
            })]);
            approvalArtifactId = artifactId;
            return artifactId;
        };
        try {
            const artifactId = await waitForApproval();
            expect(settled).toBe(false);
            expect(writes).toBe(0);
            expect(readApproval()).toMatchObject({ status: 'open', approvalInputCustody: 'live_only',
                qualifiedActionId: `${pluginId}/actions/${localId}` });
            if (azure) {
                expect(provider.request).not.toHaveBeenCalled();
                expect(JSON.stringify(readApproval())).not.toContain('azure-private-pat');
            }
            // Provenance survives Machine-free Account custody and must not
            // turn a standalone decision into an attempted Machine replay.
            expect(readApproval().executionOriginV1).toMatchObject({ actionId: 'action.invoke', serverIdentityId });
            if (scenario === 'machine_provenance') expect(readApproval().executionOriginV1?.machineId).toBe('contextual-machine');
            expect(readApproval().replayPlacement).toBeUndefined();
            if (scenario === 'disable') setEnabled(false);
            if (scenario === 'caller_retire') {
                setPluginEnabled(pluginId, false);
                expect(await readCurrentAccountPluginExecutionSelection({ credentials, serverUrl: endpoint, pluginId }))
                    .toMatchObject({ kind: 'unavailable', code: 'plugin_disabled' });
                expect(await readCurrentAccountPluginExecutionSelection({ credentials, serverUrl: endpoint, pluginId: effectPluginId }))
                    .toMatchObject({ kind: 'available' });
            }
            const capturedAccountLifetime = getActiveAccountSettingsSnapshotLifetimeToken();
            const capturedAccountSnapshot = getActiveAccountSettingsSnapshot();
            if (scenario === 'credential_rotate') {
                // Rotate only the real stored credential. Home still accepts
                // the original token and the release/settings remain current.
                await rotateStoredCredentials();
                expect((await readStoredCredentialsForServerId(serverId))?.token).toBe(`${credentials.token}-rotated`);
                expect(await readCurrentAccountPluginExecutionSelection({ credentials, serverUrl: endpoint, pluginId }))
                    .toMatchObject({ kind: 'available' });
            }
            // This standalone public executor gets no plugin registry, replay
            // override, current-intent callback, Machine or shared test harness.
            if (scenario === 'cancel') {
                controller.abort();
                expect(await invoking).toMatchObject({ ok: false, errorCode: 'plugin_action_aborted' });
                // Detaching the original caller leaves history for an explicit
                // public cancellation; it never grants replay of live operands.
                expect(readApproval().status).toBe('open');
            }
            const decisionInput = { artifactId, decision: scenario === 'cancel' ? 'cancel' as const
                : scenario === 'reject' ? 'reject' as const : 'approve' as const };
            const decision = await deciding.execute('approval.request.decide', decisionInput, decisionContext);
            expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true });
            expect(readApproval().executionOriginV1).toMatchObject({ actionId: 'action.invoke', serverIdentityId });
            const result = await invoking;
            if (scenario === 'callee_retire_during_caller_read') {
                expect(retiredCalleeDuringCallerRead).toBe(true);
                expect(await readCurrentAccountPluginExecutionSelection({ credentials, serverUrl: endpoint, pluginId }))
                    .toMatchObject({ kind: 'available' });
                expect(await readCurrentAccountPluginExecutionSelection({ credentials, serverUrl: endpoint, pluginId: effectPluginId }))
                    .toMatchObject({ kind: 'unavailable', code: 'plugin_disabled' });
            }
            if (rotatesCredentials) {
                expect(getActiveAccountSettingsSnapshotLifetimeToken()).toBe(capturedAccountLifetime);
                expect(getActiveAccountSettingsSnapshot()?.scopeKey).toBe(capturedAccountSnapshot?.scopeKey);
                expect(getActiveAccountSettingsSnapshot()?.settings).toEqual(capturedAccountSnapshot?.settings);
                expect((await readStoredCredentialsForServerId(serverId))?.token).toBe(`${credentials.token}-rotated`);
                expect(await readCurrentAccountPluginExecutionSelection({ credentials, serverUrl: endpoint, pluginId }))
                    .toMatchObject({ kind: 'available' });
            }
            if (scenario === 'credential_rotate_read') expect(rotatedDuringRead).toBe(true);
            // An admitted invocation retains its captured Account holder.
            // Disk rotation alone is not sign-out or withdrawal of that holder
            // (AGENTS.md: withdrawal takes effect at the next admission).
            const noEffect = scenario === 'reject' || scenario === 'disable' || scenario === 'cancel'
                || nested;
            expect(writes, JSON.stringify(result)).toBe(noEffect ? 0 : 1);
            if (scenario === 'cancel') {
                expect(result).toMatchObject({ ok: false, errorCode: 'plugin_action_aborted' });
                expect(readApproval().status).toBe('canceled');
                expect(await deciding.execute('approval.request.decide', { artifactId, decision: 'approve' }, decisionContext))
                    .toMatchObject({ ok: false, errorCode: 'approval_not_open' });
            } else if (scenario === 'reject') {
                expect(result).toMatchObject({ ok: false, errorCode: 'plugin_action_current_intent_rejected' });
                expect(readApproval().status).toBe('rejected');
            } else if (scenario === 'disable' || nested) {
                expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'plugin_action_generation_retired' });
                // The parent may have entered before its callee is refused;
                // the parent receipt records that attempt, while writes stays 0.
                expect(readApproval()).toMatchObject({ status: 'failed', execution: { ok: false,
                    effectAttempted: scenario === 'callee_retire_during_caller_read' } });
            } else if (scenario === 'uncertain') {
                expect(result).toMatchObject({ ok: false, errorCode: 'plugin_account_storage_outcome_unknown' });
                expect(readApproval()).toMatchObject({ status: 'failed', execution: { ok: false,
                    errorCode: 'plugin_account_storage_outcome_unknown', effectAttempted: true } });
            } else {
                expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: azure ? { kind: 'applied' } : { version: expect.any(Number) } });
                expect(readApproval()).toMatchObject({ status: 'executed', execution: { ok: true, effectAttempted: true } });
            }
            await deciding.execute('approval.request.decide', decisionInput, decisionContext);
            expect(writes).toBe(noEffect ? 0 : 1);
            if (scenario === 'approve' || scenario === 'uncertain') {
                expect(stored).toMatchObject({ status: 'present', content: { t: 'plain', v: { values: {
                    approved: { value: 'written once' },
                } } } });
            }
        } finally {
            controller.abort();
            await invoking.catch(() => undefined);
            if (rotatesCredentials) await removeStoredCredentialsForServerId(serverId);
            restore();
            await new Promise<void>(resolve => sockets.close(() => resolve()));
            await app.close();
        }
    });
