import { act } from 'react-test-renderer';
import * as React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1 } from '@happier-dev/protocol';
import { DaemonProviderConnectionMutationResponseV1Schema, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, ProviderConnectionsCatalogV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { PROVIDER_CONNECTION_ACTION_ID_BY_OPERATION_V1 } from '@happier-dev/protocol/providers/providerActionsV1';
import { createProviderConnectionViewFixture, createProviderSettingsAccountHarness, createProviderSettingsHarness, installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { buildCustomProviderTemplate, createCustomProviderDraft } from '@/providers/authoring/state';

// Only Socket transport is substituted; Account HTTP/CAS and scoped Machine routing stay real.
const providerHarness = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(providerHarness);
const account = createProviderSettingsAccountHarness();
let serverId = '';
let otherServerId = '';
const { useProviderConnectionMutation } = await import('./useProviderConnectionMutation');
const { useProviderEndpointConfiguration } = await import('./useProviderEndpointConfiguration');
const { useProviderActionClient } = await import('@/providers/actions/useProviderActionClient');
const resolveTarget = () => ({ machineId: 'machine-a', serverId });
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(next => { resolve = next; });
    return { promise, resolve };
}
function customTemplate() {
    return buildCustomProviderTemplate({ ...createCustomProviderDraft('openai-responses'),
        name: 'Account source', baseUrl: 'https://models.example.test/v1', requiresApiKey: false });
}
function persistedCatalog() {
    const content = account.readCatalogRow()?.content;
    if (content?.t !== 'plain') throw new Error('Expected keyless Plain Account row');
    return ProviderConnectionsCatalogV1Schema.parse(content.v);
}
async function renderMutation(input: Parameters<typeof useProviderConnectionMutation>[0]) {
    const hook = await renderHook(() => ({
        ...useProviderConnectionMutation(input), ready: useProviderActionClient(input.serverId ?? serverId).ready,
    }));
    await waitForHomeGovernance(() => expect(hook.getCurrent().ready).toBe(true));
    return hook;
}
const machineEnable = () => ({ action: 'setEnabled' as const, scope: 'machine' as const,
    machineId: 'machine-a', connectionId: 'pc_a', enabled: true });

beforeAll(loadSyncSingletonForTests);
describe('useProviderConnectionMutation', () => {
    it('settles a non-replying machine write after target selection changes and permits the new target request', async () => {
        await account.publishMachines(serverId, ['machine-a', 'machine-b'].map(id => createMachineFixture({ id, active: true, activeAt: Date.now() })));
        let requests = 0;
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE, async (_request, next) => {
            if (++requests === 1) return await new Promise<never>(() => {});
            return await next();
        });
        const refresh = async () => {};
        const hook = await renderHook((props: { machineId: string }) => {
            const target = React.useCallback(() => ({ machineId: props.machineId, serverId }), [props.machineId]);
            return { ...useProviderConnectionMutation({ resolveTarget: target, serverId, refresh }),
                ready: useProviderActionClient(serverId).ready };
        }, { initialProps: { machineId: 'machine-a' } });
        await waitForHomeGovernance(() => expect(hook.getCurrent().ready).toBe(true));
        let settled = false;
        let pending: Promise<unknown> | undefined;
        await act(async () => { pending = hook.getCurrent().run(machineEnable()).finally(() => { settled = true; }); });
        await waitForHomeGovernance(() => expect(requests).toBe(1));
        await hook.rerender({ machineId: 'machine-b' });
        await act(async () => {});
        expect(settled).toBe(true);
        await pending;
        await act(async () => { await hook.getCurrent().run({ ...machineEnable(), machineId: 'machine-b' }); });
        expect(requests).toBe(2);
        expect(hook.getCurrent().isPending('setEnabled:pc_a')).toBe(false);
    });

    afterEach(async () => { await standardCleanup(); await account.reset(); });
    beforeEach(async () => {
        providerHarness.reset();
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: ['pc_a', 'pc_prior', 'pc_first', 'pc_second', 'pc_other'].map(id => ({
                v: 1, id, source: { kind: 'custom', template: customTemplate() }, role: 'named',
                displayName: id, displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1,
            })),
        });
        serverId = (await account.restore({ catalog,
            waivedActions: Object.values(PROVIDER_CONNECTION_ACTION_ID_BY_OPERATION_V1),
            machines: [createMachineFixture({ id: 'machine-a', active: true, activeAt: Date.now() })],
        })).serverId;
        otherServerId = await account.addHome({ name: 'Other Provider Home',
            serverUrl: 'https://provider-settings-other.test', accountId: 'account-b', active: false });
    });

    it('reconciles a committed Account write whose HTTP receipt was lost without exposing replay', async () => {
        const events: string[] = [];
        account.interceptCatalogMutation((_input, next) => {
            next(); events.push('commit'); return { dispatchThenFail: true };
        });
        const refresh = vi.fn(async () => { events.push('refresh'); });
        const hook = await renderMutation({ resolveTarget, serverId, refresh });
        await act(async () => { await hook.getCurrent().run({ action: 'delete', connectionId: 'pc_a' }); });
        expect(hook.getCurrent().error).toMatchObject({ code: 'provider_rpc_mutation_outcome_unknown', action: 'review_current_state' });
        expect(hook.getCurrent().retry).toBeUndefined();
        expect(hook.getCurrent().isPending('delete:pc_a')).toBe(false);
        expect(persistedCatalog().connections.some(row => row.id === 'pc_a')).toBe(false);
        expect(account.readCatalogRow()?.revision).toBe(2);
        expect(events).toEqual(['commit', 'refresh']);
        expect(account.catalogMutations).toHaveLength(1);
        expect(providerHarness.state.requests).toEqual([]);
    });

    it('presents the authoritative policy change before person confirmation and cancels without writing', async () => {
        const catalog = persistedCatalog();
        await account.reset();
        serverId = (await account.restore({ accountId: 'account-policy-confirmation', catalog, waivedActions: [] })).serverId;
        const endpointTemplateId = customTemplate().endpointTemplates[0]!.id;
        let confirmation: unknown;
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const executor = createDefaultActionExecutor({ presentUserActionConfirmation: async request => {
            confirmation = request;
            return false;
        } });
        const result = await executor.execute('providers.connections.endpoint.set', {
            action: 'setEndpointOverride', connectionId: 'pc_a', expectedRevision: 1, scope: 'account', endpointTemplateId,
            publicHeaders: { 'x-request-policy': 'deliberate' },
        }, { surface: 'ui', serverId, authority: 'present_user', actionCaller: { kind: 'host' } });
        expect(result).toMatchObject({ ok: false, errorCode: 'approval_canceled' });
        expect(confirmation).toMatchObject({ preview: { providerEndpointPolicyReview: {
            scope: 'account', before: { publicHeaders: {} }, after: { publicHeaders: { 'x-request-policy': 'deliberate' } },
        } } });
        expect(account.catalogMutations).toHaveLength(0);
    });

    it('edits and resets policy independently through the same Account Action without pinning an inherited address', async () => {
        const endpointTemplateId = customTemplate().endpointTemplates[0]!.id;
        const connection = createProviderConnectionViewFixture({ connectionId: 'pc_a' });
        const refresh = async () => {};
        const hook = await renderHook((props: { revision: number }) => {
            const mutation = useProviderConnectionMutation({ resolveTarget, serverId, refresh });
            const actions = useProviderActionClient(serverId);
            return { ...useProviderEndpointConfiguration({ connection: { ...connection, revision: props.revision },
                machineId: null, mutation, onChange: () => {} }), ready: actions.ready,
                describe: actions.describeProviderConnections };
        }, { initialProps: { revision: 1 } });
        await waitForHomeGovernance(() => expect(hook.getCurrent().ready).toBe(true));
        expect(account.catalogMutations).toHaveLength(0);
        expect(hook.getCurrent().endpoints).toBe(connection.endpoints);

        await act(async () => { expect(await hook.getCurrent().patch({ endpointTemplateId, scope: 'account',
            publicHeaders: { 'x-request-policy': 'deliberate' } })).toBe(true); });
        expect(persistedCatalog().connections.find(row => row.id === 'pc_a')?.endpointOverrides).toEqual([
            { endpointTemplateId, publicHeaders: { 'x-request-policy': 'deliberate' } },
        ]);
        const view = await hook.getCurrent().describe({ serverId, connectionId: 'pc_a' });
        expect(view).toMatchObject({ status: 'success', connections: [{ endpoints: [{
            baseUrl: 'https://models.example.test/v1', publicHeaders: { 'x-request-policy': 'deliberate' },
            publicHeaderSources: { 'x-request-policy': 'accountOverride' },
        }] }] });

        await hook.rerender({ revision: 2 });
        await act(async () => { expect(await hook.getCurrent().patch({ endpointTemplateId, scope: 'account', publicHeaders: null })).toBe(true); });
        expect(persistedCatalog().connections.find(row => row.id === 'pc_a')?.endpointOverrides ?? []).toEqual([]);
        expect(providerHarness.state.requests).toEqual([]);
    });

    it('coalesces an identical pending Account edit before issuing a second CAS write', async () => {
        const gate = deferred();
        account.interceptCatalogMutation(async (_input, next) => { await gate.promise; return next(); });
        const refresh = vi.fn(async () => undefined);
        const hook = await renderMutation({ resolveTarget, serverId, refresh });
        const request = { action: 'delete' as const, connectionId: 'pc_a' };
        let first!: Promise<unknown>;
        let duplicate!: Promise<unknown>;
        try {
            await act(async () => { first = hook.getCurrent().run(request); duplicate = hook.getCurrent().run({ ...request }); });
            await waitForHomeGovernance(() => expect(account.catalogMutations).toHaveLength(1));
            expect(duplicate).toBe(first);
            expect(hook.getCurrent().isPending('delete:pc_a')).toBe(true);
        } finally { await act(async () => { gate.resolve(); await Promise.all([first, duplicate]); }); }
        expect(refresh).toHaveBeenCalledOnce();
        expect(account.readCatalogRow()?.revision).toBe(2);
        expect(hook.getCurrent().isPending('delete:pc_a')).toBe(false);
    });

    it('keeps a captured Account callback stable across unrelated re-renders', async () => {
        const gate = deferred();
        account.interceptCatalogMutation(async (_input, next) => { await gate.promise; return next(); });
        const refresh = vi.fn(async () => undefined);
        const input = { resolveTarget, serverId, refresh };
        const hook = await renderHook(({ unrelated }: { unrelated: number }) => {
            void unrelated;
            return { ...useProviderConnectionMutation(input), ready: useProviderActionClient(serverId).ready };
        }, { initialProps: { unrelated: 0 } });
        await waitForHomeGovernance(() => expect(hook.getCurrent().ready).toBe(true));
        const captured = hook.getCurrent().run;
        await hook.rerender({ unrelated: 1 });
        expect(hook.getCurrent().run).toBe(captured);
        let first!: Promise<unknown>;
        let current!: Promise<unknown>;
        try {
            await act(async () => {
                first = captured({ action: 'delete', connectionId: 'pc_a' });
                current = hook.getCurrent().run({ action: 'delete', connectionId: 'pc_a' });
            });
            await waitForHomeGovernance(() => expect(account.catalogMutations).toHaveLength(1));
            expect(current).toBe(first);
        } finally { await act(async () => { gate.resolve(); await Promise.all([first, current]); }); }
        expect(refresh).toHaveBeenCalledOnce();
    });

    it('refuses a modal-delayed Machine enable after selection moves to another machine', async () => {
        const selected = { current: { machineId: 'machine-a', serverId } };
        const resolver = () => selected.current;
        const refresh = vi.fn(async () => undefined);
        const hook = await renderMutation({ resolveTarget: resolver, serverId, refresh });
        selected.current = { machineId: 'machine-b', serverId: otherServerId };
        await act(async () => { await hook.getCurrent().run(machineEnable()); });
        expect(hook.getCurrent().error).toEqual(createProviderErrorV1('provider_authorization_changed', {
            machineId: 'machine-a', connectionId: 'pc_a',
        }));
        expect(providerHarness.state.requests).toEqual([]);
        expect(account.catalogMutations).toHaveLength(0);
        expect(refresh).not.toHaveBeenCalled();
    });

    it('refuses captured Machine enable after another Home selects the same machine id', async () => {
        const selected = { current: { serverId, machineId: 'machine-a' } };
        const onA = () => selected.current.serverId === serverId ? selected.current : null;
        const onB = () => selected.current.serverId === otherServerId ? selected.current : null;
        const refresh = vi.fn(async () => undefined);
        const hook = await renderHook(({ resolver }: { resolver: typeof onA }) => ({
            ...useProviderConnectionMutation({ resolveTarget: resolver, refresh }),
            ready: useProviderActionClient(serverId).ready,
        }), { initialProps: { resolver: onA } });
        await waitForHomeGovernance(() => expect(hook.getCurrent().ready).toBe(true));
        const captured = hook.getCurrent().run;
        selected.current = { serverId: otherServerId, machineId: 'machine-a' };
        await hook.rerender({ resolver: onB });
        await act(async () => { await captured(machineEnable()); });
        expect(hook.getCurrent().error?.code).toBe('provider_authorization_changed');
        expect(providerHarness.state.requests).toEqual([]);
        expect(refresh).not.toHaveBeenCalled();
    });

    it('issues Machine enable through the routing identity resolved at effect time', async () => {
        const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
        await setServerProfileIdentityForUrl('https://provider-settings-account.test', 'srv_provider_settings');
        const selected = { current: { machineId: 'machine-a', serverId } };
        const resolver = () => selected.current;
        const refresh = vi.fn(async () => undefined);
        providerHarness.enqueueResponse(RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE, { status: 'success', action: 'setEnabled',
            connection: createProviderConnectionViewFixture({ connectionId: 'pc_a' }) });
        const hook = await renderMutation({ resolveTarget: resolver, refresh });
        selected.current = { machineId: 'machine-a', serverId: 'srv_provider_settings' };
        await act(async () => { await hook.getCurrent().run(machineEnable()); });
        expect(providerHarness.state.requests).toEqual([expect.objectContaining({
            serverId: 'srv_provider_settings', machineId: 'machine-a',
            method: RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE,
            payload: expect.objectContaining({ action: 'setEnabled', connectionId: 'pc_a', enabled: true }),
        })]);
        expect(hook.getCurrent().error).toBeNull();
        expect(account.catalogMutations).toHaveLength(0);
    });

    it('refuses Machine enable when the selected machine is no longer reachable', async () => {
        const refresh = vi.fn(async () => undefined);
        const hook = await renderMutation({ resolveTarget: () => null, serverId, refresh });
        await act(async () => { await hook.getCurrent().run(machineEnable()); });
        expect(providerHarness.state.requests).toEqual([]);
        expect(hook.getCurrent().error?.code).toBe('provider_authorization_changed');
    });

    it('coalesces canonically equal Account requests but not material differences', async () => {
        const gate = deferred();
        account.interceptCatalogMutation(async (_input, next) => { await gate.promise; return next(); });
        const refresh = vi.fn(async () => undefined);
        const hook = await renderMutation({ resolveTarget, serverId, refresh });
        const template = customTemplate();
        const request = { action: 'createCustom' as const, connectionId: 'pc_custom',
            template: { ...template, name: ' ' + template.name + ' ' }, savedSecretId: null, enable: false };
        let first!: Promise<unknown>;
        let equivalent!: Promise<unknown>;
        let different!: Promise<unknown>;
        let results: unknown[] = [];
        try {
            await act(async () => {
                first = hook.getCurrent().run(request, 'save');
                equivalent = hook.getCurrent().run({ ...request, template, manualModels: [] }, 'save');
                different = hook.getCurrent().run({ ...request, connectionId: 'pc_different' }, 'save');
            });
            expect(equivalent).toBe(first);
            expect(different).not.toBe(first);
            await waitForHomeGovernance(() => expect(account.catalogMutations.length).toBeGreaterThanOrEqual(1));
        } finally { await act(async () => { gate.resolve(); results = await Promise.all([first, equivalent, different]); }); }
        expect(account.catalogMutations).toHaveLength(2);
        expect(account.catalogMutations.every(input => input.expectedRevision === 1)).toBe(true);
        // Distinct requests must not coalesce, but concurrent edits share one Account CAS revision.
        const acknowledgements = [results[0], results[2]].flatMap(result => {
            const parsed = DaemonProviderConnectionMutationResponseV1Schema.safeParse(result);
            return parsed.success && parsed.data.status === 'success' && parsed.data.action === 'createCustom' ? [parsed.data] : [];
        });
        expect(acknowledgements).toHaveLength(1);
        const winner = acknowledgements[0]!;
        expect(persistedCatalog().connections.filter(row => row.id === 'pc_custom' || row.id === 'pc_different')).toHaveLength(1);
        expect(account.readCatalogRow()?.revision).toBe(2);
        expect(persistedCatalog().connections.find(row => row.id === winner.connection.connectionId)?.source).toMatchObject({
            kind: 'custom', template: { name: template.name },
        });
        expect(providerHarness.state.requests).toEqual([]);
    });

    it('keeps every current-scope UI key pending until its own Account requests settle', async () => {
        const gates = Array.from({ length: 4 }, deferred);
        let issued = 0;
        account.interceptCatalogMutation(async (_input, next) => { await gates[issued++]!.promise; return next(); });
        const refreshA = vi.fn(async () => undefined);
        const refreshB = vi.fn(async () => undefined);
        const hook = await renderHook(({ refresh }: { refresh: () => Promise<void> }) => ({
            ...useProviderConnectionMutation({ resolveTarget, serverId, refresh }), ready: useProviderActionClient(serverId).ready,
        }), { initialProps: { refresh: refreshA } });
        await waitForHomeGovernance(() => expect(hook.getCurrent().ready).toBe(true));
        const executions: Promise<unknown>[] = [];
        try {
            await act(async () => { executions.push(hook.getCurrent().run({ action: 'delete', connectionId: 'pc_prior' }, 'shared')); });
            await waitForHomeGovernance(() => expect(account.catalogMutations).toHaveLength(1));
            await hook.rerender({ refresh: refreshB });
            await act(async () => {
                executions.push(hook.getCurrent().run({ action: 'delete', connectionId: 'pc_first' }, 'shared'));
                executions.push(hook.getCurrent().run({ action: 'delete', connectionId: 'pc_second' }, 'shared'));
                executions.push(hook.getCurrent().run({ action: 'delete', connectionId: 'pc_other' }, 'other'));
            });
            const observed = [[hook.getCurrent().isPending('shared'), hook.getCurrent().isPending('other')]];
            for (let index = 0; index < 4; index++) {
                await act(async () => { gates[index]!.resolve(); await executions[index]; });
                observed.push([hook.getCurrent().isPending('shared'), hook.getCurrent().isPending('other')]);
            }
            expect(observed).toEqual([[true, true], [true, true], [true, true], [false, true], [false, false]]);
        } finally { await act(async () => { gates.forEach(gate => gate.resolve()); await Promise.all(executions); }); }
        expect(refreshA).not.toHaveBeenCalled();
        expect(refreshB).toHaveBeenCalledWith('account');
        expect(account.catalogMutations).toHaveLength(4);
        expect(account.readCatalogRow()?.revision).toBe(2);
        expect(persistedCatalog().connections.map(row => row.id)).toEqual(['pc_a', 'pc_first', 'pc_second', 'pc_other']);
        expect(hook.getCurrent().error?.code).toBe('provider_connection_changed');
        expect(hook.getCurrent()).not.toHaveProperty('pendingKey');
    });

    it('reviews a Machine mutation with a malformed acknowledgement without offering replay', async () => {
        providerHarness.transformAcknowledgement(RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE, (_request, acknowledgement) => ({
            ...acknowledgement, result: { status: 'success', action: 'setEnabled' },
        }));
        const refresh = vi.fn(async () => undefined);
        const hook = await renderMutation({ resolveTarget, serverId, refresh });
        await act(async () => { await hook.getCurrent().run(machineEnable()); });
        expect(providerHarness.state.requests).toEqual([expect.objectContaining({
            machineId: 'machine-a', method: RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE,
            payload: expect.objectContaining({ action: 'setEnabled', connectionId: 'pc_a' }),
        })]);
        expect(refresh).toHaveBeenCalledOnce();
        expect(hook.getCurrent().error?.code).toBe('provider_rpc_mutation_outcome_unknown');
        expect(hook.getCurrent().retry).toBeUndefined();
    });

    it('preserves acknowledged Account create, update and delete when only their follow-up read fails', async () => {
        const refresh = vi.fn(async () => { throw new Error('catalog refresh unavailable'); });
        const hook = await renderMutation({ resolveTarget, serverId, refresh });
        const requests = [
            { action: 'createCustom' as const, connectionId: 'pc_created', template: customTemplate(), savedSecretId: null, enable: false },
            { action: 'update' as const, connectionId: 'pc_created', expectedRevision: 0, displayName: 'Updated', displayNameMode: 'custom' as const },
            { action: 'delete' as const, connectionId: 'pc_created' },
        ];
        for (const request of requests) {
            let result: unknown;
            await act(async () => { result = await hook.getCurrent().run(request); });
            expect(result).toMatchObject({ status: 'success', action: request.action });
            expect(hook.getCurrent().error?.code).toBe('agent_error');
            expect(hook.getCurrent().retry).toBeTypeOf('function');
            const writesBeforeRetry = account.catalogMutations.length;
            await act(async () => { await expect(hook.getCurrent().retry?.()).rejects.toThrow('catalog refresh unavailable'); });
            expect(account.catalogMutations).toHaveLength(writesBeforeRetry);
            if (request.action === 'createCustom') expect(persistedCatalog().connections.find(row => row.id === 'pc_created')?.revision).toBe(0);
            if (request.action === 'update') expect(persistedCatalog().connections.find(row => row.id === 'pc_created'))
                .toMatchObject({ displayName: 'Updated', revision: 1 });
        }
        expect(persistedCatalog().connections.some(row => row.id === 'pc_created')).toBe(false);
        expect(account.readCatalogRow()?.revision).toBe(4);
        expect(refresh).toHaveBeenCalledTimes(6);
        expect(providerHarness.state.requests).toEqual([]);
    });

    it('does not refresh or publish a pending Account result after the Account retires', async () => {
        const gate = deferred();
        account.interceptCatalogMutation(async (_input, next) => { await gate.promise; return next(); });
        const refresh = vi.fn(async () => undefined);
        const hook = await renderMutation({ resolveTarget, serverId, refresh });
        let execution!: Promise<unknown>;
        try {
            await act(async () => { execution = hook.getCurrent().run({ action: 'delete', connectionId: 'pc_a' }); });
            await waitForHomeGovernance(() => expect(account.catalogMutations).toHaveLength(1));
            await act(async () => { await account.home.switchAccount(serverId, 'account-b'); });
        } finally { await act(async () => { gate.resolve(); await execution; }); }
        expect(refresh).not.toHaveBeenCalled();
        expect(hook.getCurrent().error).toBeNull();
        expect(hook.getCurrent().isPending('delete:pc_a')).toBe(false);
        expect(account.catalogMutations).toHaveLength(1);
        expect(providerHarness.state.requests).toEqual([]);
    });
    it('writes Account configuration without a selected machine and keeps its receipt across a machine-only change', async () => {
        const gate = deferred();
        account.interceptCatalogMutation(async (_input, next) => { await gate.promise; return next(); });
        const refresh = vi.fn(async () => undefined);
        const onA = () => ({ machineId: 'machine-a', serverId });
        const onB = () => ({ machineId: 'machine-b', serverId });
        const hook = await renderHook(({ resolver }: { resolver: typeof onA }) => ({
            ...useProviderConnectionMutation({ resolveTarget: resolver, serverId, refresh }),
            ready: useProviderActionClient(serverId).ready,
        }), { initialProps: { resolver: onA } });
        await waitForHomeGovernance(() => expect(hook.getCurrent().ready).toBe(true));
        let execution!: Promise<unknown>;
        let result: unknown;
        try {
            await act(async () => { execution = hook.getCurrent().run({ action: 'delete', connectionId: 'pc_a' }); });
            await waitForHomeGovernance(() => expect(account.catalogMutations).toHaveLength(1));
            await hook.rerender({ resolver: onB });
            expect(hook.getCurrent().isPending('delete:pc_a')).toBe(true);
        } finally { await act(async () => { gate.resolve(); result = await execution; }); }
        expect(result).toMatchObject({ status: 'success', action: 'delete' });
        expect(refresh).toHaveBeenCalledOnce();
        expect(persistedCatalog().connections.some(row => row.id === 'pc_a')).toBe(false);
        expect(providerHarness.state.requests).toEqual([]);
        const accountOnly = await renderMutation({ resolveTarget: () => null, serverId, refresh });
        await act(async () => { await accountOnly.getCurrent().run({ action: 'delete', connectionId: 'pc_first' }); });
        expect(persistedCatalog().connections.some(row => row.id === 'pc_first')).toBe(false);
        expect(providerHarness.state.requests).toEqual([]);
    });

    it('settles an acknowledged Account mutation while its presentation refresh remains pending', async () => {
        const refreshGate = deferred();
        const refresh = vi.fn(() => refreshGate.promise);
        const hook = await renderMutation({ resolveTarget, serverId, refresh });
        let execution!: Promise<unknown>;
        try {
            await act(async () => { execution = hook.getCurrent().run({ action: 'delete', connectionId: 'pc_a' }); });
            await waitForHomeGovernance(() => expect(refresh).toHaveBeenCalledOnce());
            await act(async () => { await expect(execution).resolves.toMatchObject({ status: 'success', action: 'delete' }); });
            expect(hook.getCurrent().isPending('delete:pc_a')).toBe(false);
            expect(persistedCatalog().connections.some(row => row.id === 'pc_a')).toBe(false);
        } finally { await act(async () => { refreshGate.resolve(); }); }
        expect(providerHarness.state.requests).toEqual([]);
    });

});
