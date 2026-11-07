import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createProviderSettingsHarness, installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import * as React from 'react';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import { ProviderProbeObservationIdentityV1Schema } from '@happier-dev/protocol/providers/fingerprints';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createProviderConnectionsDescribeFixture,
    createProviderConnectionViewFixture,
    createProviderSettingsAccountHarness,
} from '@/dev/testkit/harness/providerSettingsHarness';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
    ProviderConnectionsCatalogV1Schema,
} from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { buildCustomProviderTemplate, createCustomProviderDraft } from '@/providers/authoring/state';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { applyAcknowledgedProviderCatalog, applyProviderCatalogSnapshot, getProviderCatalogSnapshot,
    subscribeProviderCatalogSnapshots } from '@/sync/store/settings/providerCatalogSnapshot';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { presentProviderConnectionDetail } from '@/providers/connection/presentation';
import { createProviderConnectionSecurityFingerprintV1, PROVIDER_CONNECTION_SECURITY_CONTRACT_VERSION_V1 } from '@happier-dev/protocol/providers/securityFingerprintsV1';
import { readProviderConnectionSourceFactsV1 } from '@happier-dev/protocol/providers/connections/sourceFactsV1';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { readAccountProviderDeclarations, readProviderConnectionPickerKind } from '@/providers/catalog/accountProviderDeclarations';

const machineRpcWithServerScope = vi.hoisted(() => vi.fn());
const providerHarness = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(providerHarness);
providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, request => machineRpcWithServerScope(request));
const account = createProviderSettingsAccountHarness();
let serverId = '';
let otherServerId = '';

// Install Home transport before the credential hook can load Sync's request graph.
const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { useProviderConnections } = await import('./useProviderConnections');
const { useProviderActionClient } = await import('@/providers/actions/useProviderActionClient');
const { useProviderCatalogCounts } = await import('./useProviderCatalogCounts');
const { useProviderModelPickerVisibility } = await import('./useProviderModelPickerVisibility');

describe('useProviderConnections', () => {
    it.each(['disabled', 'failed'] as const)('keeps saved DeepSeek models and picker preference independent of Machine declarations (%s)', async state => {
        const declaration = readAccountProviderDeclarations({ kind: 'account' }).find(row => row.definition.id === 'deepseek')!;
        const source = declaration.definition;
        const facts = readProviderConnectionSourceFactsV1(source);
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_a', source: { kind: 'contribution', contributionKey: declaration.contributionKey },
                role: 'named', displayName: 'DeepSeek', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }],
            accountGrants: state === 'disabled' ? [] : [{ v: 1, connectionId: 'pc_a', confirmedAt: 1,
                connectionSecurityFingerprint: createProviderConnectionSecurityFingerprintV1({
                    securityContractVersion: PROVIDER_CONNECTION_SECURITY_CONTRACT_VERSION_V1, ...facts,
                    endpoints: source.endpointTemplates.map(endpoint => ({ endpointTemplateId: endpoint.id,
                        protocol: endpoint.protocol, url: endpoint.baseUrl!, publicHeaders: endpoint.publicHeaders })),
                }) }],
            secretBindingsByConnectionId: { pc_a: { account: { apiKey: 'fixture-api-key-reference' }, byMachineId: {} } },
            manualModelsByConnectionId: { pc_a: ('staticModels' in source.catalog ? source.catalog.staticModels : []).map(model => ({ id: model.id, addedAt: 1 })) },
        });
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            body: { status: 'present', revision: 1, content: { t: 'plain', v: catalog } },
        });
        let failDeclarations!: () => void;
        const pendingDeclarations = new Promise<void>(resolve => { failDeclarations = resolve; });
        providerHarness.intercept(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, async () => {
            await pendingDeclarations;
            throw Object.assign(new Error('Machine unavailable'), { code: 'provider_machine_unavailable' });
        });
        machineRpcWithServerScope.mockResolvedValue({ status: 'error', error: createProviderErrorV1('provider_endpoint_unreachable') });
        const hook = await renderHook(() => {
            const query = useProviderConnections({ enabled: true, machineId: 'machine-a', serverId, connectionId: 'pc_a' });
            const kind = readProviderConnectionPickerKind(query.catalog?.connections[0]?.source, query.declarationContext);
            return { query, counts: useProviderCatalogCounts(serverId, query.declarationContext),
                visibility: useProviderModelPickerVisibility('pc_a', kind ? { kind, serverId } : undefined) };
        });
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().query.catalog?.connections).toHaveLength(1));
            expect(source.credential?.kind).toBe('apiKey');
            expect(hook.getCurrent().counts?.pc_a).toEqual({ shown: 2, total: 2 });
            expect(hook.getCurrent().visibility?.shown).toBe(true);
            expect(hook.getCurrent().query.data?.connections[0]?.grants.accountEnabled).toBe(state !== 'disabled');
        } finally {
            await act(async () => { failDeclarations(); });
        }
        await waitForHomeGovernance(() => expect(hook.getCurrent().query.machineError?.code).toBe('provider_endpoint_unreachable'));
        expect(hook.getCurrent().counts?.pc_a).toEqual({ shown: 2, total: 2 });
        expect(hook.getCurrent().visibility?.shown).toBe(true);
    });

    it('publishes loading while Machine declarations are pending, never a false unavailable source', async () => {
        // Only dynamic Providers need the Machine's declaration. Bundled Account
        // facts are available while this separate admission is pending.
        const definition = readAccountProviderDeclarations({ kind: 'account' }).find(row => row.definition.id === 'deepseek')!.definition;
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_a', source: { kind: 'contribution', contributionKey: 'acme.dynamic/deepseek' },
                role: 'named', displayName: 'DeepSeek', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }],
        });
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            body: { status: 'present', revision: 1, content: { t: 'plain', v: catalog } },
        });
        let answerDeclarations!: () => void;
        const declarationRead = new Promise<void>(resolve => { answerDeclarations = resolve; });
        providerHarness.intercept(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, async () => {
            await declarationRead;
            return { protocolVersion: 1, projection: { v: 2, generation: 1, familiesById: { providers: { family: 'providers',
                entriesById: { 'acme.dynamic/deepseek': { id: 'acme.dynamic/deepseek', pluginId: 'acme.dynamic',
                    provenance: 'external', sourceKind: 'path', definition } },
            } } } };
        });
        machineRpcWithServerScope.mockImplementation(() => new Promise(() => {}));
        const publications: string[] = [];
        const hook = await renderHook(() => {
            const query = useProviderConnections({ enabled: true, machineId: 'machine-a', serverId });
            const status = query.data?.connections[0]?.sourceStatus;
            if (status) publications.push(status);
            return query;
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().data?.connections[0]?.sourceStatus).toBe('loading'));
        expect(publications.filter(status => status === 'unavailable')).toHaveLength(0);
        await act(async () => { answerDeclarations(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().data?.connections[0]?.sourceStatus).toBe('available'));
        expect(publications.filter(status => status === 'unavailable')).toHaveLength(0);
    });

    it('retains a typed Machine read cause and request ID through the real Provider Action entry', async () => {
        machineRpcWithServerScope.mockRejectedValue(Object.assign(new Error('private endpoint prose'), {
            code: 'provider_endpoint_unreachable', requestId: 'request-machine-provider',
        }));
        const hook = await renderHook(() => useProviderConnections({ enabled: true, machineId: 'machine-a', serverId }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().machineError).toMatchObject({
            code: 'provider_endpoint_unreachable', requestId: expect.any(String),
        }));
    });

    it('retains the gateway binding cause through the page read and its existing Test Action', async () => {
        const cause = createProviderErrorV1('provider_connection_invalid', {
            connectionId: 'pc_a', reason: 'managed_purpose_bindings_missing',
        });
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_a', source: { kind: 'contribution',
                contributionKey: 'happier.provider.cliproxyapi/cliproxyapi' }, role: 'named',
                displayName: 'Empty gateway', displayNameMode: 'custom', deployment: { kind: 'managedLocal' },
                revision: 1, createdAt: 1, updatedAt: 1 }],
        });
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            body: { status: 'present', revision: 1, content: { t: 'plain', v: catalog } },
        });
        machineRpcWithServerScope.mockResolvedValue(createProviderConnectionsDescribeFixture({ connections: [
            createProviderConnectionViewFixture({ connectionId: 'pc_a', revision: 1,
                contributionKey: 'happier.provider.cliproxyapi/cliproxyapi',
                deployment: { kind: 'managedLocal', targetMachineId: 'machine-a', effects: null },
                authorized: false, authorizationError: cause,
            }),
        ] }));
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_PROBE, () => ({ status: 'error', error: cause }));
        const hook = await renderHook(() => ({
            query: useProviderConnections({ enabled: true, machineId: 'machine-a', serverId, connectionId: 'pc_a' }),
            actions: useProviderActionClient(serverId),
        }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().query.data?.connections[0]?.authorizationError).toEqual(cause));
        await act(async () => {
            expect(await hook.getCurrent().actions.probeProviderConnection({ serverId, machineId: 'machine-a', connectionId: 'pc_a' }))
                .toMatchObject({ status: 'error', error: cause });
        });
    });

    it.each(['503_test', '403_after_preference', 'recovery_refocus'] as const)(
        'keeps the canonical check and timestamp when optional Machine refresh fails (%s)', async sequence => {
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_a', source: { kind: 'custom', template: buildCustomProviderTemplate({
                ...createCustomProviderDraft('openai-chat'), name: 'Acme', baseUrl: 'https://models.example.test/v1', requiresApiKey: false,
            }) }, role: 'named', displayName: 'Acme', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }],
        });
        const saved = catalog.connections[0]!;
        if (saved.source.kind !== 'custom') throw new Error('Expected custom fixture');
        const facts = readProviderConnectionSourceFactsV1(saved.source.template);
        catalog.accountGrants = [{ v: 1, connectionId: saved.id, confirmedAt: 1,
            connectionSecurityFingerprint: createProviderConnectionSecurityFingerprintV1({
                securityContractVersion: PROVIDER_CONNECTION_SECURITY_CONTRACT_VERSION_V1,
                catalogProbes: facts.catalogProbes, credentialTransports: facts.credentialTransports,
                endpoints: saved.source.template.endpointTemplates.map(row => ({ endpointTemplateId: row.id,
                    protocol: row.protocol, url: row.baseUrl!, publicHeaders: row.publicHeaders })),
            }) }];
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            body: { status: 'present', revision: 1, content: { t: 'plain', v: catalog } },
        });
        const endpointStatus = sequence === '503_test' ? 'temporarily_unavailable'
            : sequence === '403_after_preference' ? 'unauthorized' : 'unreachable';
        const errorCode = sequence === '503_test' ? 'provider_endpoint_unavailable'
            : sequence === '403_after_preference' ? 'provider_endpoint_unauthorized' : 'provider_endpoint_unreachable';
        let checkedAt = 100;
        machineRpcWithServerScope.mockImplementation(async () => createProviderConnectionsDescribeFixture({ connections: [
            createProviderConnectionViewFixture({ connectionId: 'pc_a', revision: 1,
                probeObservationIdentity: ProviderProbeObservationIdentityV1Schema.parse('probe-observation:v1:current'),
                runtime: { health: checkedAt === 100 ? 'available' : endpointStatus === 'unreachable' ? 'unreachable' : 'needs_attention',
                    checkedAt, modelCount: 466, endpoints: [{ endpointTemplateId: 'openai-chat', activity: 'idle',
                        status: checkedAt === 100 ? 'available' : endpointStatus, observedAt: checkedAt,
                        errorCode: checkedAt === 100 ? null : errorCode, retryAt: null }] },
            }),
        ] }));
        const input = { enabled: true, machineId: 'machine-a', serverId, connectionId: 'pc_a' };
        let hook = await renderHook(() => useProviderConnections(input));
        await waitForHomeGovernance(() => expect(hook.getCurrent().data?.connections[0]?.runtime.checkedAt).toBe(100));
        if (sequence === '403_after_preference') {
            const { sync } = await import('@/sync/sync');
            await act(async () => { sync.applySettings({ showLineNumbers: false }, {
                expectedSettingsScope: captureActiveServerAccountScopeLifetime()!.scope,
            }); });
        }
        checkedAt = 200;
        await act(async () => { await hook.getCurrent().refresh(); });
        expect(hook.getCurrent().data?.connections[0]?.runtime.checkedAt).toBe(200);
        machineRpcWithServerScope.mockResolvedValue({ status: 'error', error: createProviderErrorV1('agent_timeout') });
        if (sequence === 'recovery_refocus') {
            await hook.unmount();
            hook = await renderHook(() => useProviderConnections(input));
            await waitForHomeGovernance(() => expect(hook.getCurrent().machineError?.code).toBe('agent_timeout'));
        } else {
            await act(async () => { await hook.getCurrent().refresh(); });
        }
        const view = hook.getCurrent().data?.connections[0];
        expect(view).toBeDefined();
        expect(presentProviderConnectionDetail(view!)).toMatchObject({
            status: endpointStatus === 'unreachable' ? 'unreachable' : 'needsAttention',
            lastCheck: { checkedAt: 200, errorCode },
        });
        expect(hook.getCurrent().machineError?.code).toBe('agent_timeout');
    });

    afterEach(async () => {
        standardCleanup();
        await account.reset();
    });
    beforeEach(async () => {
        providerHarness.reset();
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, request => machineRpcWithServerScope(request));
        machineRpcWithServerScope.mockReset();
        serverId = (await account.restore({ waivedActions: ['providers.connections.delete', 'providers.probe'],
            machines: ['machine-a', 'machine-b'].map(id => createMachineFixture({ id, active: true, activeAt: Date.now() })),
        })).serverId;
        otherServerId = await account.addHome({ name: 'Other Provider Home', serverUrl: 'https://provider-settings-other.test', accountId: 'account-a', active: false });
    });

    it('withdraws the addressed catalog when its Home is missing instead of reading the active Home', async () => {
        let addressedServerId: string | null = serverId;
        const hook = await renderHook(() => useProviderConnections({
            enabled: true, machineId: null, serverId: addressedServerId,
        }));
        await vi.waitFor(() => expect(hook.getCurrent().data).not.toBeNull());
        addressedServerId = null;
        await hook.rerender();
        await vi.waitFor(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent().data).toBeNull();
        expect(hook.getCurrent().catalog).toBeNull();
    });

    it('keeps saved editor configuration at the revision its Account describe read', async () => {
        let revision = 1;
        const catalogAt = (value: number) => ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_a', source: { kind: 'custom', template: buildCustomProviderTemplate({
                ...createCustomProviderDraft('openai-chat'), name: `Acme ${value}`, baseUrl: 'https://models.example.test/v1', requiresApiKey: false,
            }) }, role: 'named', displayName: `Acme ${value}`, displayNameMode: 'custom', revision: value, createdAt: 1, updatedAt: value }],
        });
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => ({ body: { status: 'present', revision, content: { t: 'plain', v: catalogAt(revision) } } }),
        });
        const hook = await renderHook(() => useProviderConnections({ enabled: true, machineId: null, serverId, connectionId: 'pc_a' }));
        await vi.waitFor(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent().catalog?.connections[0]?.revision).toBe(1);
        revision = 2;
        const scope = captureActiveServerAccountScopeLifetime()!.scope;
        await act(async () => { applyProviderCatalogSnapshot(scope, { status: 'ready', catalog: catalogAt(2), revision: 2 }, true); });
        await hook.rerender();
        expect(hook.getCurrent().catalog?.connections[0]?.revision).toBe(1);
        expect(hook.getCurrent().data?.connections[0]?.revision).toBe(1);
        await act(async () => { await hook.getCurrent().refresh('account'); });
        expect(hook.getCurrent().catalog?.connections[0]?.revision).toBe(2);
        expect(hook.getCurrent().data?.connections[0]?.revision).toBe(2);
        await act(async () => { applyAcknowledgedProviderCatalog(scope, catalogAt(3), 3, true, null); });
        expect(hook.getCurrent().catalog?.connections[0]?.revision).toBe(3);
        await act(async () => { applyProviderCatalogSnapshot(scope, { status: 'ready', catalog: catalogAt(4), revision: 4 }, true); });
        expect(hook.getCurrent().catalog?.connections[0]?.revision).toBe(3);
        expect(hook.getCurrent().data?.connections[0]?.revision).toBe(3);
        await act(async () => { applyProviderCatalogSnapshot(scope, { status: 'unavailable', reason: 'encryption-material-unavailable' }, true); });
        expect(hook.getCurrent().catalog).toBeNull();
        expect(hook.getCurrent().data).toBeNull();
    });

    it('keeps every saved connection and its records in a detail reader scoped to one connection', async () => {
        const connection = (id: string, name: string) => ({ v: 1, id, source: { kind: 'custom', template: buildCustomProviderTemplate({
            ...createCustomProviderDraft('openai-chat'), name, baseUrl: 'https://models.example.test/v1', requiresApiKey: false,
        }) }, role: 'named', displayName: name, displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 });
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [connection('pc_a', 'Acme'), connection('pc_b', 'Other')],
            accountGrants: [{ v: 1, connectionId: 'pc_b', connectionSecurityFingerprint: 'other-grant', confirmedAt: 1 }],
        });
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            body: { status: 'present', revision: 1, content: { t: 'plain', v: catalog } },
        });
        const hook = await renderHook(() => useProviderConnections({ enabled: true, machineId: null, serverId, connectionId: 'pc_a' }));
        await vi.waitFor(() => expect(hook.getCurrent().loading).toBe(false));
        await hook.rerender();
        // Another connection's grant is not an orphan of this page: the reader keeps the whole catalog.
        expect(hook.getCurrent().data?.connections).toMatchObject([{ connectionId: 'pc_a' }]);
        expect(hook.getCurrent().catalog?.connections.map(row => row.id)).toEqual(['pc_a', 'pc_b']);
        expect(hook.getCurrent().catalog?.accountGrants).toHaveLength(1);
    });

    it('shares one in-flight catalog and Machine read, then adopts an ACK without another describe', async () => {
        const catalogAt = (revision: number) => ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_a', source: { kind: 'custom', template: buildCustomProviderTemplate({
                ...createCustomProviderDraft('openai-chat'), name: 'Acme', baseUrl: 'https://models.example.test/v1', requiresApiKey: false,
            }) }, role: 'named', displayName: `Acme ${revision}`, displayNameMode: 'custom', revision, createdAt: 1, updatedAt: revision }],
        });
        let catalogReads = 0;
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => {
                catalogReads += 1;
                return { body: { status: 'present', revision: 1, content: { t: 'plain', v: catalogAt(1) } } };
            },
        });
        let finishMachine!: (value: ReturnType<typeof createProviderConnectionsDescribeFixture>) => void;
        const machineRead = new Promise<ReturnType<typeof createProviderConnectionsDescribeFixture>>(resolve => { finishMachine = resolve; });
        machineRpcWithServerScope.mockReturnValue(machineRead);
        const hook = await renderHook(() => ({
            first: useProviderConnections({ enabled: true, machineId: 'machine-a', serverId, connectionId: 'pc_a' }),
            second: useProviderConnections({ enabled: true, machineId: 'machine-a', serverId, connectionId: 'pc_a' }),
        }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().second.data?.connections[0]?.revision).toBe(1));
        await waitForHomeGovernance(() => expect(machineRpcWithServerScope).toHaveBeenCalled());
        expect(catalogReads).toBe(1);
        expect(machineRpcWithServerScope).toHaveBeenCalledOnce();
        await act(async () => { finishMachine(createProviderConnectionsDescribeFixture({ connections: [
            createProviderConnectionViewFixture({ connectionId: 'pc_a', revision: 1 }),
        ] })); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().second.loading).toBe(false));
        const scope = captureActiveServerAccountScopeLifetime()!.scope;
        await act(async () => { applyAcknowledgedProviderCatalog(scope, catalogAt(2), 2, true, null); });
        for (const reader of [hook.getCurrent().first, hook.getCurrent().second]) {
            expect(reader.data?.connections[0]).toMatchObject({ revision: 2, displayName: 'Acme 2' });
            expect(reader.catalog?.connections[0]?.revision).toBe(2);
        }
        expect(catalogReads).toBe(1);
        expect(machineRpcWithServerScope).toHaveBeenCalledOnce();
    });

    it('re-reads a check retired by an Account source ACK once for mounted readers of its exact key', async () => {
        const catalogAt = (revision: number) => ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_a', source: { kind: 'custom', template: buildCustomProviderTemplate({
                ...createCustomProviderDraft('openai-chat'), name: 'Acme',
                baseUrl: `https://models-${revision}.example.test/v1`, requiresApiKey: false,
            }) }, role: 'named', displayName: 'Acme', displayNameMode: 'custom', revision, createdAt: 1, updatedAt: revision }],
        });
        let revision = 1;
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => ({ body: { status: 'present', revision, content: { t: 'plain', v: catalogAt(revision) } } }),
        });
        const checked = (checkedAt: number) => createProviderConnectionsDescribeFixture({ connections: [
            createProviderConnectionViewFixture({ connectionId: 'pc_a', revision,
                runtime: { health: 'available', checkedAt, modelCount: 1, endpoints: [] } }),
        ] });
        machineRpcWithServerScope.mockImplementation(async () => checked(100));
        const { useProviderConnectionMachineViews } = await import('./useProviderConnectionMachineViews');
        const targets = ['machine-a', 'machine-b'].map(machineId => ({
            target: { serverIdentityId: serverId, machineId }, serverId, displayName: machineId, online: true,
        }));
        const hook = await renderHook(() => ({
            query: useProviderConnections({ enabled: true, machineId: 'machine-a', serverId, connectionId: 'pc_a' }),
            peers: useProviderConnectionMachineViews({ enabled: true, connectionId: 'pc_a', targets }),
        }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().query.data?.connections[0]?.runtime.checkedAt).toBe(100));
        await waitForHomeGovernance(() => expect(hook.getCurrent().peers.loading).toBe(false));
        let finish!: (value: ReturnType<typeof checked>) => void;
        const pending = new Promise<ReturnType<typeof checked>>(resolve => { finish = resolve; });
        machineRpcWithServerScope.mockClear();
        machineRpcWithServerScope.mockReturnValue(pending);
        try {
            revision = 2;
            await act(async () => { applyAcknowledgedProviderCatalog(captureActiveServerAccountScopeLifetime()!.scope,
                catalogAt(revision), revision, true, null); });
            await waitForHomeGovernance(() => expect(machineRpcWithServerScope).toHaveBeenCalledTimes(2));
            expect(hook.getCurrent().query.data?.connections[0]?.runtime.checkedAt).toBeNull();
        } finally { await act(async () => { finish(checked(200)); }); }
        await waitForHomeGovernance(() => expect(hook.getCurrent().query.data?.connections[0]?.runtime.checkedAt).toBe(200));
        for (const peer of Object.values(hook.getCurrent().peers.byTargetKey)) {
            expect(peer).toMatchObject({ connection: { runtime: { checkedAt: 200 } } });
        }
        expect(machineRpcWithServerScope.mock.calls.map(([request]) => request.machineId).sort()).toEqual(['machine-a', 'machine-b']);
    });

    it('updates a mounted reader from a newer canonical Machine check without replacing its editor basis', async () => {
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_a', source: { kind: 'custom', template: buildCustomProviderTemplate({
                ...createCustomProviderDraft('openai-chat'), name: 'Acme', baseUrl: 'https://models.example.test/v1', requiresApiKey: false,
            }) }, role: 'named', displayName: 'Acme', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }],
        });
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            body: { status: 'present', revision: 1, content: { t: 'plain', v: catalog } },
        });
        let checkedAt = 100;
        machineRpcWithServerScope.mockImplementation(async () => createProviderConnectionsDescribeFixture({ connections: [
            createProviderConnectionViewFixture({ connectionId: 'pc_a', revision: 1, displayName: 'Acme',
                probeObservationIdentity: ProviderProbeObservationIdentityV1Schema.parse('probe-observation:v1:stable'),
                runtime: { health: checkedAt === 100 ? 'unreachable' : 'needs_attention', checkedAt, modelCount: 466, endpoints: [{
                    endpointTemplateId: 'openai-chat', status: checkedAt === 100 ? 'unreachable' : 'temporarily_unavailable',
                    observedAt: checkedAt, activity: 'idle', retryAt: null,
                    errorCode: checkedAt === 100 ? 'provider_endpoint_unreachable' : 'provider_endpoint_unavailable',
                }] } }),
        ] }));
        const input = { enabled: true, machineId: 'machine-a', serverId, connectionId: 'pc_a' };
        const first = await renderHook(() => useProviderConnections(input));
        const second = await renderHook(() => useProviderConnections(input));
        await waitForHomeGovernance(() => {
            expect(first.getCurrent().data?.connections[0]?.runtime.checkedAt).toBe(100);
            expect(second.getCurrent().loading).toBe(false);
        });
        const editor = first.getCurrent().catalog;
        checkedAt = 200;
        const readsBefore = machineRpcWithServerScope.mock.calls.length;
        // A real sibling's initial read publishes the new check, without
        // invoking the first reader's private refresh.
        const third = await renderHook(() => useProviderConnections(input));
        await waitForHomeGovernance(() => expect(third.getCurrent().data?.connections[0]?.runtime.checkedAt).toBe(200));
        expect(first.getCurrent().data?.connections[0]?.runtime).toMatchObject({
            health: 'needs_attention', checkedAt: 200, modelCount: 466,
        });
        expect(first.getCurrent().catalog).toBe(editor);
        // Publishing a check wakes subscribers without triggering another read.
        expect(machineRpcWithServerScope.mock.calls.length).toBe(readsBefore + 1);
    });

    it('settles an unreadable Account credential without a machine and recovers on Retry', async () => {
        // The device credential store is the boundary; scope resolution and the
        // Provider Action/read lifecycle remain real.
        const credentialRead = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl');
        const workingRead = credentialRead.getMockImplementation()!;
        credentialRead.mockRejectedValue(new Error('device credential store unavailable'));
        const hook = await renderHook(() => ({
            scope: useServerCredentialAccountScopeBinding(serverId),
            connections: useProviderConnections({ enabled: true, machineId: null, serverId }),
        }));
        await vi.waitFor(() => expect(hook.getCurrent().scope.resolution.kind).toBe('unavailable'));
        expect(hook.getCurrent().connections).toMatchObject({
            data: null, loading: false, error: { code: 'provider_authorization_changed', retryable: true },
        });
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();

        credentialRead.mockImplementation(workingRead);
        await act(async () => { await hook.getCurrent().connections.refresh(); });
        await vi.waitFor(() => expect(hook.getCurrent().connections).toMatchObject({
            data: { status: 'success', connections: [] }, error: null, loading: false,
        }));
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });

    it('shows the ACK in same-Home peers with zero describes and reads hidden Machine facts only when revealed', async () => {
        let catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_a', source: { kind: 'custom', template: buildCustomProviderTemplate({
                ...createCustomProviderDraft('openai-chat'), name: 'Acme', baseUrl: 'https://models.example.test/v1', requiresApiKey: false,
            }) }, role: 'named', displayName: 'Acme', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }],
        });
        let revision = 1;
        let connectionExists = true;
        account.home.answer(otherServerId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            body: { status: 'present', revision: 1, content: { t: 'plain', v: catalog } },
        });
        account.home.answer(otherServerId, '/v1/account/encryption/currentness', {
            body: createPlainAccountEncryptionCurrentnessFixture(),
        });
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => ({ body: { status: 'present', revision, content: { t: 'plain', v: catalog } } }),
        });
        machineRpcWithServerScope.mockImplementation(async () => createProviderConnectionsDescribeFixture({
                connections: connectionExists ? [createProviderConnectionViewFixture({ connectionId: 'pc_a' })] : [],
            }));
        const resolveTarget = () => ({ machineId: 'machine-a', serverId });
        const hook = await renderHook(({ visible }: { visible: boolean }) => {
            const list = useProviderConnections({ enabled: true, active: visible, ...resolveTarget() });
            const detail = useProviderConnections({ enabled: true, ...resolveTarget(), connectionId: 'pc_a' });
            const otherServer = useProviderConnections({ enabled: true, machineId: 'machine-a', serverId: otherServerId });
            const otherMachine = useProviderConnections({ enabled: true, machineId: 'machine-b', serverId });
            return { list, detail, otherServer, otherMachine };
        }, { initialProps: { visible: true } });
        await vi.waitFor(() => {
            for (const projection of [hook.getCurrent().list, hook.getCurrent().detail,
                hook.getCurrent().otherServer, hook.getCurrent().otherMachine]) {
                expect(projection.loading).toBe(false);
                expect(projection.error).toBeNull();
                expect(projection.data?.connections).toHaveLength(1);
            }
        });
        machineRpcWithServerScope.mockClear();

        await act(async () => {
            catalog = { ...catalog, connections: [] };
            revision += 1;
            connectionExists = false;
            applyAcknowledgedProviderCatalog(captureActiveServerAccountScopeLifetime()!.scope, catalog, revision, true, null);
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().detail.data?.connections).toHaveLength(0));
        await waitForHomeGovernance(() => expect(hook.getCurrent().list.data?.connections).toHaveLength(0));
        expect(hook.getCurrent().otherServer.data?.connections).toHaveLength(1);
        await vi.waitFor(() => expect(hook.getCurrent().otherMachine.data?.connections).toHaveLength(0));
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();

        await hook.rerender({ visible: false });
        connectionExists = true;
        machineRpcWithServerScope.mockClear();
        await act(async () => { await hook.getCurrent().detail.refresh(); });
        expect(machineRpcWithServerScope).toHaveBeenCalledOnce();
        expect(hook.getCurrent().list.data?.connections).toHaveLength(0);
        await hook.rerender({ visible: true });
        await waitForHomeGovernance(() => expect(hook.getCurrent().list.data?.connections).toHaveLength(1));
        expect(machineRpcWithServerScope).toHaveBeenCalledTimes(2);
    });

    it('performs no Provider RPC when the canonical root feature decision is disabled', async () => {
        const hook = await renderHook(() => useProviderConnections({
            enabled: false,
            machineId: 'machine-a',
            serverId,
        }));

        expect(hook.getCurrent()).toMatchObject({ data: null, error: null, loading: false });
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });

    it('keeps admitted Account rows on a remount while its fresh Home read is pending', async () => {
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_a', source: { kind: 'custom', template: buildCustomProviderTemplate({
                ...createCustomProviderDraft('openai-chat'), name: 'Acme', baseUrl: 'https://models.example.test/v1', requiresApiKey: false,
            }) }, role: 'named', displayName: 'Acme', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }],
        });
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            body: { status: 'present', revision: 1, content: { t: 'plain', v: catalog } },
        });
        const first = await renderHook(() => useProviderConnections({ enabled: true, machineId: null, serverId }));
        await vi.waitFor(() => expect(first.getCurrent().data?.connections[0]?.displayName).toBe('Acme'));
        await first.unmount();
        let release!: () => void;
        const pending = new Promise<void>(resolve => { release = resolve; });
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            respondAfter: pending, body: { status: 'present', revision: 1, content: { t: 'plain', v: catalog } },
        });
        try {
            const second = await renderHook(() => useProviderConnections({ enabled: true, machineId: null, serverId, connectionId: 'pc_a' }));
            expect(second.getCurrent().data?.connections).toMatchObject([{ connectionId: 'pc_a', displayName: 'Acme' }]);
            expect(second.getCurrent().loading).toBe(false);
            expect(second.getCurrent().catalog?.connections[0]?.revision).toBe(1);
            await act(async () => { applyProviderCatalogSnapshot(captureActiveServerAccountScopeLifetime()!.scope,
                { status: 'unavailable', reason: 'encryption-material-unavailable' }, true); });
            expect(second.getCurrent().data).toBeNull();
        } finally { await act(async () => { release(); }); }
    });

    it('keeps answered Account rows available while Machine augmentation refreshes without refetching unchanged inputs', async () => {
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_a', source: { kind: 'custom', template: buildCustomProviderTemplate({
                ...createCustomProviderDraft('openai-chat'), name: 'Acme', baseUrl: 'https://models.example.test/v1', requiresApiKey: false,
            }) }, role: 'named', displayName: 'Acme', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }],
        });
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            body: { status: 'present', revision: 1, content: { t: 'plain', v: catalog } },
        });
        let finishRead!: (response: ReturnType<typeof createProviderConnectionsDescribeFixture>) => void;
        const initialMachineReply = createProviderConnectionsDescribeFixture({
            connections: [createProviderConnectionViewFixture({ connectionId: 'pc_a', displayName: 'Acme', displayNameMode: 'custom',
                probeObservationIdentity: ProviderProbeObservationIdentityV1Schema.parse('probe-observation:v1:current-machine') })],
            discoveryCandidates: [{ v: 1, machineId: 'machine-a', contributionKey: 'acme.plugin/acme', providerName: 'Acme',
                endpointTemplateId: 'native', normalizedEndpointUrl: 'http://127.0.0.1:11434/',
                evidence: { kind: 'attributed_listener' }, ownership: 'adopted',
                connection: { status: 'matched', connectionId: ProviderConnectionIdSchema.parse('pc_a') } }],
            localInstallations: [{ v: 1, machineId: 'machine-a', contributionKey: 'acme.plugin/acme', providerName: 'Acme',
                status: 'installed_not_running', managedStartAvailable: true }],
        });
        initialMachineReply.discoveryCandidatesTruncated = true;
        initialMachineReply.localInstallationsStatus = 'incomplete';
        machineRpcWithServerScope.mockResolvedValueOnce(initialMachineReply);
        const hook = await renderHook(() => useProviderConnections({ enabled: true, machineId: 'machine-a', serverId }));
        await vi.waitFor(() => expect(hook.getCurrent().loading).toBe(false));
        const answered = hook.getCurrent().data;
        expect(answered).not.toBeNull();
        machineRpcWithServerScope.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
        let refresh!: Promise<unknown>;
        await act(async () => {
            refresh = hook.getCurrent().refresh();
            await flushHookEffects();
        });
        try {
            await vi.waitFor(() => expect(finishRead).toBeTypeOf('function'));
            expect(hook.getCurrent().data?.connections).toMatchObject([{ connectionId: 'pc_a', displayName: 'Acme' }]);
            expect(hook.getCurrent().data?.connections[0]).toBe(answered?.connections[0]);
            expect(hook.getCurrent().data?.connections[0]?.probeObservationIdentity).toBe('probe-observation:v1:current-machine');
            expect(hook.getCurrent().data).toMatchObject({
                discoveryCandidates: initialMachineReply.discoveryCandidates, discoveryCandidatesTruncated: true,
                localInstallations: initialMachineReply.localInstallations, localInstallationsStatus: 'incomplete',
            });
            expect(hook.getCurrent().catalog?.connections).toMatchObject([{ id: 'pc_a', displayName: 'Acme' }]);
            expect(hook.getCurrent().loading).toBe(false);
            await hook.rerender();
            await hook.rerender();
            expect(machineRpcWithServerScope).toHaveBeenCalledTimes(2);
        } finally {
            await act(async () => {
                finishRead(createProviderConnectionsDescribeFixture({ connections: [] }));
                await refresh;
            });
        }
        expect(hook.getCurrent().data?.connections[0]?.probeObservationIdentity).toBeNull();
        expect(hook.getCurrent().data?.discoveryCandidates).toEqual([]);
        expect(hook.getCurrent().data?.localInstallations).toEqual([]);
    });

    it('replaces a reopened cached Machine answer with fresh Account facts while its new check is pending or refused', async () => {
        let revision = 1;
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => ({ body: { status: 'present', revision, content: { t: 'plain', v: ProviderConnectionsCatalogV1Schema.parse({
                ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
                connections: [{ v: 1, id: 'pc_a', source: { kind: 'custom', template: buildCustomProviderTemplate({
                    ...createCustomProviderDraft('openai-chat'), name: 'Acme', baseUrl: 'https://models.example.test/v1', requiresApiKey: false,
                }) }, role: 'named', displayName: 'Acme', displayNameMode: 'custom', revision, createdAt: 1, updatedAt: revision }],
            }) } } }),
        });
        machineRpcWithServerScope.mockResolvedValueOnce(createProviderConnectionsDescribeFixture({ connections: [
            createProviderConnectionViewFixture({ connectionId: 'pc_a', revision: 1 }),
        ] }));
        const input = { enabled: true, machineId: 'machine-a', serverId, connectionId: 'pc_a' };
        const first = await renderHook(() => useProviderConnections(input));
        await waitForHomeGovernance(() => expect(first.getCurrent().loading).toBe(false));
        await first.unmount();
        revision = 2;
        // A remote write reaches the catalog owner through the same pushed wake
        // even while no reader is mounted; a new consumer does not invent a GET.
        await act(async () => { publishHomeAccountChange(serverId, ['self']); });
        let finish!: (response: unknown) => void;
        machineRpcWithServerScope.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const reopened = await renderHook(() => useProviderConnections(input));
        try {
            await waitForHomeGovernance(() => expect(finish).toBeTypeOf('function'));
            expect(reopened.getCurrent().catalog?.connections[0]?.revision).toBe(2);
            expect(reopened.getCurrent().data?.connections[0]?.revision).toBe(2);
        } finally {
            await act(async () => finish?.({ status: 'error', error: createProviderErrorV1('agent_timeout', { machineId: 'machine-a' }) }));
        }
        await waitForHomeGovernance(() => expect(reopened.getCurrent().loading).toBe(false));
        expect(reopened.getCurrent().machineError?.code).toBe('agent_timeout');
        expect(reopened.getCurrent().data?.connections[0]?.revision).toBe(2);
    });

    it('publishes changed, added and deleted Account facts while retaining only equivalent Machine augmentation', async () => {
        const savedConnection = (id: string, revision: number) => ({
            v: 1, id, source: { kind: 'custom', template: buildCustomProviderTemplate({
                ...createCustomProviderDraft('openai-chat'), name: id,
                baseUrl: id === 'pc_changed' && revision === 2 ? 'https://changed.example.test/v1' : 'https://models.example.test/v1',
                requiresApiKey: false,
            }) }, role: 'named', displayName: `${id} ${revision}`, displayNameMode: 'custom', revision, createdAt: 1, updatedAt: revision,
        });
        let catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [savedConnection('pc_a', 1), savedConnection('pc_renamed', 1), savedConnection('pc_changed', 1),
                savedConnection('pc_deleted', 1), savedConnection('pc_grant', 1)],
            accountGrants: [{ v: 1, connectionId: 'pc_grant', connectionSecurityFingerprint: 'stale-account-grant', confirmedAt: 1 }],
        });
        let catalogRevision = 1;
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => ({ body: { status: 'present', revision: catalogRevision, content: { t: 'plain', v: catalog } } }),
        });
        machineRpcWithServerScope.mockResolvedValue(createProviderConnectionsDescribeFixture({
            connections: catalog.connections.map(row => createProviderConnectionViewFixture({
                connectionId: row.id, revision: row.revision, displayName: row.displayName,
                probeObservationIdentity: ProviderProbeObservationIdentityV1Schema.parse(`probe-observation:v1:${row.id}`),
            })),
        }));
        const hook = await renderHook(() => useProviderConnections({ enabled: true, machineId: 'machine-a', serverId }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().data?.connections[0]?.probeObservationIdentity).toBe('probe-observation:v1:pc_a'));
        catalog = ProviderConnectionsCatalogV1Schema.parse({ ...catalog,
            connections: [savedConnection('pc_a', 1), savedConnection('pc_renamed', 2), savedConnection('pc_changed', 2),
                savedConnection('pc_new', 1), savedConnection('pc_grant', 1)],
            accountGrants: [],
        });
        catalogRevision += 1;
        let finishRead!: (response: ReturnType<typeof createProviderConnectionsDescribeFixture>) => void;
        machineRpcWithServerScope.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
        let refresh!: Promise<unknown>;
        let refreshCompleted = false;
        await act(async () => { refresh = hook.getCurrent().refresh().finally(() => { refreshCompleted = true; }); });
        try {
            await waitForHomeGovernance(() => expect(typeof finishRead === 'function' || refreshCompleted).toBe(true));
            expect({ machineReadStarted: typeof finishRead === 'function', error: hook.getCurrent().error,
                machineError: hook.getCurrent().machineError }).toMatchObject({ machineReadStarted: true, error: null });
            expect(hook.getCurrent().data?.connections.map(row => ({
                connectionId: row.connectionId, revision: row.revision, probeObservationIdentity: row.probeObservationIdentity,
            }))).toEqual([
                { connectionId: 'pc_a', revision: 1, probeObservationIdentity: 'probe-observation:v1:pc_a' },
                { connectionId: 'pc_renamed', revision: 2, probeObservationIdentity: 'probe-observation:v1:pc_renamed' },
                { connectionId: 'pc_changed', revision: 2, probeObservationIdentity: null },
                { connectionId: 'pc_new', revision: 1, probeObservationIdentity: null },
                { connectionId: 'pc_grant', revision: 1, probeObservationIdentity: null },
            ]);
            expect(hook.getCurrent().data?.connections.find(row => row.connectionId === 'pc_renamed')?.displayName).toBe('pc_renamed 2');
            expect(hook.getCurrent().data?.connections.find(row => row.connectionId === 'pc_grant')?.grants.accountState).toBe('absent');
        } finally {
            await act(async () => {
                finishRead?.(createProviderConnectionsDescribeFixture({ connections: [] }));
                await refresh;
            });
        }
    });

    it('publishes changed Account data once and equal refreshes never with collection and detail readers mounted', async () => {
        let revision = 1;
        let catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_a', source: { kind: 'custom', template: buildCustomProviderTemplate({
                ...createCustomProviderDraft('openai-chat'), name: 'Acme', baseUrl: 'https://models.example.test/v1', requiresApiKey: false,
            }) }, role: 'named', displayName: 'Acme', displayNameMode: 'custom', revision, createdAt: 1, updatedAt: 1 }],
        });
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => ({ body: { status: 'present', revision, content: { t: 'plain', v: catalog } } }),
        });
        machineRpcWithServerScope.mockResolvedValue(createProviderConnectionsDescribeFixture({ connections: [] }));
        const hook = await renderHook(() => ({
            collection: useProviderConnections({ enabled: true, machineId: 'machine-a', serverId }),
            detail: useProviderConnections({ enabled: true, machineId: 'machine-a', serverId, connectionId: 'pc_a' }),
        }));
        await waitForHomeGovernance(() => {
            expect(hook.getCurrent().collection.data?.connections[0]?.displayName).toBe('Acme');
            expect(hook.getCurrent().detail.data?.connections[0]?.displayName).toBe('Acme');
        });
        const scope = captureActiveServerAccountScopeLifetime()!.scope;
        const initial = getProviderCatalogSnapshot(scope);
        let publications = 0;
        const release = subscribeProviderCatalogSnapshots(() => { publications += 1; });
        try {
            revision += 1;
            catalog = ProviderConnectionsCatalogV1Schema.parse({ ...catalog,
                connections: catalog.connections.map(row => ({ ...row, displayName: 'Renamed', revision, updatedAt: 2 })),
            });
            await act(async () => { await hook.getCurrent().detail.refresh(); });
            expect(publications).toBe(1);
            const changed = getProviderCatalogSnapshot(scope);
            expect(changed).not.toBe(initial);
            expect(changed?.data?.connections[0]?.displayName).toBe('Renamed');
            expect(hook.getCurrent().collection.data?.connections[0]?.displayName).toBe('Renamed');
            expect(hook.getCurrent().detail.data?.connections[0]?.displayName).toBe('Renamed');

            publications = 0;
            for (let index = 0; index < 10; index += 1) {
                await act(async () => { await hook.getCurrent().detail.refresh(); });
            }
            expect(publications).toBe(0);
            expect(getProviderCatalogSnapshot(scope)).toBe(changed);
            expect(hook.getCurrent().collection.data?.connections[0]?.displayName).toBe('Renamed');
            expect(hook.getCurrent().detail.data?.connections[0]?.displayName).toBe('Renamed');
        } finally { release(); }
    });

    it('clears machine A projection before awaiting machine B', async () => {
        machineRpcWithServerScope.mockResolvedValueOnce(createProviderConnectionsDescribeFixture({
            connections: [createProviderConnectionViewFixture({ connectionId: 'pc_a' })],
        }));
        machineRpcWithServerScope.mockImplementationOnce(() => new Promise(() => undefined));
        const hook = await renderHook(
            ({ machineId }: { machineId: string }) => useProviderConnections({
                enabled: true, machineId, serverId,
            }),
            { initialProps: { machineId: 'machine-a' } },
        );
        await vi.waitFor(() => expect(hook.getCurrent().data?.connections[0]?.connectionId).toBe('pc_a'));

        await hook.rerender({ machineId: 'machine-b' });
        expect(hook.getCurrent().data?.connections).toEqual([]);
    });

    it('never exposes a prior exact target during the render that changes machine, server, or connection', async () => {
        machineRpcWithServerScope
            .mockResolvedValueOnce(createProviderConnectionsDescribeFixture({
                connections: [createProviderConnectionViewFixture({ connectionId: 'pc_a' })],
            }))
            .mockImplementation(() => new Promise(() => undefined));
        const observations: Array<Readonly<{
            scope: string;
            connectionId: string | null;
        }>> = [];
        function Harness(props: Readonly<{ machineId: string; serverId: string; connectionId: string }>) {
            const value = useProviderConnections({ enabled: true, ...props });
            observations.push({
                scope: `${props.serverId}/${props.machineId}/${props.connectionId}`,
                connectionId: value.data?.connections[0]?.connectionId ?? null,
            });
            return React.createElement('View');
        }
        const screen = await renderScreen(
            <Harness machineId="machine-a" serverId={serverId} connectionId="pc_a" />,
        );
        await vi.waitFor(() => expect(observations.at(-1)?.connectionId).toBe('pc_a'));

        for (const next of [
            { machineId: 'machine-b', serverId, connectionId: 'pc_a' },
            { machineId: 'machine-b', serverId: otherServerId, connectionId: 'pc_a' },
            { machineId: 'machine-b', serverId: otherServerId, connectionId: 'pc_b' },
        ]) {
            const scope = `${next.serverId}/${next.machineId}/${next.connectionId}`;
            await screen.update(<Harness {...next} />);
            expect(observations.some((entry) => (
                entry.scope === scope && entry.connectionId === 'pc_a'
            ))).toBe(false);
        }
    });

    it('clears Account A, rejects its late read, and starts one Account B read when routing ids stay equal', async () => {
        let resolveA!: (value: unknown) => void;
        let resolveB!: (value: unknown) => void;
        machineRpcWithServerScope
            .mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }))
            .mockImplementationOnce(() => new Promise((resolve) => { resolveB = resolve; }));
        const hook = await renderHook(() => useProviderConnections({
            enabled: true,
            machineId: 'machine-a',
            serverId,
        }));
        const refreshFromAccountA = hook.getCurrent().refresh;
        await vi.waitFor(() => expect(machineRpcWithServerScope).toHaveBeenCalledTimes(1));

        await act(async () => {
            await account.restore({ accountId: 'account-b',
                machines: [createMachineFixture({ id: 'machine-a', active: true, activeAt: Date.now() })],
            });
            await hook.rerender();
        });

        // Account A disappears synchronously. Machine dispatch is not a React
        // commit barrier: wait for Account B's actual empty Account answer while
        // its optional Machine augmentation is still held.
        expect(hook.getCurrent().data?.connections ?? []).toEqual([]);
        await waitForHomeGovernance(() => expect(machineRpcWithServerScope).toHaveBeenCalledTimes(2));
        await waitForHomeGovernance(() => expect(hook.getCurrent().data?.connections).toEqual([]));

        await act(async () => {
            resolveA(createProviderConnectionsDescribeFixture({
                connections: [createProviderConnectionViewFixture({ connectionId: 'pc_a' })],
            }));
        });
        expect(hook.getCurrent().data?.connections).toEqual([]);

        await act(async () => {
            resolveB(createProviderConnectionsDescribeFixture({
                connections: [createProviderConnectionViewFixture({ connectionId: 'pc_b' })],
            }));
        });
        expect(hook.getCurrent().data?.connections[0]?.connectionId).toBe('pc_b');

        await act(async () => { await refreshFromAccountA(); });
        expect(machineRpcWithServerScope).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().data?.connections[0]?.connectionId).toBe('pc_b');
    });

    it('retains the admitted Machine check and reports an untyped refresh transport failure separately', async () => {
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_a', source: { kind: 'custom', template: buildCustomProviderTemplate({
                ...createCustomProviderDraft('openai-chat'), name: 'Acme', baseUrl: 'https://models.example.test/v1', requiresApiKey: false,
            }) }, role: 'named', displayName: 'Acme', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }],
        });
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            body: { status: 'present', revision: 1, content: { t: 'plain', v: catalog } },
        });
        machineRpcWithServerScope
            .mockResolvedValueOnce(createProviderConnectionsDescribeFixture({
                connections: [createProviderConnectionViewFixture({ connectionId: 'pc_a' })],
            }))
            .mockRejectedValueOnce(new Error('offline'));
        const hook = await renderHook(() => useProviderConnections({
            enabled: true, machineId: 'machine-a', serverId,
        }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().data?.connections[0]?.runtime.checkedAt).toBe(1));
        await act(async () => { await hook.getCurrent().refresh(); });
        expect(hook.getCurrent()).toMatchObject({
            data: { connections: [{ connectionId: 'pc_a', runtime: { health: 'available', checkedAt: 1 } }] },
            error: null,
            machineError: createProviderErrorV1('machine_offline', {
                machineId: 'machine-a',
            }),
            loading: false,
        });
    });

    it('reports a successful transport with an invalid response as a contract failure, not an unreachable endpoint', async () => {
        machineRpcWithServerScope.mockResolvedValueOnce(createProviderConnectionsDescribeFixture({ connections: [] }));
        providerHarness.transformAcknowledgement(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, (_request, acknowledgement) => ({
            ...acknowledgement,
            result: { ...createProviderConnectionsDescribeFixture({ connections: [] }), rawSecret: 'must-not-surface' },
        }));

        const hook = await renderHook(() => useProviderConnections({
            enabled: true, machineId: 'machine-a', serverId,
        }));

        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({
            data: { connections: [] },
            error: null,
            machineError: {
                v: 1,
                code: 'provider_rpc_response_invalid',
                machineId: 'machine-a',
                retryable: true,
                action: 'retry',
            },
            loading: false,
        }));
        expect(hook.getCurrent().machineError?.code).not.toBe('provider_endpoint_unavailable');
    });
});
