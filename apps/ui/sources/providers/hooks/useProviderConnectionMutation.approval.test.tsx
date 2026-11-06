import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createProviderSettingsHarness, installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
    ProviderConnectionsCatalogV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { createProviderSettingsAccountHarness, createProviderConnectionViewFixture, installProviderConnectionsCatalogHttpBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { buildCustomProviderTemplate, createCustomProviderDraft } from '@/providers/authoring/state';

const scopedAccount = createProviderSettingsAccountHarness();
const harness = scopedAccount.home;
installHomeGovernanceBoundaries(harness);
const navigation = createExpoRouterMock();
vi.doMock('expo-router', () => navigation.module);
const machineRpc = vi.fn(async () => { throw new Error('Unexpected Machine transport in Account approval test'); });
const providerHarness = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(providerHarness);
providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, () => machineRpc());
// Socket transport is the boundary; scoped routing, Action admission and Inbox execution stay real.
await loadSyncSingletonForTests();
const { useProviderConnectionMutation } = await import('./useProviderConnectionMutation');
const { useProviderEndpointConfiguration } = await import('./useProviderEndpointConfiguration');
const { useProviderGatewayConfiguration } = await import('./useProviderGatewayConfiguration');
const { mutateProviderConnection } = await import('@/providers/actions/client');
const { useProviderActionClient } = await import('@/providers/actions/useProviderActionClient');
const { useActionApprovalContinuation } = await import('@/components/approvals/useActionApprovalContinuation');
const { useServerCredentialAccountScopeResolution } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { useProviderConnectionModelsSection } = await import('@/components/settings/providers/models/useProviderConnectionModelsSection');

beforeEach(async () => {
    standardCleanup(); await scopedAccount.reset(); installHomeGovernanceBoundaries(harness);
    machineRpc.mockClear(); navigation.spies.push.mockClear();
});
afterEach(standardCleanup);

function connectionCatalog() {
    return ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
        connections: [{ v: 1, id: 'pc_a', source: { kind: 'custom', template: buildCustomProviderTemplate({
            ...createCustomProviderDraft('openai-responses'), name: 'Approval source',
            baseUrl: 'https://models.example.test/v1', requiresApiKey: false,
        }) }, role: 'named', displayName: 'Approval source', displayNameMode: 'custom',
        revision: 1, createdAt: 1, updatedAt: 1 }],
    });
}

/** Stateful Home row transport; Account mutation, publication and receipt custody remain real. */
function installWritableCatalog(serverId: string, respondAfter?: PromiseLike<void>, catalog = connectionCatalog()) {
    return installProviderConnectionsCatalogHttpBoundary({ home: harness, serverId, catalog,
        reply: mutation => ({ respondAfter, body: { status: 'updated', revision: Number(mutation.expectedRevision) + 1, cursor: Number(mutation.expectedRevision) + 1 } }),
    });
}

/** Observe retained href entries without adding a production-only inspection API. */
function observeApprovalHrefMaps() {
    const maps = new Map<string, Map<unknown, unknown>>();
    const originalSet = Map.prototype.set;
    const spy = vi.spyOn(Map.prototype, 'set').mockImplementation(function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
        if (typeof key === 'string' && typeof value === 'string' && value.startsWith('/inbox/approvals/')) {
            originalSet.call(maps, key, this);
        }
        return originalSet.call(this, key, value);
    });
    return { maps, restore: () => spy.mockRestore() };
}

describe('Provider mutation deferred approval', () => {
    it.each(['connection', 'endpoint', 'gateway'] as const)('settles a designed %s Confirm without asking again', async kind => {
        const initialCatalog = connectionCatalog();
        if (kind === 'gateway') initialCatalog.connections[0] = ProviderConnectionsCatalogV1Schema.parse({
            ...initialCatalog, connections: [{ ...initialCatalog.connections[0],
                source: { kind: 'contribution', contributionKey: 'happier.provider.cliproxyapi/cliproxyapi' },
                deployment: { kind: 'managedLocal' },
            }],
        }).connections[0]!;
        const { serverId } = await scopedAccount.restore({ accountId: 'account-confirm', catalog: initialCatalog, machines: [], waivedActions: [] });
        const catalog = installWritableCatalog(serverId, undefined, initialCatalog);
        const source = initialCatalog.connections[0]!.source;
        const endpointTemplateId = source.kind === 'custom' ? source.template.endpointTemplates[0]!.id : '';
        const resolveTarget = () => null;
        const refresh = async () => {};
        const connection = createProviderConnectionViewFixture({ connectionId: 'pc_a' });
        const hook = await renderHook(() => {
            const mutation = useProviderConnectionMutation({ serverId, resolveTarget, refresh });
            return { mutation,
                endpoint: useProviderEndpointConfiguration({ connection, machineId: null, mutation, onChange: refresh }),
                gateway: useProviderGatewayConfiguration({ connection: catalog.catalog.connections[0]!, machineId: null, mutation }),
                ready: useProviderActionClient(serverId).ready };
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().ready).toBe(true));
        const { Modal } = await import('@/modal');
        const confirm = vi.spyOn(Modal, 'confirm').mockResolvedValue(false);
        let result: unknown;
        await act(async () => {
            const current = hook.getCurrent();
            result = kind === 'connection'
                ? await current.mutation.run({ action: 'delete', connectionId: 'pc_a' }, 'delete', { confirmed: true })
                : kind === 'endpoint'
                    ? await current.endpoint.patch({ scope: 'account', endpointTemplateId, publicHeaders: { 'x-policy': 'confirmed' } }, { confirmed: true })
                    : await current.gateway.save({ claudeHelperModels: null }, { confirmed: true });
        });
        expect(result).toEqual(kind === 'connection' ? expect.objectContaining({ status: 'success' }) : true);
        expect(catalog.writes).toBe(1);
        expect(confirm).not.toHaveBeenCalled();
        expect(harness.artifacts(serverId).list()).toEqual([]);
        expect(navigation.spies.push).not.toHaveBeenCalled();
    });

    it.each(['settlement', 'Account retirement', 'unmount'] as const)(
        'releases approval href custody at %s', async ending => {
            const { serverId } = await scopedAccount.restore({ accountId: 'account-href', catalog: connectionCatalog() });
            await harness.requireUiApproval(serverId, 'providers.probe');
            const hook = await renderHook(() => useProviderActionClient(serverId));
            let observed: ReturnType<typeof observeApprovalHrefMaps> | undefined;
            let execution: Promise<unknown> | undefined;
            try {
                await waitForHomeGovernance(() => expect(hook.getCurrent().ready).toBe(true));
                observed = observeApprovalHrefMaps();
                await act(async () => {
                    execution = hook.getCurrent().probeProviderConnection({ serverId,
                        machineId: 'machine-a', connectionId: 'pc_a',
                    }).then(value => ({ value }), failure => ({ failure }));
                });
                await waitForHomeGovernance(() => expect(harness.artifacts(serverId).list()).toHaveLength(1));
                const artifactId = harness.artifacts(serverId).list()[0]!.id;
                const href = `/inbox/approvals/${artifactId}?serverId=${encodeURIComponent(serverId)}`;
                expect(hook.getCurrent().pendingApproval).toEqual({ artifactId, href });
                const entries = observed.maps.get(artifactId);
                expect(entries?.get(artifactId)).toBe(href);
                if (ending === 'settlement') await decideApprovalAsInbox(serverId, artifactId, 'reject');
                else if (ending === 'Account retirement') await act(async () => { await harness.switchAccount(serverId, 'account-next'); });
                else await hook.unmount();
                await act(async () => { await execution; });
                expect(entries?.has(artifactId)).toBe(false);
                if (ending !== 'unmount') expect(hook.getCurrent().pendingApproval).toBeNull();
                expect(machineRpc).not.toHaveBeenCalled();
            } finally {
                await hook.unmount();
                await execution;
                observed?.restore();
            }
        },
    );

    it('projects a manual-model approval from the real Models page hook and keeps its draft after rejection', async () => {
        const { serverId } = await scopedAccount.restore({ accountId: 'account-model-review', catalog: connectionCatalog(), machines: [] });
        const catalog = installWritableCatalog(serverId);
        await harness.requireUiApproval(serverId, 'providers.models.manual.add');
        const resolveCurrentTarget = () => null;
        const connection = createProviderConnectionViewFixture({ connectionId: 'pc_a', probeCapability: 'none' });
        const hook = await renderHook(() => useProviderConnectionModelsSection({ declarationContext: { kind: 'account' }, connectionId: 'pc_a', connection,
            enabled: true, machineId: null, serverId, resolveCurrentTarget }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().initialLoading).toBe(false));
        await act(async () => { hook.getCurrent().onManualModelTextChange('manual-review-model'); });
        await act(async () => { hook.getCurrent().onAddManualModels(); });
        await waitForHomeGovernance(() => expect(harness.artifacts(serverId).list()).toHaveLength(1));
        const artifactId = harness.artifacts(serverId).list()[0]!.id;
        // This public page projection must retain the client/continuation's exact Review destination.
        expect(hook.getCurrent()).toMatchObject({ pendingApproval: { artifactId,
            href: `/inbox/approvals/${artifactId}?serverId=${encodeURIComponent(serverId)}` } });
        expect(catalog.writes).toBe(0);
        await decideApprovalAsInbox(serverId, artifactId, 'reject');
        await waitForHomeGovernance(() => expect(hook.getCurrent().savingManualModels).toBe(false));
        expect(hook.getCurrent()).toMatchObject({ pendingApproval: null, manualModelText: 'manual-review-model' });
        expect(catalog.writes).toBe(0);
        expect(machineRpc).not.toHaveBeenCalled();
    });

    it.each(['saved probe', 'draft probe', 'legacy preparation'] as const)(
        'keeps %s approval in place and settles rejection without a machine effect', async kind => {
            const { serverId } = await scopedAccount.restore({ accountId: 'account-a', catalog: connectionCatalog() });
            const actionId = kind === 'legacy preparation' ? 'providers.legacy.prepare' : 'providers.probe';
            await harness.requireUiApproval(serverId, actionId);
            const hook = await renderHook(() => useProviderActionClient(serverId));
            await waitForHomeGovernance(() => expect(hook.getCurrent().ready).toBe(true));
            let failure: unknown;
            let execution: Promise<void> | undefined;
            await act(async () => {
                const client = hook.getCurrent();
                const pending = kind === 'legacy preparation'
                    ? client.prepareLegacyProfileMigrationSource({ serverId,
                        request: { machineId: 'machine-a', expectedSettingsVersion: 0 } })
                    : kind === 'draft probe'
                        ? client.probeProviderDraft({ serverId, machineId: 'machine-a', draftConnectionId: 'pc_draft',
                            template: buildCustomProviderTemplate({ ...createCustomProviderDraft('openai-responses'),
                                name: 'Draft approval source', baseUrl: 'https://models.example.test/v1', requiresApiKey: false }),
                            savedSecretId: null })
                        : client.probeProviderConnection({ serverId, machineId: 'machine-a', connectionId: 'pc_a' });
                execution = pending.then(() => { throw new Error('Rejected Provider action executed'); }, caught => { failure = caught; });
            });
            await waitForHomeGovernance(() => expect(harness.artifacts(serverId).list()).toHaveLength(1));
            const artifactId = harness.artifacts(serverId).list()[0]!.id;
            expect(hook.getCurrent().pendingApproval).toEqual({ artifactId,
                href: `/inbox/approvals/${encodeURIComponent(artifactId)}?serverId=${encodeURIComponent(serverId)}` });
            expect(navigation.spies.push).not.toHaveBeenCalled();
            expect(failure).toBeUndefined();
            expect(machineRpc).not.toHaveBeenCalled();
            await expect(decideApprovalAsInbox(serverId, artifactId, 'reject')).resolves.toMatchObject({ ok: true });
            await act(async () => { await execution; });
            expect(failure).toBeDefined();
            expect(hook.getCurrent().pendingApproval).toBeNull();
            expect(machineRpc).not.toHaveBeenCalled();
        },
    );

    it('never reads the original result Artifact through a replacement Account on the same Home', async () => {
        const serverId = await harness.addHome({ name: 'Provider captured Artifact', serverUrl: 'https://provider-captured-artifact.test', accountId: 'account-a' });
        await harness.requireUiApproval(serverId, 'providers.connections.delete');
        const onExecuted = () => {};
        const hook = await renderHook(() => ({
            follower: useActionApprovalContinuation({ scopeKey: 'provider-original-account', serverId, onExecuted }),
            resolution: useServerCredentialAccountScopeResolution(serverId),
        }));
        const caller = new AbortController();
        let execution: Promise<void> | undefined;
        let settlement: unknown = 'pending';
        try {
            await act(async () => {
                execution = mutateProviderConnection({ serverId,
                    request: { action: 'delete', machineId: 'machine-a', connectionId: 'pc_a' },
                }, { scope: { serverId, accountId: 'account-a' }, signal: caller.signal,
                    onApprovalPending: hook.getCurrent().follower.requestApproval,
                }).then(value => { settlement = { value }; }, failure => { settlement = { failure }; });
            });
            await waitForHomeGovernance(() => expect(harness.artifacts(serverId).list()).toHaveLength(1));
            const artifactId = harness.artifacts(serverId).list()[0]!.id;
            const path = `/v1/artifacts/${artifactId}`;
            await waitForHomeGovernance(() => expect(harness.requestsFor(path)).not.toHaveLength(0));
            const originalToken = harness.requestsFor(path)[0]!.token;
            expect(originalToken).toBeTruthy();
            expect(settlement).toBe('pending');
            // Account B does not own A's Artifact. Its server refuses it, but the original
            // mounted follower must not address that result through B's credential at all.
            harness.answer(serverId, path, { status: 404, body: { error: 'not_found' } });
            await act(async () => { await harness.switchAccount(serverId, 'account-b'); });
            await waitForHomeGovernance(() => expect(hook.getCurrent().resolution).toMatchObject({
                kind: 'bound', scope: { serverId, accountId: 'account-b' },
            }));
            await flushHookEffects();
            expect(harness.requestsFor(path).filter(request => request.token !== originalToken)).toEqual([]);
            expect(machineRpc).not.toHaveBeenCalled();
            expect(caller.signal.aborted).toBe(false);
        } finally {
            await act(async () => { caller.abort(); await execution; });
        }
    });
    it('follows each queued result-bearing approval on its captured Home when two Homes share one mounted registrar', async () => {
        const { serverId: homeA } = await scopedAccount.restore({ accountId: 'account-a', catalog: connectionCatalog(), machines: [] });
        const home = scopedAccount.home;
        const homeB = await scopedAccount.addHome({ name: 'Provider multi B', serverUrl: 'https://provider-multi-b.test', accountId: 'account-b', active: false });
        const catalogA = installWritableCatalog(homeA);
        const catalogB = installWritableCatalog(homeB);
        await home.requireUiApproval(homeB, 'providers.connections.delete');
        // The real Sync Home and both live Account scopes stay on A; B has its own
        // persisted policy and may not publish its Artifact into A's projection.
        await home.requireUiApproval(homeA, 'providers.connections.delete');
        const hook = await renderHook(() => useProviderActionClient([homeA, homeB]));
        let observed: ReturnType<typeof observeApprovalHrefMaps> | undefined;
        const settlements = new Map<string, unknown>();
        const executions: Promise<void>[] = [];
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().ready).toBe(true));
            observed = observeApprovalHrefMaps();
            const request = async (serverId: string) => {
                await act(async () => {
                    executions.push(hook.getCurrent().mutateProviderConnection({ serverId,
                        request: { action: 'delete', connectionId: 'pc_a' },
                    }).then(value => { settlements.set(serverId, { value }); }, failure => { settlements.set(serverId, { failure }); }));
                });
                await waitForHomeGovernance(() => expect(home.artifacts(serverId).list()).toHaveLength(1));
            };
            await request(homeA);
            const artifactA = home.artifacts(homeA).list()[0]!.id;
            await waitForHomeGovernance(() => expect(hook.getCurrent().pendingApproval).toEqual({ artifactId: artifactA,
                href: `/inbox/approvals/${artifactA}?serverId=${encodeURIComponent(homeA)}` }));
            await request(homeB);
            const artifactB = home.artifacts(homeB).list()[0]!.id;
            const entriesA = observed.maps.get(artifactA);
            const entriesB = observed.maps.get(artifactB);
            expect(entriesA?.get(artifactA)).toBe(`/inbox/approvals/${artifactA}?serverId=${encodeURIComponent(homeA)}`);
            expect(entriesB?.get(artifactB)).toBe(`/inbox/approvals/${artifactB}?serverId=${encodeURIComponent(homeB)}`);
            expect(machineRpc).not.toHaveBeenCalled();
            // The second result may settle durably before the first queue head.
            await expect(decideApprovalAsInbox(homeB, artifactB, 'approve')).resolves.toMatchObject({ ok: true });
            await expect(decideApprovalAsInbox(homeA, artifactA, 'approve')).resolves.toMatchObject({ ok: true });
            await waitForHomeGovernance(() => expect(settlements.get(homeA)).toMatchObject({ value: { status: 'success', action: 'delete' } }));
            await waitForHomeGovernance(() => expect(home.requestsFor(`/v1/artifacts/${artifactB}`)).not.toHaveLength(0));
            // Assert the outward wrong-Home request before waiting for the result it cannot return.
            expect([...new Set(home.requestsFor(`/v1/artifacts/${artifactB}`).map(request => request.serverId))]).toEqual([homeB]);
            await waitForHomeGovernance(() => expect(settlements.size).toBe(2));
            expect(settlements.get(homeB)).toMatchObject({ value: { status: 'success', action: 'delete' } });
            expect(entriesA?.has(artifactA)).toBe(false);
            expect(entriesB?.has(artifactB)).toBe(false);
            expect(catalogA.catalog.connections).toEqual([]);
            expect(catalogB.catalog.connections).toEqual([]);
            expect([catalogA.writes, catalogB.writes]).toEqual([1, 1]);
            expect(machineRpc).not.toHaveBeenCalled();
        } finally {
            await hook.unmount();
            await Promise.all(executions);
            observed?.restore();
            await scopedAccount.reset();
        }
    });
    it('retains a committed Account mutation with an unknown outcome when retirement aborts its receipt', async () => {
        const { serverId } = await scopedAccount.restore({ accountId: 'account-a', catalog: connectionCatalog(), machines: [],
            waivedActions: ['providers.connections.delete'] });
        let releaseResponse: () => void = () => {};
        const responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
        const catalog = installWritableCatalog(serverId, responseGate);
        const capturedAccount = new AbortController();
        const settled = mutateProviderConnection({ serverId,
            request: { action: 'delete', connectionId: 'pc_a' },
        }, { scope: { serverId, accountId: 'account-a' }, signal: capturedAccount.signal,
            onApprovalPending: () => { throw new Error('The Account waived approval for this direct mutation'); },
        }).then(value => ({ value }), failure => ({ failure }));
        try {
            await waitForHomeGovernance(() => expect(catalog.writes).toBe(1));
            await harness.switchAccount(serverId, 'account-b');
            capturedAccount.abort();
            releaseResponse();
            await expect(settled).resolves.toMatchObject({ failure: {
                code: 'provider_catalog_outcome_unknown', details: { status: 'outcome_unknown' },
            } });
        } finally {
            releaseResponse();
            await settled;
        }
        expect(harness.artifacts(serverId).list()).toHaveLength(0);
        expect(catalog.catalog.connections).toEqual([]);
        expect(catalog.writes).toBe(1);
        expect(machineRpc).not.toHaveBeenCalled();
    });

    it('settles a rejected approval as the person\'s decision, not a failure to present', async () => {
        const { serverId } = await scopedAccount.restore({ accountId: 'account-a', catalog: connectionCatalog(), machines: [] });
        const catalog = installWritableCatalog(serverId);
        await harness.requireUiApproval(serverId, 'providers.connections.delete');
        const resolveTarget = () => ({ machineId: 'machine-a', serverId });
        const hook = await renderHook(() => useProviderConnectionMutation({ serverId, resolveTarget, refresh: async () => {} }));
        let execution: ReturnType<ReturnType<typeof useProviderConnectionMutation>['run']> | undefined;
        await act(async () => { execution = hook.getCurrent().run({ action: 'delete', connectionId: 'pc_a' }); });
        await waitForHomeGovernance(() => expect(harness.artifacts(serverId).list()).toHaveLength(1));
        const artifactId = harness.artifacts(serverId).list()[0]!.id;
        await expect(decideApprovalAsInbox(serverId, artifactId, 'reject')).resolves.toMatchObject({ ok: true });
        await act(async () => { await expect(execution).resolves.toBeNull(); });
        expect(hook.getCurrent().error).toBeNull();
        expect(hook.getCurrent().isPending('delete:pc_a')).toBe(false);
        expect(catalog.writes).toBe(0);
    });

    it('keeps approval in place and consumes its typed terminal result without replaying the mutation', async () => {
        const { serverId } = await scopedAccount.restore({ accountId: 'account-a', catalog: connectionCatalog(), machines: [] });
        const catalog = installWritableCatalog(serverId);
        await harness.requireUiApproval(serverId, 'providers.connections.delete');
        const refresh = async () => {};
        const resolveTarget = () => ({ machineId: 'machine-a', serverId });
        const hook = await renderHook((input: { resolveTarget: typeof resolveTarget; refresh: () => Promise<void> }) =>
            useProviderConnectionMutation({ serverId, ...input }), { initialProps: { resolveTarget, refresh } });
        let execution: ReturnType<ReturnType<typeof useProviderConnectionMutation>['run']> | undefined;
        await act(async () => {
            execution = hook.getCurrent().run({ action: 'delete', connectionId: 'pc_a' });
        });
        await waitForHomeGovernance(() => expect(harness.artifacts(serverId).list()).toHaveLength(1));
        const artifactId = harness.artifacts(serverId).list()[0]!.id;
        expect(hook.getCurrent().error).toBeNull();
        expect(hook.getCurrent().isPending('delete:pc_a')).toBe(true);
        expect(machineRpc).not.toHaveBeenCalled();
        expect(hook.getCurrent().pendingApproval).toEqual({ artifactId,
            href: `/inbox/approvals/${encodeURIComponent(artifactId)}?serverId=${encodeURIComponent(serverId)}` });
        expect(navigation.spies.push).not.toHaveBeenCalled();
        // Neither a new refresh callback nor another machine retires this Account's approval.
        await hook.rerender({ refresh: async () => {}, resolveTarget: () => ({ machineId: 'machine-b', serverId }) });
        const retainedPending = hook.getCurrent().isPending('delete:pc_a');
        await expect(decideApprovalAsInbox(serverId, artifactId, 'approve')).resolves.toMatchObject({ ok: true, result: { status: 'executed' } });
        await act(async () => { await expect(execution).resolves.toMatchObject({ status: 'success', action: 'delete' }); });
        expect(retainedPending).toBe(true);
        expect(hook.getCurrent().error).toBeNull();
        expect(hook.getCurrent().isPending('delete:pc_a')).toBe(false);
        expect(catalog.catalog.connections).toEqual([]);
        expect(catalog.writes).toBe(1);
        expect(machineRpc).not.toHaveBeenCalled();
    });

    it('ends pending local interest on Account retirement even when the explicit caller signal stays live', async () => {
        const serverId = await harness.addHome({ name: 'Provider load approval', serverUrl: 'https://provider-load-approval.test', accountId: 'account-a' });
        await harness.requireUiApproval(serverId, 'providers.models.load');
        const hook = await renderHook(() => useProviderActionClient(serverId));
        await waitForHomeGovernance(() => expect(hook.getCurrent().ready).toBe(true));
        const caller = new AbortController();
        let settlement: unknown = 'pending';
        let execution: Promise<void> | undefined;
        try {
            await act(async () => {
                execution = hook.getCurrent().loadProviderModel({ serverId, machineId: 'machine-a', connectionId: 'pc_a',
                    modelId: 'model-a', signal: caller.signal,
                }).then(value => { settlement = { value }; }, failure => { settlement = { failure }; });
            });
            await waitForHomeGovernance(() => expect(harness.artifacts(serverId).list()).toHaveLength(1));
            expect(settlement).toBe('pending');
            expect(hook.getCurrent().pendingApproval).toBeTruthy();
            expect(navigation.spies.push).not.toHaveBeenCalled();
            await act(async () => { await harness.switchAccount(serverId, 'account-b'); });
            await flushHookEffects();
            expect(settlement).toMatchObject({ failure: { code: 'action_account_scope_changed' } });
            expect(caller.signal.aborted).toBe(false);
            expect(machineRpc).not.toHaveBeenCalled();
        } finally {
            // Dispose the test's explicit interest even when the missing lifetime merge fails.
            await act(async () => { caller.abort(); await execution; });
        }
    });
});
