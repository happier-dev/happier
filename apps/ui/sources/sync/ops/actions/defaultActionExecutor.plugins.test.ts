import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { ExternalActionMachineBootstrapV1Schema, ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema, ExternalActionExecutionAuthorizationV1Schema, ExternalActionExecutionAuthorizationRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { PluginAccountAvailabilityIntentReadResponseV1Schema } from '@happier-dev/protocol/plugins/availability';
import { PluginAccountSettingsMutationRequestV1Schema } from '@happier-dev/protocol/plugins/settings/accountSettingsV1';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createDeferred, renderHook, renderScreen } from '@/dev/testkit';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createPluginInstallationReviewFixture } from '@happier-dev/protocol/testing/pluginInstallationReviewFixture';
import { COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1 } from '@happier-dev/protocol/marketplace/marketplaceSourceRegistryV1';

// The native modal host is a presentation boundary; its review body and
// controls remain the production component.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal'))
    .createModalModuleMock({ renderCustomModals: true }).module);

// Only HTTP, credentials and the disconnected socket boundary are replaced.
// Account capture, encryption, Action policy and root delivery remain real.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { scopedHomeActionExecutor, resetScopedHomeActionExecutorsForTests } = await import('./scopedHomeActionExecutor');
const { scopedPluginSettingsAdapter } = await import('@/sync/domains/plugins/settings/scopedPluginSettingsRuntime');
const { useScopedPluginSettingsProjection } = await import('@/sync/domains/plugins/settings/scopedPluginSettingsProjection');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { replacePluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
const { AgentAddModal } = await import('@/components/settings/agents/add/agentAddModalConfig');
const { CapabilityAddModalBody } = await import('@/components/capabilities/add/CapabilityAddModal');
const { useRegistryItem } = await import('@/registries/useRegistryItem');
const { useAgentAdministrationCatalog } = await import('@/components/settings/agents/collection/useAgentAdministrationCatalog');
function RegistryAgentReadProbe(props: { read: { current: ReturnType<typeof useRegistryItem> | null } }) {
    props.read.current = useRegistryItem({ kind: 'agent', sourceId: COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1,
        itemId: '@acme/coding-agent', version: '1.0.0' });
    return null;
}
let serverId: string;
const installMachineKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(37));
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
beforeEach(async () => {
    resetScopedHomeActionExecutorsForTests();
    await homes.reset();
    await loadSyncSingletonForTests();
    serverId = await homes.addHome({ name: 'Plugin Home', serverUrl: 'https://plugin-actions.test', serverIdentityId: 'srv_plugin_home', accountId: 'owner', currentAccount: true });
    const machineRows = ['admitted', 'other'].map(id => ({ ...ExternalActionMachineBootstrapV1Schema.parse({
        id, kind: 'persistent', active: true, revokedAt: null, replacedByMachineId: null,
        installationId: `${id}-installation`, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, runnerContentKeyBinding: null,
        access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
    }), installationPublicKey: encodeBase64(installMachineKey.publicKey) }));
    homes.answer(serverId, '/v1/machines', { body: machineRows });
    // An external Action's Machine is read by id through the Machine rows reader (a532f4a1e0); the by-id row is a full published row.
    // runnerClaim is bootstrap discovery only; the stored Machine row does not carry it.
    for (const { runnerClaim: _runnerClaim, ...machine } of machineRows) homes.answer(serverId, `/v1/machines/${machine.id}`, { body: {
        machine: { ...createPlainMachineRowFixture({ id: machine.id, accountId: 'owner' }), ...machine },
    } });
    for (const actionId of ['plugins.install', 'plugins.disable'] as const) homes.answer(serverId, `/v1/actions/${actionId}/execution-authorization`, { select: body => {
        const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        return { body: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-signed-install', binding: {
            accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId: 'srv_plugin_home',
            machineId: request.machineId, installationId: `${request.machineId}-installation`, custodianAccountId: 'owner',
            accountEncryptionMode: 'plain', actionId, requestId: request.envelope.requestId,
            target: request.envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        } }) };
    } });
    homes.answer(serverId, '/v1/actions/plugins.list', { select: body => {
        const request = ExternalActionRequestEnvelopeV1Schema.parse(body);
        return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'plugins.list', requestId: request.requestId,
            execution: { ok: true, result: { ok: true, kind: 'plugins_list', plugins: [{ id: 'daemon-owned' }] } },
        }) };
    } });
});
afterEach(async () => {
    await connection?.dispose();
    connection = null;
    await homes.reset();
});

describe('plugin-management Actions in the UI host', () => {
    it('retains an Agent lifecycle invocation and daemon-owned approval instead of creating a local Artifact', async () => {
        const actionId = 'plugins.disable';
        const input = { machineId: 'admitted', pluginId: 'acme.plugin' };
        const approval = ActionApprovalRequestCreatedResultSchema.parse({ kind: 'approval_request_created',
            actionId, artifactId: 'daemon-retained-disable-approval' });
        homes.answer(serverId, `/v1/actions/${actionId}`, { select: body => {
            const carried = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            const request = ExternalActionRequestEnvelopeV1Schema.parse(carried.envelope);
            expect(request.input).toEqual(input);
            expect(openExternalActionRequesterAccountContextV1({ authorization: carried.executionAuthorization,
                purpose: { kind: 'external_action' }, machineId: 'admitted', installationId: 'admitted-installation',
                serverIdentityId: 'srv_plugin_home', installationPrivateKey: installMachineKey.secretKey,
                includeInvocation: true })?.invocation).toMatchObject({ surface: 'agent', authority: 'account_automation', caller: { kind: 'host' } });
            return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId,
                requestId: carried.envelope.requestId, execution: { ok: true, result: approval } }) };
        } });
        expect(await createDefaultActionExecutor().execute(actionId, input, { serverId,
            expectedAccountId: 'owner', surface: 'agent', authority: 'account_automation',
            executionRunTargetMachineId: 'admitted', actionRequestId: 'agent-plugin-disable',
        })).toEqual({ ok: true, result: approval });
        expect(homes.artifacts(serverId).list()).toHaveLength(0);
        expect(homes.requestsFor(`/v1/actions/${actionId}`)).toHaveLength(1);
    });
    it.each(['plugins.enable', 'plugins.disable', 'plugins.rollback', 'plugins.trust.forget',
        'plugins.update_policy.set', 'plugins.uninstall'] as const)('delivers %s to its explicit Machine through the admitted root transport', async actionId => {
        homes.answer(serverId, '/v2/account/settings', { body: { version: 1, content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { [actionId]: ['ui'] } },
        } } } });
        const input = getActionSpec(actionId).inputSchema.parse({ machineId: 'admitted', pluginId: 'acme.plugin',
            ...(actionId === 'plugins.update_policy.set' ? { policy: 'pinned' } : {}) });
        const output = { ok: true, kind: actionId.replaceAll('.', '_'), pluginId: 'acme.plugin', change: { kind: 'committed' } };
        homes.answer(serverId, `/v1/actions/${actionId}`, { select: body => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(body);
            expect(request.target).toEqual({ kind: 'machine', machineId: 'admitted' });
            expect(request.input).toEqual(input);
            return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId, requestId: request.requestId,
                execution: { ok: true, result: output } }) };
        } });
        expect(await createDefaultActionExecutor().execute(actionId, input, {
            serverId, expectedAccountId: 'owner', surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        })).toEqual({ ok: true, result: output });
        expect(getActionSpec(actionId).outputSchema?.safeParse(output).success).toBe(true);
        expect(homes.requestsFor(`/v1/actions/${actionId}`)).toHaveLength(1);
    });
    it.each(['ui', 'agent'] as const)('joins the daemon install approval without a second local Artifact (%s)', async surface => {
        const input = getActionSpec('plugins.install').inputSchema.parse({ machineId: 'admitted', source: {
            kind: 'marketplace', sourceId: COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1,
            pluginId: 'acme.plugin', version: '1.0.0', packageName: '@acme/coding-agent',
        } });
        const approval = ActionApprovalRequestCreatedResultSchema.parse({ kind: 'approval_request_created',
            actionId: 'plugins.install', artifactId: 'daemon-retained-install-approval' });
        const authority = surface === 'ui' ? 'present_user' as const : 'account_automation' as const;
        homes.answer(serverId, '/v1/actions/plugins.install', { select: body => {
            const carried = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
            const request = ExternalActionRequestEnvelopeV1Schema.parse(carried.success ? carried.data.envelope : body);
            expect(request.target).toEqual({ kind: 'machine', machineId: 'admitted' });
            expect(request.input).toEqual(input);
            if (surface === 'agent') {
                if (!carried.success) throw new Error('Expected private invocation custody');
                expect(openExternalActionRequesterAccountContextV1({ authorization: carried.data.executionAuthorization,
                    purpose: { kind: 'external_action' }, machineId: 'admitted', installationId: 'admitted-installation',
                    serverIdentityId: 'srv_plugin_home', installationPrivateKey: installMachineKey.secretKey,
                    includeInvocation: true })?.invocation).toMatchObject({ surface, authority, caller: { kind: 'host' } });
            }
            return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'plugins.install',
                requestId: request.requestId, execution: { ok: true, result: approval } }) };
        } });
        const executor = createDefaultActionExecutor();
        const context = {
            serverId, expectedAccountId: 'owner', surface, authority,
            executionRunTargetMachineId: 'admitted',
            actionRequestId: 'agent-plugin-install',
        };
        expect(await executor.execute('plugins.install', input, context)).toEqual({ ok: true, result: approval });
        const prepared = await executor.prepare('plugins.install', input, context);
        expect(prepared.kind).toBe('ready');
        if (prepared.kind !== 'ready') throw new Error('Expected a deferred public Action invocation');
        expect(await prepared.invocation.run()).toEqual({ ok: true, result: approval });
        expect(homes.artifacts(serverId).list()).toHaveLength(0);
        expect(homes.requestsFor('/v1/actions/plugins.install')).toHaveLength(2);
    });
    it('delegates explicit install approval creation unchanged even when install approval is waived', async () => {
        homes.answer(serverId, '/v2/account/settings', { body: { version: 1, content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'plugins.install': ['ui'] } },
        } } } });
        const input = getActionSpec('approval.request.create').inputSchema.parse({ actionId: 'plugins.install',
            actionArgs: { machineId: 'admitted', source: { kind: 'marketplace', sourceId: COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1,
                pluginId: 'acme.plugin', version: '1.0.0', packageName: '@acme/coding-agent' } },
            summary: 'Review the exact installation', createdBy: { surface: 'system' } });
        homes.answer(serverId, '/v1/actions/approval.request.create', { select: body => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(body);
            expect(request.target).toEqual({ kind: 'machine', machineId: 'admitted' });
            expect(request.input).toEqual(input);
            return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'approval.request.create',
                requestId: request.requestId, execution: { ok: true, result: { artifactId: 'daemon-retained-install-approval' } } }) };
        } });
        expect(await createDefaultActionExecutor().execute('approval.request.create', input, {
            serverId, expectedAccountId: 'owner', surface: 'ui', authority: 'present_user',
        })).toEqual({ ok: true, result: { artifactId: 'daemon-retained-install-approval' } });
        expect(homes.artifacts(serverId).list()).toHaveLength(0);
        expect(homes.requestsFor('/v1/actions/approval.request.create')).toHaveLength(1);
        expect(homes.requestsFor('/v1/actions/plugins.install')).toHaveLength(0);
    });
    it('allows a registry Agent plugin to reach target selection without installing in the Agent picker', async () => {
        const home = homes.findByServerUrl('https://plugin-actions.test');
        if (!home?.token) throw new Error('Expected authenticated Home');
        // Keep restoration cold so unrelated full-Sync hydration cannot add a Machine.
        connection = await restoreServerAccountForTest({ serverUrl: home.serverUrl,
            serverIdentityId: 'srv_plugin_home', accountId: 'owner', credentials: { token: home.token },
            request: homes.request, configureSocket: socket => {
                vi.mocked(socket.connect).mockImplementation(() => socket);
            } });
        serverId = connection.home.id;
        const packageName = '@acme/coding-agent';
        const { createRegistryNpmPackageFixture } = await import('@/dev/testkit/fixtures/registryPluginCatalog');
        const metadata = createRegistryNpmPackageFixture({ packageName, pluginId: 'acme.plugin', title: 'Acme Coding Agent', version: '1.0.0',
            contributes: { agents: [{ id: 'coding', title: 'Coding', primary: 'sessions', runtime: { kind: 'custom' },
                capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } }] } });
        const { createPromptLibraryCatalogBoundary } = await import('@/dev/testkit/harness/promptLibraryCatalogBoundary');
        const catalog = createPromptLibraryCatalogBoundary();
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            if (url.origin === 'https://registry.npmjs.org') return Response.json(url.pathname === '/-/v1/search'
                ? { total: 1, objects: [{ package: { name: packageName, version: '1.0.0', publisher: { username: 'acme' } } }] }
                : { name: packageName, versions: { '1.0.0': metadata }, 'dist-tags': { latest: '2.0.0' } });
            return await catalog.handle(url.pathname, init) ?? await homes.request(input, init);
        });
        const { storage } = await import('@/sync/domains/state/storageStore');
        storage.getState().applyMachines([]);
        storage.getState().applySettingsLocal({ machineAdministrationTargetsLocalV1: {
            agents: { serverIdentityId: 'srv_plugin_home', machineId: 'admitted' },
        } });
        const onOpenDefinition = vi.fn();
        const registryRead: { current: ReturnType<typeof useRegistryItem> | null } = { current: null };
        const administration = await renderHook(() => useAgentAdministrationCatalog({ loadProjection: false }));
        const screen = await renderScreen(React.createElement(React.Fragment, null,
            React.createElement(AgentAddModal, { onClose: () => {}, onAddedStay: onOpenDefinition,
                params: { onOpenDefinition, onOpenAgent: () => {}, sourceId: COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1 } }),
            React.createElement(RegistryAgentReadProbe, { read: registryRead })));
        try {
            const readRow = () => {
                const node = screen.findAll(candidate => candidate.type === CapabilityAddModalBody)[0];
                const config = node.props.config as import('@/components/capabilities/add/CapabilityAddModal').CapabilityAddModalConfig<import('@/components/settings/agents/add/agentAddRows').AgentAddRow>;
                const row = config.catalog.items.find(candidate => candidate.summary.itemId === packageName)!;
                return { config, row };
            };
            await waitForHomeGovernance(() => expect(readRow().row).toBeDefined());
            // Renderer lists have no measured viewport; use the real Collection open intent.
            const collection = screen.findAll(node => node.props?.testID === 'agents.add:collection'
                && typeof node.props?.model?.actions?.open === 'function')[0];
            await act(async () => collection.props.model.actions.open(readRow().row.key));
            await waitForHomeGovernance(() => expect(registryRead.current?.item?.payload.kind).toBe('plugin'));
            const { config, row } = readRow();
            expect(administration.getCurrent().executionTarget).toBeNull();
            expect(config.detailFooter(row).primary.disabledReason).toBeUndefined();
            expect(await config.detailFooter(row).primary.onPress()).toBeNull();
            expect(config.detailFooter(row).afterAdd).toBeUndefined();
            expect(onOpenDefinition).not.toHaveBeenCalled();
            expect(homes.requestsFor('/v1/actions/plugins.install')).toHaveLength(0);
            expect(homes.requestsFor('/v1/actions/agents.acp.backends.installFromRegistry')).toHaveLength(0);
        } finally {
            await screen.unmount();
            await administration.unmount();
        }
    });
    it('delivers an exact marketplace candidate to its selected Machine and refuses a conflicting mounted target', async () => {
        homes.answer(serverId, '/v2/account/settings', { body: { version: 1, content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'plugins.install': ['cli'] } },
        } } } });
        const input = getActionSpec('plugins.install').inputSchema.parse({ machineId: 'admitted',
            source: { kind: 'marketplace', sourceId: 'marketplace:curated', pluginId: 'acme.plugin', version: '1.0.0' } });
        const pending = { kind: 'reviewRequired', reviewKind: 'installation', pendingChangeId: 'pending-marketplace',
            reason: 'firstInstall', currentVersion: null, authorityExpansion: [],
            review: createPluginInstallationReviewFixture({ pluginId: 'acme.plugin', version: '1.0.0' }) };
        homes.answer(serverId, '/v1/actions/plugins.install', { select: body => {
            const carried = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            const request = ExternalActionRequestEnvelopeV1Schema.parse(carried.envelope);
            expect(request.target).toEqual({ kind: 'machine', machineId: 'admitted' });
            expect(getActionSpec('plugins.install').inputSchema.safeParse(request.input).success).toBe(true);
            return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'plugins.install', requestId: request.requestId,
                execution: { ok: true, result: { ok: false, kind: 'plugins_install', outcome: 'reviewRequired', pendingReview: pending } },
            }) };
        } });
        // This fixture is the authenticated, already-admitted headless host;
        // unlike the UI entrypoint it retains the incoming present-user authority.
        const executor = createDefaultActionExecutor({ admittedClientActionId: 'plugins.install' });
        const context = { serverId, expectedAccountId: 'owner', surface: 'cli' as const, authority: 'present_user' as const };
        const result = await executor.execute('plugins.install', input, context);
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'plugins_install', outcome: 'reviewRequired', pendingReview: pending } });
        if (result.ok) expect(getActionSpec('plugins.install').outputSchema?.safeParse(result.result).success).toBe(true);
        expect(homes.artifacts(serverId).list().some(row => {
            const raw = homes.artifacts(serverId).readPlainBody(row.id);
            const approval = ApprovalRequestSchema.safeParse(raw ? JSON.parse(raw) : null);
            return approval.success && approval.data.actionId === 'plugins.install';
        })).toBe(false);
        const issued = homes.requestsFor('/v1/actions/plugins.install').length;
        expect(await executor.execute('plugins.install', input, { ...context, executionRunTargetMachineId: 'other' }))
            .toMatchObject({ ok: false, errorCode: 'target_mismatch' });
        expect(homes.requestsFor('/v1/actions/plugins.install')).toHaveLength(issued);
    });
    it.each(['approval', 'encryption', 'unchanged', 'terminal-retirement'] as const)('keeps a configured Settings → Actions UI Ask on its captured field intent (change=%s)', async changeAt => {
        const changeIntent = changeAt !== 'unchanged';
        const home = homes.findByServerUrl('https://plugin-actions.test');
        if (!home?.token) throw new Error('Expected authenticated Home');
        if (changeAt === 'terminal-retirement') {
            // Same structural credential-store boundary vector as the UI
            // approval-origin suite; real credential authority stays active.
            home.token = `e30.${btoa(JSON.stringify({ sub: 'owner', session: 'terminal-test', provenance: {
                v: 2, kind: 'terminal', authority: 'account_automation',
                evidence: [{ kind: 'home_method', methodId: 'key_challenge' }],
            } }))}.signature`;
        }
        connection = await restoreServerAccountForTest({ serverUrl: home.serverUrl, serverIdentityId: 'srv_plugin_home', accountId: 'owner',
            credentials: { token: home.token }, request: homes.request });
        serverId = connection.home.id;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime?.isCurrent()) throw new Error('Expected real current Account lifetime');
        await homes.requireUiApproval(serverId, 'plugins.settings.set');
        homes.answer(serverId, '/v2/account/settings', { body: { version: 1, content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, actions: { 'plugins.settings.set': { approvalRequiredSurfaces: ['ui'] } } },
        } } } });
        const pluginId = 'acme.settings';
        const response = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ availabilityCursor: 1,
            hostingCapability: { enabled: false },
            intent: { pluginId, desiredVersion: '1.0.0', enabled: true, offlineUiHosting: 'disabled', writableCollections: [], revision: 'intent-1' },
            release: { ref: { pluginId, version: '1.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                normalizedManifest: { schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Settings',
                    engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: { settings: [{ id: 'preferences', title: 'Preferences',
                        scope: 'account', target: { kind: 'plugin' }, fields: [{ id: 'enabled', title: 'Enabled', schema: { type: 'boolean' } }] }] } },
                collectionContracts: [], uiSlots: [], packageAssetArchive: { archiveDigestSha256: `sha256:${'c'.repeat(64)}`, resources: [] } },
            packageAssets: [], uiArtifacts: [],
        });
        replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot: { availabilityCursor: 1,
            intentReads: [{ pluginId, response }], materializations: [], snapshots: [], inventoryComplete: true } });
        let revision = 7;
        let values: Readonly<Record<string, unknown>> = { enabled: false };
        let observeEffectReads = false;
        let effectReads = 0;
        let holdNextModeRead = false;
        let modeReadPending = false;
        const releaseModeRead = createDeferred<void>();
        const path = `/v1/account/plugin-settings/${pluginId}`;
        homes.answer(serverId, `GET ${path}`, { select: () => {
            // The second effect read is the incumbent read-before-CAS merge.
            // Its next mode fetch is a genuine awaited boundary before POST.
            if (observeEffectReads && ++effectReads === 2) holdNextModeRead = true;
            return { body: { status: 'present', revision, content: { t: 'plain', v: { v: 1, values } } } };
        } });
        homes.answer(serverId, `POST ${path}`, { select: input => {
            const mutation = PluginAccountSettingsMutationRequestV1Schema.parse(input);
            if (mutation.expectedRevision !== revision) return { body: { status: 'conflict', revision } };
            if (mutation.content?.t !== 'plain') throw new Error('Expected Plain Account Settings');
            values = mutation.content.v.values;
            return { body: { status: 'updated', revision: ++revision } };
        } });
        const target = { kind: 'account' as const, serverIdentityId: 'srv_plugin_home' };
        const fields = [{ key: 'enabled', redacted: false }];
        const projection = await renderHook(({ sourceLifetimeIdentity }: { sourceLifetimeIdentity: string }) =>
            useScopedPluginSettingsProjection({ pluginId, target, scope: { kind: 'account' }, fields,
                enabled: true, adapter: scopedPluginSettingsAdapter, accountLifetime: lifetime,
                perActiveServerIdentityId: null, sourceLifetimeIdentity }),
        { initialProps: { sourceLifetimeIdentity: 'declaration-a' } });
        await waitForHomeGovernance(() => expect(projection.getCurrent().state.revision).toEqual({ kind: 'account', value: 7 }));
        const { storage } = await import('@/sync/domains/state/storageStore');
        expect(storage.getState().settings.actionsSettingsV1?.actions?.['plugins.settings.set']?.approvalRequiredSurfaces)
            .toContain('ui');
        let returned = false;
        const pending = projection.getCurrent().commit({ fieldId: 'enabled', mutation: { kind: 'set', value: true } })
            .then(result => { returned = true; return result; });
        const observed = await waitForHomeGovernance(async () => {
            if (returned) return { kind: 'returned' as const, outcome: await pending };
            const artifact = homes.artifacts(serverId).list().find(row => ApprovalRequestSchema.safeParse(
                JSON.parse(homes.artifacts(serverId).readPlainBody(row.id) ?? 'null')).success);
            expect(artifact).toBeDefined();
            return { kind: 'approval' as const, artifactId: artifact!.id };
        });
        if (observed.kind === 'returned') {
            // Distinguish a real eligible storage bypass from a fixture or
            // declaration refusal before blaming missing approval ingress.
            expect(['ready', 'applied']).toContain(observed.outcome?.status);
            expect(values).toEqual({ enabled: true });
            expect(homes.requestsFor(path).some(request =>
                PluginAccountSettingsMutationRequestV1Schema.safeParse(request.input).success)).toBe(true);
        }
        expect(observed.kind).toBe('approval');
        if (observed.kind !== 'approval') throw new Error('Settings bypassed the real UI approval owner');
        expect(values).toEqual({ enabled: false });
        expect(JSON.parse(homes.artifacts(serverId).readPlainBody(observed.artifactId) ?? 'null')).toMatchObject({
            approval: { flow: 'blocking' }, executionOriginV1: {
                authority: changeAt === 'terminal-retirement' ? 'account_automation' : 'present_user',
                surface: 'ui', caller: { kind: 'host' } },
        });
        if (changeAt === 'terminal-retirement') {
            expect(await createDefaultActionExecutor().execute('approval.request.decide',
                { artifactId: observed.artifactId, decision: 'approve' }, { serverId }))
                .toMatchObject({ ok: false, errorCode: 'present_user_required' });
            await connection?.dispose();
            connection = null;
            expect(await pending).toMatchObject({ status: 'unavailable' });
            expect(values).toEqual({ enabled: false });
            expect(revision).toBe(7);
            await projection.unmount();
            return;
        }
        if (changeAt === 'approval') await projection.rerender({ sourceLifetimeIdentity: 'declaration-b' });
        if (changeAt === 'encryption') {
            observeEffectReads = true;
            homes.answer(serverId, '/v1/account/encryption', { select: () => {
                if (!holdNextModeRead) return { body: { mode: 'plain', updatedAt: 1 } };
                holdNextModeRead = false;
                modeReadPending = true;
                return { body: { mode: 'plain', updatedAt: 1 }, respondAfter: releaseModeRead.promise };
            } });
        }
        const decision = createDefaultActionExecutor().execute('approval.request.decide', { artifactId: observed.artifactId, decision: 'approve' }, { serverId });
        if (changeAt === 'encryption') {
            await waitForHomeGovernance(() => expect(modeReadPending).toBe(true));
            await projection.rerender({ sourceLifetimeIdentity: 'declaration-b' });
            releaseModeRead.resolve();
        }
        expect(await decision)
            .toMatchObject({ ok: true });
        expect(await pending).toMatchObject({ status: changeIntent ? 'unavailable' : 'applied' });
        expect(values).toEqual({ enabled: !changeIntent });
        expect(revision).toBe(changeIntent ? 7 : 8);
        await projection.unmount();
    });
    const caller = { kind: 'plugin' as const, pluginId: 'happier.inspector', contributionLocalId: 'inspector', occurrenceId: 'occurrence-1',
        sourceCustody: { kind: 'development' as const, registeredRootId: 'inspector-root' },
        materialization: { machineId: 'admitted', materializationId: 'inspector-installation', pluginId: 'happier.inspector' } };
    it('executes plugins.list through root delivery against only the mount-admitted Machine', async () => {
        // Mounted Hosts use this scoped front door, not an unscoped executor.
        const result = await scopedHomeActionExecutor({ serverId, accountId: 'owner' })('plugins.list', {}, {
            serverId, expectedAccountId: 'owner', surface: 'plugin', actionCaller: caller,
            executionRunTargetMachineId: 'admitted', defaultSessionMachineId: 'other', actionRequestId: 'inspector-list',
        });
        expect(result).toEqual({ ok: true, result: { ok: true, kind: 'plugins_list', plugins: [{ id: 'daemon-owned' }] } });
        expect(homes.requestsFor('/v1/actions/plugins.list').map(record => record.input)).toEqual([
            { v: 1, requestId: 'inspector-list', target: { kind: 'machine', machineId: 'admitted' }, input: {},
                pluginInvocation: { kind: 'mountedPluginSurface', mountedBinding: {
                    pluginId: caller.pluginId, contributionLocalId: caller.contributionLocalId, occurrenceId: caller.occurrenceId,
                    sourceCustody: caller.sourceCustody, materializationRef: caller.materialization,
                } } },
        ]);
    });
    it('delegates Channels conversation targets through the same exact-Machine provenance carrier', async () => {
        const channelsCaller = { ...caller, pluginId: 'happier.channels', contributionLocalId: 'channels-app',
            materialization: { ...caller.materialization, pluginId: 'happier.channels' } };
        homes.answer(serverId, '/v1/actions/automation.conversation.targets.list', { select: body => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(body);
            return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'automation.conversation.targets.list',
                requestId: request.requestId, execution: { ok: true, result: { items: [], nextCursor: null } } }) };
        } });
        expect(await createDefaultActionExecutor().execute('automation.conversation.targets.list', {}, {
            serverId, expectedAccountId: 'owner', surface: 'plugin', actionCaller: channelsCaller,
            executionRunTargetMachineId: 'admitted', defaultSessionMachineId: 'other', actionRequestId: 'channels-targets',
        })).toEqual({ ok: true, result: { items: [], nextCursor: null } });
        expect(homes.requestsFor('/v1/actions/automation.conversation.targets.list').map(record => record.input)).toEqual([
            { v: 1, requestId: 'channels-targets', target: { kind: 'machine', machineId: 'admitted' }, input: {},
                pluginInvocation: { kind: 'mountedPluginSurface', mountedBinding: {
                    pluginId: channelsCaller.pluginId, contributionLocalId: channelsCaller.contributionLocalId,
                    occurrenceId: channelsCaller.occurrenceId, sourceCustody: channelsCaller.sourceCustody,
                    materializationRef: channelsCaller.materialization,
                } } },
        ]);
    });
    it('does not borrow a default Machine when the plugin mount has no admitted target', async () => {
        expect(await createDefaultActionExecutor().execute('plugins.list', {}, {
            serverId, expectedAccountId: 'owner', surface: 'plugin', actionCaller: caller, defaultSessionMachineId: 'other',
        })).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
        expect(homes.requestsFor('/v1/actions/plugins.list')).toHaveLength(0);
    });
    it('returns the daemon stale-occurrence refusal unchanged to the mounted UI', async () => {
        homes.answer(serverId, '/v1/actions/plugins.list', { select: body => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(body);
            return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'plugins.list', requestId: request.requestId,
                execution: { ok: false, errorCode: 'plugin_mounted_caller_unavailable', error: 'plugin_mounted_caller_unavailable' },
            }) };
        } });
        expect(await createDefaultActionExecutor().execute('plugins.list', {}, {
            serverId, expectedAccountId: 'owner', surface: 'plugin', actionCaller: caller,
            executionRunTargetMachineId: 'admitted', actionRequestId: 'stale-inspector-list',
        })).toMatchObject({ ok: false, errorCode: 'plugin_mounted_caller_unavailable' });
    });
    it('retains approval custody before root delivery when a trusted plugin reloads another plugin', async () => {
        const executor = createDefaultActionExecutor();
        const context = { serverId, expectedAccountId: 'owner', surface: 'plugin' as const,
            executionRunTargetMachineId: 'admitted', actionRequestId: 'peer-reload' };
        const outcome = await executor.execute('plugins.reload', { pluginId: 'other.plugin' }, {
            ...context, actionCaller: caller,
        });
        if (!outcome.ok) throw new Error(JSON.stringify(outcome));
        const approval = ActionApprovalRequestCreatedResultSchema.parse(outcome.result);
        expect(JSON.parse(homes.artifacts(serverId).readPlainBody(approval.artifactId)!)).toMatchObject({
            actionId: 'plugins.reload', status: 'open',
            createdBy: { pluginId: caller.pluginId, contributionLocalId: caller.contributionLocalId },
        });
        expect(homes.requestsFor('/v1/actions/plugins.reload')).toHaveLength(0);
    });
});
