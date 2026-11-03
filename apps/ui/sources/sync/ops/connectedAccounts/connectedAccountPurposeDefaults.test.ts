import { expect, it, vi } from 'vitest';
import { writeAgentDefaultChoice } from '@happier-dev/protocol/connect/agentDefaultChoices';
import { ConnectedAccountCatalogRowMutationV1Schema, type ConnectedPurposeCatalogV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createDeferred } from '@/dev/testkit';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createMachineFixture } from '@/dev/testkit';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

installDisconnectedServerSocketBoundary();
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { mutateConnectedAccountPurposeDefaultsInContext } = await import('./connectedAccountPurposeDefaults');
const { readConnectedAccountCatalog } = await import('@/sync/api/account/apiConnectedAccountCatalog');

it('activates genuine auxiliary Agent defaults through the current reader and publishes before retained history settles', async () => {
    const bridge = await loadSyncSingletonForTests();
    const accountId = 'purpose-auxiliary';
    const machineId = 'purpose-source-machine';
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const identity = { pluginId: service.pluginId, localId: 'codex' };
    const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, installedPackagesById: {},
        agentsById: { codex: { id: 'codex', title: 'Codex', identity,
            connectedAccounts: [{ purpose: 'primary', service, credentialKinds: ['oauth'] }],
            capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } } },
        actionsById: {}, familiesById: {},   resourcesById: {}, settingsById: {}, diagnostics: [] });
    const http = createHomeHubArtifactHttpBoundary(accountId);
    const history = createDeferred<void>();
    let historyReads = 0;
    let readyBeforeHistory = false;
    let catalog: ReturnType<typeof ConnectedAccountCatalogRowMutationV1Schema.parse>['content'] | undefined;
    const rowPath = '/v1/account/entity-rows/connected-accounts/purposes';
    const raw = { connectedServicesDefaultAuthByAgentIdV1: { v: 1,
        bindingsByAgentId: { codex: { v: 1, bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } } } } } };
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://purpose-auxiliary.test', accountId,
        configureSocket: socket => {
            configureConnectedServerSocketBoundary(socket);
            // Only the external daemon ACK is substituted; projection admission,
            // Account custody and source-only Agent resolution remain real.
            socket.emitWithAck = vi.fn(async (event, _payload) => event === SOCKET_RPC_EVENTS.CALL
                ? { ok: true, result: { protocolVersion: 1, projection } }
                : { v: 1, ok: true, admittedSessionIds: [] });
        }, request: async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v2/account/settings') return Response.json({ version: 7, content: { t: 'plain', v: raw } });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 7 }));
            if (path === PROFILE_TRANSFER_ROUTE_V1) return Response.json({ status: 'absent' });
            if (path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(init?.body,
                id => createPlainMachineRowFixture({ id, accountId }));
            if (path === '/v2/account/settings/history') {
                historyReads++;
                await history.promise;
                return Response.json({ snapshots: [] });
            }
            if (path !== rowPath) return http.request(input, init);
            if (init?.method !== 'POST') return Response.json(catalog ? { status: 'present', revision: 1, content: catalog } : { status: 'absent' });
            const mutation = ConnectedAccountCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
            expect(mutation).toMatchObject({ expectedRevision: 'absent', sourceSettingsVersion: 7 });
            catalog = mutation.content;
            return Response.json({ status: 'updated', revision: 1, cursor: 1 });
        } });
    let pending: ReturnType<typeof readConnectedAccountCatalog> | undefined;
    try {
        const { storage } = await import('@/sync/domains/state/storageStore');
        const scope = { serverId: connection.home.id, accountId };
        storage.setState({ machineListByServerId: { [scope.serverId]: [createMachineFixture({ id: machineId, active: true, activeAt: Date.now() })] } });
        pending = readConnectedAccountCatalog(scope, 'purposes', undefined, undefined, {
            onReady: snapshot => {
                expect(snapshot).toMatchObject({ status: 'ready', record: { key: 'purposes', value: { bindings: [{
                    purpose: { consumer: identity, purpose: 'primary' }, target: { kind: 'account', account: { service, accountId: 'work' } },
                }] } } });
                readyBeforeHistory = historyReads === 0;
            },
        }, { sourceMachineId: machineId });
        await waitForHomeGovernance(() => expect(historyReads).toBe(1));
        expect(readyBeforeHistory).toBe(true);
        history.resolve();
        expect(await pending).toMatchObject({ status: 'ready', revision: 1, cleanup: { status: 'complete' } });
        expect(historyReads).toBe(2);
    } finally {
        history.resolve(); await pending?.catch(() => {});
        await connection.dispose(); bridge.dispose();
    }
});

it('acknowledges a choice in an active purpose catalog without waiting for settings-history maintenance', async () => {
    const bridge = await loadSyncSingletonForTests();
    const http = createHomeHubArtifactHttpBoundary('purpose-maintenance');
    const maintenance = createDeferred<void>();
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const agent = { agentId: 'codex', title: 'Codex', identity: { pluginId: service.pluginId, localId: 'codex' },
        connectedAccounts: [{ purpose: 'primary', service }] };
    let purposeBindings: ConnectedPurposeCatalogV1 = { v: 1, bindings: [] };
    let revision = 3;
    let historyBeforeWrite = false;
    const path = '/v1/account/entity-rows/connected-accounts/purposes';
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://purpose-maintenance.test',
        accountId: 'purpose-maintenance', configureSocket: configureConnectedServerSocketBoundary, request: async (input, init) => {
            const requested = new URL(String(input)).pathname;
            if (requested === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 1 }));
            if (requested === PROFILE_TRANSFER_ROUTE_V1) return Response.json({ status: 'absent' });
            if (requested.startsWith('/v2/account/settings/history')) {
                if (revision === 3) historyBeforeWrite = true;
                await maintenance.promise;
                return Response.json({ snapshots: [] });
            }
            if (requested !== path) return http.request(input, init);
            if (init?.method !== 'POST') return Response.json({ status: 'present', revision,
                content: { t: 'plain', v: { key: 'purposes', value: purposeBindings } } });
            const mutation = ConnectedAccountCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
            expect(mutation.expectedRevision).toBe(revision);
            if (mutation.content?.t !== 'plain' || mutation.content.v.key !== 'purposes') throw new Error('Expected plain purpose envelope');
            purposeBindings = mutation.content.v.value;
            return Response.json({ status: 'updated', revision: ++revision, cursor: revision });
        } });
    const account = await captureLazyActionAccountContext(connection.home.id);
    let mutation: Promise<void> | undefined;
    try {
        mutation = mutateConnectedAccountPurposeDefaultsInContext(account, (current, settings) => {
            const written = writeAgentDefaultChoice({ agents: [agent], purposeBindings: current, settings,
                target: { kind: 'account', account: { service, accountId: 'work' } }, agentId: 'codex', makeDefault: true });
            if (!written) throw new Error('Expected declared Codex purpose');
            const { connectedAccountPurposeBindingsV1, ...legacySettingsDelta } = written;
            return { purposeBindings: connectedAccountPurposeBindingsV1, legacySettingsDelta };
        });
        void mutation.catch(() => {});
        await vi.waitFor(() => expect(purposeBindings.bindings).toEqual([{
            purpose: { consumer: agent.identity, purpose: 'primary' }, target: { kind: 'account', account: { service, accountId: 'work' } },
        }]));
        await mutation;
        expect(historyBeforeWrite).toBe(false);
    } finally {
        maintenance.resolve();
        await mutation?.catch(() => {});
        account.dispose(); await connection.dispose(); bridge.dispose();
    }
});

it('retires a genuine legacy default only with the purpose row acknowledgement, preserving Team and unrelated Settings', async () => {
    const bridge = await loadSyncSingletonForTests();
    const http = createHomeHubArtifactHttpBoundary('purpose-paired');
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const agent = { agentId: 'codex', title: 'Codex', identity: { pluginId: 'happier.agent.codex', localId: 'codex' }, connectedAccounts: [{ purpose: 'model', service }] };
    const team = { purpose: { consumer: { pluginId: 'com.acme.resource', localId: 'worker' }, purpose: 'api' }, teamId: 'work',
        selection: { source: 'team_resource' as const, resourceId: 'cloud', deliveryMode: 'brokered' as const } };
    let purposeBindings: ConnectedPurposeCatalogV1 = { v: 1, bindings: [], teamResourceSelections: [team] };
    let raw: Record<string, unknown> = { futurePreference: { preserved: true }, connectedServicesDefaultAuthByAgentIdV1: {
        v: 1, bindingsByAgentId: { codex: { v: 1, bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } } } },
    } };
    const initialRaw = raw;
    const initialPurposes = purposeBindings;
    let settingsVersion = 7;
    let revision = 3;
    let refuse = true;
    let acknowledge!: () => void;
    let issued!: () => void;
    const ack = new Promise<void>(resolve => { acknowledge = resolve; });
    const dispatched = new Promise<void>(resolve => { issued = resolve; });
    // HTTP persistence is the substituted boundary; canonical migration, Settings
    // preparation, envelope codecs and the captured Account remain real.
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://purpose-paired.test', accountId: 'purpose-paired', configureSocket: configureConnectedServerSocketBoundary, request: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === '/v2/account/settings') {
            if (init?.method === 'POST') throw new Error('purpose_edit_must_not_write_settings_separately');
            return Response.json({ content: { t: 'plain', v: raw }, version: settingsVersion });
        }
        if (path !== '/v1/account/entity-rows/connected-accounts/purposes') return http.request(input, init);
        if (init?.method !== 'POST') return Response.json({ status: 'present', revision, content: { t: 'plain', v: { key: 'purposes', value: purposeBindings } } });
        const mutation = ConnectedAccountCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
        expect(mutation.expectedRevision).toBe(revision);
        expect(mutation.settingsMutation?.expectedSettingsVersion).toBe(settingsVersion);
        if (refuse) return Response.json({ status: 'settings-conflict', revision }, { status: 409 });
        issued();
        await ack;
        if (mutation.content?.t !== 'plain' || mutation.content.v.key !== 'purposes' || mutation.settingsMutation?.content?.t !== 'plain') throw new Error('Expected paired plain Account envelopes');
        purposeBindings = mutation.content.v.value;
        raw = mutation.settingsMutation.content.v;
        settingsVersion += 1; revision += 1;
        return Response.json({ status: 'updated', revision, cursor: revision, settingsVersion });
    } });
    const account = await captureLazyActionAccountContext(connection.home.id);
    const remove: Parameters<typeof mutateConnectedAccountPurposeDefaultsInContext>[1] = (current, settings) => {
        const written = writeAgentDefaultChoice({ agents: [agent], purposeBindings: current, settings,
            target: { kind: 'account', account: { service, accountId: 'work' } }, agentId: 'codex', makeDefault: false });
        if (!written) return null;
        const { connectedAccountPurposeBindingsV1, ...legacySettingsDelta } = written;
        return { purposeBindings: connectedAccountPurposeBindingsV1, legacySettingsDelta };
    };
    try {
        await expect(mutateConnectedAccountPurposeDefaultsInContext(account, remove)).rejects.toMatchObject({ code: 'account_settings_mutation_conflict' });
        expect(raw).toBe(initialRaw);
        expect(purposeBindings).toBe(initialPurposes);
        refuse = false;
        let settled = false;
        const pending = mutateConnectedAccountPurposeDefaultsInContext(account, remove).then(() => { settled = true; });
        await dispatched;
        expect(settled).toBe(false);
        expect(raw).toBe(initialRaw);
        acknowledge();
        await pending;
        expect(purposeBindings).toEqual({ v: 1, bindings: [], teamResourceSelections: [team] });
        expect(raw).toMatchObject({ futurePreference: { preserved: true }, connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} } });
        expect(raw).not.toHaveProperty('connectedAccountPurposeBindingsV1');
    } finally {
        account.dispose(); await connection.dispose(); bridge.dispose();
    }
});
