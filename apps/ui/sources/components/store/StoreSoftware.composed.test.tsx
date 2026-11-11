import * as React from 'react';
import { afterAll, afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import sodium from 'libsodium-wrappers';
import { DaemonContributionRegistryProjectionDescribeRequestSchema, DaemonContributionRegistryProjectionDescribeResponseSchema,
    PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { PluginProjectedMachineRecipeEntryV1Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeV1Schema,
    ExternalActionExecutionAuthorizationRequestV1Schema, bindExternalActionExecutionAuthorizationHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1,
    verifyExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { approvalArtifactBodyMatchesHeaderV1, buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { actionInputOptionValueKey } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { MachineSetupPlanResultV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { getMachineSetupDesiredV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { act, changeTextTestInstance, createMachineFixture, flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { observeMachinePresenceForTest, publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { StoreSoftwareList } from './catalog/storeSoftware';
import type { StoreSoftwareEntryState } from './StoreSoftwareEntry';
import type { ManagedInventoryQuery } from './inventory/useManagedInventory';

const homes = createHomeGovernanceHarness();
// The renderer has no native measurements; expose the same viewport as the Search composed harness.
vi.mock('@/components/ui/popover/measure', () => ({ measureInWindow: async () => ({ x: 0, y: 0, width: 800, height: 600 }) }));
installHomeGovernanceBoundaries(homes);
vi.doUnmock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch');
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
// Load the real receiving process graph before the per-test lifecycle starts.
const [{ createCliActionExecutorHarness }, { createHostActionOperationRuntime }, { createCombinedMachineSetupActionDeps }, { prepareMachineSetupPlanV1 }] = await Promise.all([
    import('../../../../cli/src/session/actions/createCliActionExecutorHarness'),
    import('../../../../cli/src/daemon/actionOperations/createHostActionOperationRuntime'),
    import('../../../../cli/src/machines/setup/composeMachineSetup'),
    import('../../../../cli/src/machines/setup/prepareMachineSetupPlan'),
]);
await sodium.ready;
const { storage } = await import('@/sync/domains/state/storage');
const { StoreKindScreen } = await import('./StoreKindScreen');
const { getServerProfileById, resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
const { SoftwareListing } = await import('./StoreSoftwarePage');
let disposeLoader: (() => void) | undefined;

// Native layout boundary: page-virtualized collections need the viewport a real host reports.
const searchContentNode = {};
let searchContentRevision = 4000;
const searchRenderOptions = { createNodeMock: (node: Readonly<{ type: unknown }>) => node.type === 'ScrollView'
    ? { getInnerViewRef: () => searchContentNode, scrollTo: () => {} } : node.type === 'View' ? {} : null };
async function expectSearchRow(screen: Awaited<ReturnType<typeof renderScreen>>, rowID: string) {
    await waitForHomeGovernance(async () => {
        await act(async () => {
            for (const node of screen.root.findAll(candidate => typeof candidate.props.onScroll === 'function' && typeof candidate.props.onLayout === 'function')) {
                node.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 800, height: 900 } } });
                node.props.onContentSizeChange?.(800, ++searchContentRevision);
            }
        });
        await flushHookEffects();
        expect(screen.findAllHostsByTestId(rowID).length).toBeGreaterThan(0);
    });
}

const ref = { pluginId: 'example.software', recipeId: 'package', revision: '3' };
const recipe = PluginProjectedMachineRecipeEntryV1Schema.parse({
    id: `${ref.pluginId}/${ref.recipeId}`, pluginId: ref.pluginId, pluginVersion: '1.0.0',
    definition: { id: ref.recipeId, revision: ref.revision, title: 'Exact package', software: true,
        inputSchema: { type: 'object', properties: { manager: { type: 'string', enum: ['apt', 'dnf', 'brew', 'winget'] },
            packages: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, version: { type: 'string' },
                kind: { type: 'string', enum: ['formula', 'cask'] }, source: { type: 'string' },
                scope: { type: 'string', enum: ['user', 'machine'] } }, required: ['name'], additionalProperties: false } } },
            required: ['manager', 'packages'], additionalProperties: false },
        inputHints: { fields: [{ path: 'manager', title: 'Manager', widget: 'select', options: [{ value: 'brew', label: 'Homebrew' }] }] },
        steps: [{ id: 'install', kind: 'package', manager: { kind: 'input', path: 'manager' }, packages: { kind: 'input', path: 'packages' } }],
        removeSteps: [{ id: 'remove', kind: 'package', state: 'absent', manager: { kind: 'input', path: 'manager' }, packages: { kind: 'input', path: 'packages' } }],
    },
});

beforeEach(async () => {
    await homes.reset(); network.resetRequests();
    network.setHttpResponder(async (input, init) => new URL(String(input)).pathname.startsWith('/v1/machines/') ? null : homes.request(input, init));
    disposeLoader = await installRealActionExecutorModuleLoader();
});
afterEach(async () => {
    await standardCleanup(); disposeLoader?.();
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    await serverScopedRpcSocketPool.stopAll();
});
afterAll(async () => { await network.dispose(); });

async function setup() {
    const url = 'https://store-software.test';
    await network.addHome(url, 'alice');
    const homeId = await homes.addHome({ name: 'Software Home', serverUrl: url, serverIdentityId: 'srv_software', accountId: 'alice', currentAccount: true });
    const profile = getServerProfileById(homeId)!;
    const scope = { serverId: homeId, accountId: 'alice' };
    const machines = Array.from({ length: 128 }, (_, i) => createMachineFixture({ id: `machine-${i}`, activeAt: Date.now() }));
    await act(async () => { await publishMachineInventoryForTest(scope, machines); });
    const target = { scope, machine: { serverIdentityId: profile.serverIdentityId!, machineId: 'machine-0' } };
    const entries = Array.from({ length: 100 }, (_, i) => i === 0 ? recipe : PluginProjectedMachineRecipeEntryV1Schema.parse({ ...recipe,
        id: `${ref.pluginId}/other-${i}`, definition: { ...recipe.definition, id: `other-${i}`, title: `Other ${i}` } }));
    const control = { targetFacts: { platform: 'linux', arch: 'x64' } };
    network.setRpcAckResponder(async request => {
        const input = DaemonContributionRegistryProjectionDescribeRequestSchema.parse(request.payload);
        const selected = input.recipeRefs === undefined ? entries : entries.filter(entry => input.recipeRefs?.some(pick =>
            entry.pluginId === pick.pluginId && entry.definition.id === pick.recipeId && entry.definition.revision === pick.revision));
        return { ok: true, result: DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
            machineRecipeTarget: control.targetFacts,
            projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1, installedPackagesById: {}, agentsById: {}, actionsById: {},
                resourcesById: {}, settingsById: {}, familiesById: { machineRecipes: { family: 'machineRecipes',
                    entriesById: Object.fromEntries(selected.map(entry => [entry.id, entry])) } }, diagnostics: [] }),
        }) };
    });
    return { target, entries, homeId, control, machines };
}

it('mounts Software from the one option-demand owner: summaries only, exact selected declaration, hidden zero reads', async () => {
    const { target, entries } = await setup();
    let current: StoreSoftwareList | undefined;
    const tree = (presented: boolean) => <StoreKindScreen kind="software" input={{ query: '', softwareTarget: target }} demand={{ presented }}>
        {list => { current = list; return null; }}
    </StoreKindScreen>;
    const screen = await renderScreen(tree(false));
    expect(network.requests).toHaveLength(0);
    await screen.update(tree(true));
    await waitForHomeGovernance(() => expect({ error: current?.error, count: current?.items.length }).toEqual({ error: null, count: 102 }));
    expect(current?.items.filter(item => typeof item.value === 'object' && item.value && 'kind' in item.value)).toMatchObject([
        { value: { kind: 'toolchain', adapterId: 'mise', tool: 'node' } },
        { value: { kind: 'toolchain', adapterId: 'mise', tool: 'python' } },
    ]);
    expect(network.requests).toHaveLength(1);
    const { StoreSoftwareEntry } = await import('./StoreSoftwareEntry');
    let detail: StoreSoftwareEntryState | undefined;
    const listing = await renderScreen(<StoreSoftwareEntry target={target} selection={{ value: ref, label: 'Selected' }} demand={{ presented: true }}>
        {state => { detail = state; return null; }}
    </StoreSoftwareEntry>);
    await waitForHomeGovernance(() => expect(detail?.machineRecipeDetails).toEqual([recipe]));
    expect(network.requests).toHaveLength(2);
    expect(network.requests[1]?.payload).toMatchObject({ recipeRefs: [ref], machineId: 'machine-0' });
    expect(detail?.machineRecipeDetails?.[0]?.definition).toMatchObject({
        inputSchema: recipe.definition.inputSchema, inputHints: recipe.definition.inputHints, removeSteps: recipe.definition.removeSteps,
    });
    await listing.unmount();
    expect(network.requests[0]?.payload).not.toHaveProperty('recipeRefs');
    expect(current).not.toHaveProperty('machineRecipeDetails');
    const before = current?.items;
    await act(async () => { storage.getState().applyMachineActivityUpdates([{ id: 'machine-73', active: true, activeAt: Date.now() + 1 }],
        { sourceServerId: target.scope.serverId, sourceAccountId: target.scope.accountId }); });
    await screen.update(tree(true)); await flushHookEffects();
    expect(current?.items).toBe(before);
    expect(network.requests).toHaveLength(2);
    await act(async () => { current?.refresh(); });
    await waitForHomeGovernance(() => expect(network.requests).toHaveLength(3));
    await flushHookEffects();
    expect(current?.items).toBe(before);
    entries[1] = { ...entries[1]!, definition: { ...entries[1]!.definition, title: 'Changed offering' } };
    await act(async () => { current?.refresh(); });
    await waitForHomeGovernance(() => expect(current?.items.some(item => item.label === 'Changed offering')).toBe(true));
    expect(current?.items.filter((item, index) => item !== before?.[index])).toHaveLength(1);
    expect(network.requests).toHaveLength(4);
    const retainedRefresh = current?.refresh;
    await screen.update(tree(false)); await flushHookEffects();
    await act(async () => { retainedRefresh?.(); }); await flushHookEffects();
    expect(network.requests).toHaveLength(4);
});

it('withdraws native Software listing reads while its retained layout is hidden', async () => {
    const { target } = await setup();
    const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
    const tree = (presented: boolean) => <PluginSurfaceFocusEligibilityProvider active={presented} presentationActive={presented}>
        <SoftwareListing target={target} item={{ value: ref, label: 'Exact package' }} machines={{ targets: [] }}
            pushed={false} onClose={() => {}} />
    </PluginSurfaceFocusEligibilityProvider>;
    const screen = await renderScreen(tree(false));
    await flushHookEffects();
    expect(network.requests).toHaveLength(0);
    await screen.update(tree(true));
    await waitForHomeGovernance(() => expect(network.requests).toHaveLength(1));
    expect(network.requests[0]?.payload).toMatchObject({ recipeRefs: [ref], machineId: 'machine-0' });
    await screen.update(tree(false));
    await flushHookEffects();
    expect(network.requests).toHaveLength(1);
});

it('opens an admitted editorial Software choice through the native exact read without a catalog body scan', async () => {
    const { target, machines } = await setup();
    const applied = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const previousState = storage.getState();
    const previousApplied = applied.getAppliedActiveServerSnapshot();
    const previousAvailable = applied.isAppliedActiveServerRuntimeAvailable();
    onTestFinished(() => {
        storage.setState(previousState, true);
        applied.publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
    });
    await act(async () => {
        storage.setState({ profileScope: target.scope, settingsScope: target.scope });
        applied.publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        storage.getState().applyMachines(machines, true, {
            sourceServerId: target.scope.serverId, sourceAccountId: target.scope.accountId, replace: false,
        });
    });
    const { MarketplaceCatalogReferenceV1Schema } = await import('@happier-dev/protocol/marketplace');
    const { buildStoreListingRoute, readStoreListingRoute } = await import('@/components/settings/plugins/model/pluginsSurfaceRoutes');
    const { StoreSoftwareRouteListing } = await import('./StoreSoftwarePage');
    const reference = MarketplaceCatalogReferenceV1Schema.parse({ type: 'software', value: ref });
    const route = readStoreListingRoute(buildStoreListingRoute(reference).params);
    if (route?.kind !== 'store' || route.reference.type !== 'software') throw new Error('Expected native Software listing');
    const screen = await renderScreen(<StoreSoftwareRouteListing reference={route.reference} pushed={false} onClose={() => {}} />);
    await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(recipe.definition.title));
    expect(network.requests).toHaveLength(1);
    expect(network.requests[0]?.payload).toMatchObject({ recipeRefs: [ref], machineId: target.machine.machineId });
});

it('searches Software on the explicitly routed Machine without reading any of the other held Machines', async () => {
    const { target } = await setup();
    const applied = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const previousState = storage.getState();
    const previousApplied = applied.getAppliedActiveServerSnapshot();
    const previousAvailable = applied.isAppliedActiveServerRuntimeAvailable();
    onTestFinished(() => {
        storage.setState(previousState, true);
        applied.publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
    });
    // This screen starts from an admitted UI Account, unlike the credential-only
    // Software option tests. Publish that fixture input through the real lifetime owner.
    await act(async () => {
        storage.setState({ profileScope: target.scope, settingsScope: target.scope });
        applied.publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    });
    const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
    const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
    const { resolveCompactAppDestinations, resolveDestinationRefFromHref } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
    const { StoreSearchPage } = await import('./StoreSearchPage');
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
    const destination = resolveDestinationRefFromHref(catalog, '/plugins?view=search')!;
    const screen = await renderScreen(<DestinationInstanceHost tabId="software-search" pathname="/plugins" focused visible
        ref={{ ...destination, params: { ...destination.params, softwareTarget: JSON.stringify(target), q: 'Exact package',
            filters: JSON.stringify({ kind: { include: ['software'], exclude: [] } }) } }}
        navigation={{ push: () => {}, replace: () => {}, back: () => {}, setParams: () => {} }}>
        <AppPaneProvider><StoreSearchPage presented /></AppPaneProvider>
    </DestinationInstanceHost>, searchRenderOptions);
    await waitForHomeGovernance(() => expect({ text: screen.getTextContent(),
        targets: network.requests.map(request => request.targetId) }).toMatchObject({ targets: ['machine-0'] }));
    const rowID = `store.kind.search.row.${actionInputOptionValueKey(ref)}`;
    await expectSearchRow(screen, rowID);
    expect(screen.findAllByTestId(`${rowID}.add`).length).toBeGreaterThan(0);
});

it('composes recorded Software into Installed without native reads or confusing success history with presence', async () => {
    const { target, homeId } = await setup();
    const previousState = storage.getState();
    onTestFinished(() => { storage.setState(previousState, true); });
    const machineServerId = resolveServerProfileScopeIdForIdentifier(homeId);
    const publish = (machines: Machine[]) => {
        storage.getState().applyMachines(machines, true, { sourceServerId: target.scope.serverId });
        storage.getState().markMachineListSettled(target.scope.serverId);
        observeMachinePresenceForTest(target.scope, machines.map(machine => machine.id));
    };
    const { useManagedInventory } = await import('./inventory/useManagedInventory');
    const { InboxArtifactSourceBoundary } = await import('@/hooks/inbox/useInboxArtifactSource');
    const wrapper = ({ children }: React.PropsWithChildren) => <InboxArtifactSourceBoundary>{children}</InboxArtifactSourceBoundary>;
    const current = storage.getState().machineListByServerId[machineServerId]![0]!;
    const selection = { ref, inputs: { manager: 'brew', packages: [{ name: 'exact/cask', version: '2', kind: 'cask' }] } };
    const machine = { ...current, metadata: { ...current.metadata!, setup: { version: 1 as const, revision: 2, exclusions: [], sources: [
        { kind: 'direct' as const, setup: { items: [{ kind: 'softwareRecipe' as const, selection }],
            toolchain: { adapterId: 'mise', config: '[tools]\nnode = "22"\n' } } },
    ] } }, daemonState: { ...current.daemonState, setup: { version: 1 as const, desiredRevision: 1,
        status: 'satisfied' as const, recipes: [{ ref, status: 'satisfied' as const, steps: [] }] } } };
    await act(async () => { publish([machine]); });
    let query: ManagedInventoryQuery = { ...target, projectKey: null, presented: true };
    const hook = await renderHook(() => useManagedInventory(query), { wrapper });
    await waitForHomeGovernance(() => expect({ coverage: hook.getCurrent().families.software.coverage,
        count: hook.getCurrent().families.software.rows.length }).toEqual({ coverage: 'available', count: 2 }));
    const rows = hook.getCurrent().families.software.rows;
    expect(rows.find(row => row.subject === 'recipe')).toMatchObject({ native: selection,
        installations: [{ machineId: 'machine-0', observation: null }] });
    expect(rows.find(row => row.subject === 'toolchain')).toMatchObject({ native: { adapterId: 'mise', config: '[tools]\nnode = "22"\n' } });
    const softwareReads = () => network.requests.filter(request => request.method === RPC_METHODS.MACHINE_SETUP_PLAN
        || request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
    expect(softwareReads()).toHaveLength(0);
    const { presentInventoryRow } = await import('./inventory/inventoryRows');
    expect(presentInventoryRow(rows[0]!, { ...target, projectKey: null }).home.href).toContain(encodeURIComponent('machine-0'));
    await hook.rerender();
    expect(hook.getCurrent().families.software.rows).toBe(rows);
    await act(async () => { storage.getState().applyMachineActivityUpdates([{ id: machine.id, active: true, activeAt: Date.now() + 1 }],
        { sourceServerId: target.scope!.serverId, sourceAccountId: target.scope!.accountId }); });
    expect(hook.getCurrent().families.software.rows).toBe(rows);
    expect(softwareReads()).toHaveLength(0);
    // Count real Software item visits, including work hidden by equal-result row retention.
    const softwareKeys = vi.spyOn(await import('@happier-dev/protocol/actions/actionInputHintsRuntime'), 'actionInputOptionValueKey');
    const beforeResources = storage.getState().machineListByServerId[machineServerId];
    await act(async () => { storage.getState().applyMachines([{ ...machine, daemonStateVersion: machine.daemonStateVersion + 1,
        daemonState: { ...machine.daemonState, resources: { v: 1, attention: { level: 'calm', reasons: [] },
            vitals: { state: 'unavailable', since: 1, reason: 'reader_failed' } } },
    }], false, { sourceServerId: target.scope!.serverId }); });
    expect(storage.getState().machineListByServerId[machineServerId]).not.toBe(beforeResources);
    expect(storage.getState().machineRecordsByServerId[machineServerId]?.[machine.id]?.daemonState.resources?.v).toBe(1);
    expect(softwareKeys).not.toHaveBeenCalled();
    expect(hook.getCurrent().families.software.rows).toBe(rows);
    const resourceRecord = storage.getState().machineRecordsByServerId[machineServerId]![machine.id]!;
    await act(async () => { storage.getState().applyMachines([{ ...resourceRecord,
        metadataVersion: resourceRecord.metadataVersion + 1,
        metadata: { ...resourceRecord.metadata!, host: 'renamed-software-machine' },
    }], false, { sourceServerId: target.scope.serverId }); });
    expect(storage.getState().machineRecordsByServerId[machineServerId]?.[machine.id]?.metadata?.host)
        .toBe('renamed-software-machine');
    expect(softwareKeys).not.toHaveBeenCalled();
    expect(hook.getCurrent().families.software.rows).toBe(rows);
    query = { ...query, machine: null };
    await hook.rerender();
    expect(hook.getCurrent().families.software.rows.map(row => row.key)).toEqual(rows.map(row => row.key));
    const second = { ...machine, id: 'machine-1', daemonState: { ...machine.daemonState,
        setup: { ...machine.daemonState.setup, desiredRevision: 2 } } };
    await act(async () => { publish([machine, second]); });
    expect(softwareKeys).toHaveBeenCalled();
    softwareKeys.mockRestore();
    await waitForHomeGovernance(() => expect(hook.getCurrent().families.software.rows).toHaveLength(2));
    expect(hook.getCurrent().families.software.rows.find(row => row.subject === 'recipe'))
        .toMatchObject({ native: selection, installations: [{ machineId: 'machine-0', observation: null },
            { machineId: 'machine-1', observation: { ref, status: 'satisfied' } }] });
    expect(hook.getCurrent().families.software.rows.map(row => row.key)).toEqual(rows.map(row => row.key));
    const grouped = hook.getCurrent().families.software.rows;
    await act(async () => { publish([machine, second]); });
    expect(hook.getCurrent().families.software.rows).toBe(grouped);
    const updatedSecond = { ...second, daemonState: { ...second.daemonState, setup: { ...second.daemonState.setup,
        recipes: [{ ref, status: 'drifted' as const, steps: [] }] } } };
    await act(async () => { publish([machine, updatedSecond]); });
    const changed = hook.getCurrent().families.software.rows;
    expect(changed.find(row => row.subject === 'recipe')).not.toBe(grouped.find(row => row.subject === 'recipe'));
    expect(changed.find(row => row.subject === 'toolchain')).toBe(grouped.find(row => row.subject === 'toolchain'));
    expect(changed.find(row => row.subject === 'recipe')).toMatchObject({ installations: [
        { machineId: 'machine-0', observation: null }, { machineId: 'machine-1', observation: { status: 'drifted' } },
    ] });
    const alternate = { ...selection, inputs: { manager: 'brew', packages: [{ name: 'exact/cask', version: '3', kind: 'cask' }] } };
    const third = { ...machine, id: 'machine-2', metadata: { ...machine.metadata, setup: { ...machine.metadata.setup,
        sources: [{ kind: 'direct' as const, setup: { items: [{ kind: 'softwareRecipe' as const, selection: alternate }] } }],
    } } };
    await act(async () => { publish([machine, updatedSecond, third]); });
    expect(hook.getCurrent().families.software.rows).toHaveLength(3);
    expect(hook.getCurrent().families.software.rows.filter(row => row.subject === 'recipe')).toHaveLength(2);
    expect(softwareReads()).toHaveLength(0);
    query = { ...query, scope: { ...target.scope!, accountId: 'retired-account' } };
    await hook.rerender();
    expect(hook.getCurrent().families.software).toMatchObject({ rows: [], coverage: { unavailable: 'scope-retired' } });
    await act(async () => { publish([]); });
    query = { ...query, scope: target.scope };
    await hook.rerender();
    await waitForHomeGovernance(() => expect(hook.getCurrent().families.software).toMatchObject({ rows: [], coverage: 'available' }));
});

it('retains exact native package inputs and literal toolchain config through the mounted selected entry', async () => {
    const { target, control } = await setup();
    const { StoreSoftwareEntry } = await import('./StoreSoftwareEntry');
    let detail: StoreSoftwareEntryState | undefined;
    const tree = (value: typeof ref | { kind: 'toolchain'; adapterId: 'mise'; tool: 'node' }) =>
        <StoreSoftwareEntry target={target} selection={{ value, label: 'Selected' }} demand={{ presented: true }}>
            {state => { detail = state; return null; }}
        </StoreSoftwareEntry>;
    const screen = await renderScreen(tree(ref));
    await waitForHomeGovernance(() => expect(detail?.status).toBe('ready'));
    const inputs = { manager: 'winget', packages: [{ name: 'Exact.Package', version: '2.0', source: 'winget', scope: 'user' }] };
    expect(detail?.configure?.(inputs)).toMatchObject({ ok: true, setup: { items: [{ kind: 'softwareRecipe', selection: { ref, inputs } }] } });
    const cask = { manager: 'brew', packages: [{ name: 'vendor/cask', version: '3', kind: 'cask' }] };
    expect(detail?.configure?.(cask)).toMatchObject({ ok: true, setup: { items: [{ kind: 'softwareRecipe', selection: { ref, inputs: cask } }] } });
    await screen.update(tree({ kind: 'toolchain', adapterId: 'mise', tool: 'node' }));
    await waitForHomeGovernance(() => expect(detail?.options[0]?.value).toEqual({ kind: 'toolchain', adapterId: 'mise', tool: 'node' }));
    const config = '[tools]\r\nnode = "22.1.0"\r\n';
    expect(detail?.configure?.(config)).toEqual({ ok: true, setup: { toolchain: { adapterId: 'mise', config } } });
    expect(detail?.machineRecipeDetails).toBeUndefined();
    expect(network.requests).toHaveLength(2);
    control.targetFacts = { platform: 'darwin', arch: 'arm64' };
    await screen.update(<StoreSoftwareEntry target={target} selection={{ value: { kind: 'toolchain', adapterId: 'mise', tool: 'node' }, label: 'Node.js' }}
        demand={{ presented: true }} refreshKey="changed-target-facts">{state => { detail = state; return null; }}</StoreSoftwareEntry>);
    await waitForHomeGovernance(() => expect(detail?.options[0]?.disabled).toBe(true));
    expect(detail?.configure(config)).toMatchObject({ ok: false, errorCode: 'unavailable' });
    expect(network.requests).toHaveLength(3);
});

it('keeps offline and retired Machines unavailable without a queued read or ambient target substitution', async () => {
    const { target } = await setup();
    const { recordMachineRequestFailed } = await import('@/sync/domains/machines/reachability/machineReachability');
    await act(async () => { recordMachineRequestFailed({ ...target.scope!, machineId: target.machine!.machineId, observedAtMs: Date.now() + 1 }); });
    let current: StoreSoftwareList | undefined;
    await renderScreen(<StoreKindScreen kind="software" input={{ query: '', softwareTarget: target }} demand={{ presented: true }}>
        {list => { current = list; return null; }}
    </StoreKindScreen>);
    await waitForHomeGovernance(() => expect(current).toMatchObject({ items: [], error: 'offline', loading: false }));
    await act(async () => { current?.refresh(); }); await flushHookEffects();
    expect(network.requests).toHaveLength(0);
});

it('prepares one full-target review then submits one public Apply without executing effects during selection', async () => {
    const { target, homeId } = await setup();
    const { createActionExecutorBoundaryFixture } = await import('@/dev/testkit/fixtures/actionExecutorBoundary');
    const applied: unknown[] = [];
    const effects: unknown[] = [];
    let confirmation: ActionExecutorContext['presentUserConfirmation'];
    let secondTargetUnavailable = false;
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const { isApprovalExecutionOriginCurrentForAccountContext } = await import('@/sync/ops/actions/defaultActionExecutor');
    const { writeApprovalRequestArtifact } = await import('@/sync/ops/actions/approvalArtifactWriter');
    const { readOriginalAccountActionAuthentication } = await import('@/sync/api/externalActionAccountTransport');
    const account = await captureLazyActionAccountContext(homeId);
    onTestFinished(() => account.dispose());
    const installationKey = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(19));
    const readMachine = (machineId: string) => ({ ...createPlainMachineRowFixture({ id: machineId, accountId: 'alice' }),
        installationPublicKey: encodeBase64(installationKey.publicKey, 'base64') });
    network.setHttpResponder(async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(init?.body, readMachine);
        const exact = /^\/v1\/machines\/([^/]+)$/.exec(path);
        return exact ? Response.json({ machine: readMachine(decodeURIComponent(exact[1]!)) }) : homes.request(input, init);
    });
    const source = MachineSetupPlanResultV1Schema.parse({ desiredRevision: 4, sources: [
        { kind: 'direct', setup: { scripts: [{ body: 'echo retained\r\n' }] } },
    ], exclusions: [], support: [] });
    const current = await getMachineSetupDesiredV1({
        read: async () => ({ status: 'ready', metadataVersion: 4, metadata: { setup: {
            version: 1, revision: source.desiredRevision, sources: source.sources, exclusions: source.exclusions,
        } } }),
        compareAndSwap: async () => { throw new Error('Planning cannot write desired Software'); },
    });
    // The real planner reads this receiving process's metadata and declarations.
    // Only native process output and the completed OS effect are substituted.
    const receiverDeps = createActionExecutorBoundaryFixture({
        machineSetupPlan: async ({ input }) => {
            if ('targets' in input) throw new Error('The native leaf receives one target from the real combined Plan');
            if (input.machineId === 'machine-1' && secondTargetUnavailable)
                return { ok: false, errorCode: 'machine_offline', error: 'Target is offline' };
            if (input.mode === 'effects') effects.push(input);
            return prepareMachineSetupPlanV1({ input, current, readRecipes: async () => [recipe], runNative: async command => {
                const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
                if (command.executable === 'dpkg') return ok('amd64\n');
                if (command.executable === 'apt-get' && command.args[0] === '--version') return ok('apt 2.6\n');
                if (command.executable === 'dpkg-query') return { code: 1, stdout: '', stderr: '' };
                if (command.executable === 'lslocks') return ok('{"locks":[]}');
                if (command.executable === 'apt-cache' && command.args[0] === 'policy')
                    return ok('exact-package:\n  Candidate: 2.1\n  Version table:\n     2.1 500\n');
                if (command.executable === 'apt-cache' && command.args[0] === 'show')
                    return ok('Package: exact-package\nVersion: 2.1\nArchitecture: amd64\n\n');
                throw new Error(`Unexpected native Software probe: ${command.executable} ${command.args.join(' ')}`);
            } });
        },
        machineSetupApply: async ({ input, context }) => {
            if (!context.operationAcceptance) throw new Error('The receiving operation must own native effect acceptance');
            const result = { operationId: context.operationAcceptance.operationId };
            applied.push(input);
            context.operationAcceptance.accept(result);
            return result;
        },
        approvalsCreate: async ({ request }) => ({ artifactId: await account.createArtifact(
            buildApprovalRequestArtifactHeaderV1(request), JSON.stringify(request)) }),
        approvalsGet: async ({ artifactId }) => {
            const artifact = await account.fetchArtifact(artifactId);
            if (!artifact?.header || typeof artifact.body !== 'string') return null;
            const parsed = approvalArtifactBodyMatchesHeaderV1(artifact.header, artifact.body);
            return parsed?.family === 'built_in' ? parsed.request : null;
        },
        approvalsUpdate: async ({ artifactId, request }) => writeApprovalRequestArtifact({ artifactId, request,
            read: account.fetchArtifact, write: (basis, header, body) => account.updateArtifact(artifactId, header, body, basis) }),
        isApprovalExecutionOriginCurrent: async ({ origin, request }) => isApprovalExecutionOriginCurrentForAccountContext({
            origin, accountServerId: homeId, accountId: account.accountId }) && Boolean(origin.externalActionExecutionAuthorization
            && origin.externalActionInputSignature && origin.target && verifyExternalActionApprovalInputV1({
                authorizationToken: origin.externalActionExecutionAuthorization.token, actionId: 'machines.setup.apply',
                input: request.actionArgs, target: origin.target, publicKey: installationKey.publicKey, signature: origin.externalActionInputSignature })),
    });
    const operations = createHostActionOperationRuntime({ machineId: target.machine.machineId,
        custodyBinding: { serverId: homeId, installationId: 'test-installation' }, resolveAccountId: async () => 'alice' });
    const setupPreparation = createCombinedMachineSetupActionDeps({ readDeps: () => receiverDeps,
        targetPlan: receiverDeps.machineSetupPlan!, orchestrationDirectory: process.cwd(),
        readHostFacts: async () => ({ machines: [{ machineId: target.machine.machineId, online: true },
            { machineId: 'machine-1', online: !secondTargetUnavailable }],
            offlineMachineIds: secondTargetUnavailable ? ['machine-1'] : [] }),
        startCombined: async () => { throw new Error('The remote OS effect boundary must not start a local Workflow'); },
        waitForRun: async () => { throw new Error('The remote OS effect boundary must not observe a local Workflow'); },
    });
    const receiver = createCliActionExecutorHarness({ token: account.credentials.token,
        credentials: { token: account.credentials.token, encryption: null }, sessionId: '', mode: 'plain', ctx: null,
        serverId: homeId, serverIdentityId: target.machine.serverIdentityId, serverHttpBaseUrl: account.endpointUrl,
    }, { ...receiverDeps, machineSetupPlan: setupPreparation.machineSetupPlan,
        prepareMachineSetupApply: setupPreparation.prepareMachineSetupApply,
        runActionOperation: operations.runActionOperation }).executor;
    for (const actionId of ['machines.setup.plan', 'machines.setup.apply'] as const) {
    const authorize = (envelope: ReturnType<typeof ExternalActionRequestEnvelopeV1Schema.parse>) => {
        const authentication = readOriginalAccountActionAuthentication(account.credentials.token);
        if (!authentication || envelope.target?.kind !== 'machine') throw new Error('Expected an authenticated Account Machine invocation');
        return ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'software-test-authorization', binding: {
            accountId: 'alice', authentication, serverIdentityId: target.machine.serverIdentityId,
            machineId: target.machine.machineId, custodianAccountId: 'alice', installationId: 'test-installation',
            accountEncryptionMode: 'plain', actionId, requestId: envelope.requestId, target: envelope.target,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        } });
    };
    homes.answer(homeId, bindExternalActionExecutionAuthorizationHttpPathV1(actionId), { select: input => {
        const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(input);
        return { body: authorize(ExternalActionRequestEnvelopeV1Schema.parse(request.envelope)) };
    } });
    homes.answer(homeId, `/v1/actions/${actionId}`, {
        select: async input => {
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(input);
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.success ? request.data.envelope : input);
            const authorization = request.success ? request.data.executionAuthorization! : authorize(envelope);
            const requester = openExternalActionRequesterAccountContextV1({ authorization, purpose: { kind: 'external_action' },
                machineId: target.machine.machineId, installationId: 'test-installation', serverIdentityId: target.machine.serverIdentityId,
                installationPrivateKey: installationKey.privateKey, includeInvocation: true });
            confirmation ??= requester?.invocation?.presentUserConfirmation;
            const execution = await receiver.execute(actionId, envelope.input, { surface: 'ui', authority: 'present_user',
                serverId: homeId, serverIdentityId: target.machine.serverIdentityId, runtimeAccountId: target.scope.accountId,
                actionCaller: requester?.invocation?.caller ?? { kind: 'host' },
                ...(requester?.invocation?.presentUserConfirmation ? { presentUserConfirmation: requester.invocation.presentUserConfirmation } : {}),
                actionRequestId: envelope.requestId, externalActionTarget: envelope.target, externalActionExecutionAuthorization: authorization,
                signExternalActionApprovalInput: ({ actionId, input, target, authorization }) => signExternalActionApprovalInputV1({
                    actionId, input, target, authorizationToken: authorization.token, privateKey: installationKey.privateKey }) });
            return { body: { v: 1, actionId, requestId: envelope.requestId, execution } };
        },
    });
    }
    const { StoreSoftwareEntry } = await import('./StoreSoftwareEntry');
    let detail: StoreSoftwareEntryState | undefined;
    const tree = (presented: boolean) => <StoreSoftwareEntry target={target} selection={{ value: ref, label: 'Exact package' }} demand={{ presented }}>
        {state => { detail = state; return null; }}
    </StoreSoftwareEntry>;
    const screen = await renderScreen(tree(true));
    await waitForHomeGovernance(() => expect(detail?.status).toBe('ready'));
    const targets = [target, { ...target, machine: { ...target.machine!, machineId: 'machine-1' } }];
    const inputs = { manager: 'apt', packages: [{ name: 'exact-package', version: '2.1' }] };
    let prepared: Awaited<ReturnType<StoreSoftwareEntryState['prepare']>> | undefined;
    await act(async () => { prepared = await detail?.prepare?.({ inputs, targets }); });
    expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true, input: { targets: targets.map(target => ({ machineId: target.machine!.machineId,
        sources: [{ kind: 'direct', setup: { scripts: [{ body: 'echo retained\r\n' }], items: [{ kind: 'softwareRecipe', selection: { ref, inputs } }] } }] })) } });
    expect(applied).toEqual([]);
    expect(effects).toMatchObject([{ machineId: 'machine-0' }, { machineId: 'machine-1' }]);
    if (!prepared?.ok) throw new Error('Expected the combined reviewed operands');
    expect(prepared.input.targets.map(target => target.recipePlans)).toEqual(targets.map(target => [expect.objectContaining({
        sourceIndex: 0, itemIndex: 0, plan: expect.objectContaining({
            basis: { kind: 'setup', machineId: target.machine.machineId, desiredRevision: 4, selection: { ref, inputs } },
            steps: [expect.objectContaining({ id: 'install', kind: 'package', manager: 'apt', packages: inputs.packages })],
        }),
    })]));
    const applyInput = prepared.input;
    const reviewedApply = detail!.apply;
    await screen.update(tree(false));
    const clickedInput = { ...applyInput, targets: applyInput.targets.map(target => ({ ...target })) };
    await act(async () => {
        const pending = reviewedApply(clickedInput);
        clickedInput.targets[0]!.desiredRevision += 1;
        const outcome = await pending;
        expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true, result: { operationId: expect.any(String) } });
        if (!outcome.ok || !outcome.result || typeof outcome.result !== 'object' || !('operationId' in outcome.result))
            throw new Error('Software Apply must expose the receiving operation');
        expect(await operations.handlers.getV2({ operationId: outcome.result.operationId, waitForTerminal: true }))
            .toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
    });
    expect(homes.artifacts(homeId).list()).toHaveLength(0);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toEqual(applyInput);
    expect(await receiver.execute('machines.setup.apply', applyInput, { surface: 'agent', authority: 'account_automation',
        actionCaller: { kind: 'host' }, serverId: homeId, serverIdentityId: target.machine.serverIdentityId,
        runtimeAccountId: 'alice', actionRequestId: 'agent-software-install', defaultSessionId: 'agent-session',
        defaultSessionMachineId: target.machine.machineId })).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ targets: [{ machineId: 'machine-0' }, { machineId: 'machine-1' }] });
    expect(homes.requests.filter(request => request.path === '/v1/actions/machines.setup.apply')).toHaveLength(1);
    await screen.update(tree(true));
    await waitForHomeGovernance(() => expect(detail?.status).toBe('ready'));
    const planReads = homes.requests.filter(request => request.path === '/v1/actions/machines.setup.plan').length;
    const { recordMachineRequestFailed } = await import('@/sync/domains/machines/reachability/machineReachability');
    await act(async () => { recordMachineRequestFailed({ ...target.scope, machineId: 'machine-1', observedAtMs: Date.now() + 1 }); });
    secondTargetUnavailable = true;
    // Native combined Plan owns unavailable dispositions even when Store already holds an offline observation.
    await act(async () => { prepared = await detail?.prepare({ inputs, targets }); });
    expect(prepared).toMatchObject({ ok: true, unavailableTargets: [{ homeId: target.machine.serverIdentityId,
        machineId: 'machine-1', status: 'unavailable', reason: 'offline', errorCode: 'machine_offline' }],
        input: { targets: [{ machineId: 'machine-0' }] } });
    if (!prepared?.ok) throw new Error('Expected one review retaining the unavailable target');
    expect(prepared.input.targets).toHaveLength(1);
    expect(applied).toHaveLength(1);
    const offlinePlans = homes.requests.filter(request => request.path === '/v1/actions/machines.setup.plan').slice(planReads);
    expect(offlinePlans.map(request => ExternalActionRequestEnvelopeV1Schema.parse(request.input).input)).toMatchObject([
        { targets: [{ machineId: 'machine-0' }, { machineId: 'machine-1' }] },
        { targets: [{ machineId: 'machine-0', mode: 'effects' }] },
    ]);
    const beforeOfflineOnly = effects.length;
    await act(async () => { prepared = await detail?.prepare({ inputs, targets: [targets[1]!] }); });
    expect(prepared).toMatchObject({ ok: false, errorCode: 'machine_offline', details: { targets: [
        { homeId: target.machine.serverIdentityId, machineId: 'machine-1', status: 'unavailable', reason: 'offline' },
    ] } });
    expect(effects).toHaveLength(beforeOfflineOnly);
    expect(applied).toHaveLength(1);
    // Recovery is a fresh native plan of B only, not a Store replay of settled A.
    secondTargetUnavailable = false;
    const settledAEffects = effects.length;
    await act(async () => { prepared = await detail?.prepare({ inputs, targets: [targets[1]!] }); });
    expect(prepared).toMatchObject({ ok: true, input: { targets: [{ machineId: 'machine-1' }] } });
    expect(effects.slice(settledAEffects)).toMatchObject([{ machineId: 'machine-1' }]);
    expect(applied).toHaveLength(1);
    if (!confirmation?.inputDigest) throw new Error('Expected the native confirmation recovered from the private invocation');
    const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
    const changedInput = { ...applyInput, targets: applyInput.targets.map(value => ({ ...value,
        sources: value.sources.map(source => source.kind !== 'direct' ? source : { ...source, setup: { ...source.setup,
            scripts: [...(source.setup.scripts ?? []), { body: 'echo changed' }] } }),
    })) };
    const approvalsBeforeChangedInput = homes.artifacts(homeId).list().length;
    const changedOutcome = await createFrontDoorActionExecute().confirmed('machines.setup.apply', changedInput, { surface: 'ui',
        serverId: homeId, expectedAccountId: 'alice', presentUserConfirmation: confirmation });
    // docs/actions.md: a native confirmation admits only its exact normalized input;
    // a person's UI review stays local rather than manufacturing a self-approval Artifact.
    expect(changedOutcome, JSON.stringify(changedOutcome)).toMatchObject({
        ok: false, errorCode: 'action_interactive_review_required',
    });
    expect(homes.artifacts(homeId).list()).toHaveLength(approvalsBeforeChangedInput);
    expect(applied).toHaveLength(1);
});

it('asks a package recipe for its declared fields and enables Install only for a valid draft', async () => {
    const { target, entries } = await setup();
    const pkg = { ...ref, recipeId: 'by-name' };
    entries[0] = PluginProjectedMachineRecipeEntryV1Schema.parse({
        id: `${pkg.pluginId}/${pkg.recipeId}`, pluginId: pkg.pluginId, pluginVersion: '1.4.0', source: { kind: 'bundled', locator: pkg.pluginId },
        definition: { id: pkg.recipeId, revision: '1', title: 'Install a package by name', software: true, icon: 'download',
            inputSchema: { type: 'object', properties: { package: { type: 'object', properties: {
                manager: { type: 'string', enum: ['apt', 'brew'] },
                identity: { type: 'object', properties: { name: { type: 'string', pattern: '^[a-z0-9][a-z0-9+.-]*$' },
                    version: { type: 'string', pattern: '^[0-9][0-9.]*$' } }, required: ['name'], additionalProperties: false } },
                required: ['manager', 'identity'], additionalProperties: false } }, required: ['package'], additionalProperties: false },
            inputHints: { fields: [
                { path: 'package.manager', title: 'Package manager', widget: 'select', required: true,
                    options: [{ value: 'apt', label: 'APT' }, { value: 'brew', label: 'Homebrew' }] },
                { path: 'package.identity.name', title: 'Package name', widget: 'text', required: true },
                { path: 'package.identity.version', title: 'Exact version', widget: 'text' },
            ] },
            steps: [{ id: 'install', kind: 'package', manager: { kind: 'input', path: 'package.manager' }, packages: [{ kind: 'input', path: 'package.identity' }] }],
        },
    });
    const { SoftwareListing } = await import('./StoreSoftwarePage');
    const machines = { targets: [{ target, machine: { machineId: 'machine-0', platform: 'posix' as const, os: 'linux', arch: 'x64',
        agentIds: [], name: 'Build box', online: true } }] };
    const item = { value: { pluginId: pkg.pluginId, recipeId: pkg.recipeId, revision: '1' }, label: 'Install a package by name',
        icon: 'download' as const, version: '1.4.0', source: { kind: 'bundled', locator: pkg.pluginId } };
    const screen = await renderScreen(<SoftwareListing target={target} item={item} machines={machines} pushed={false} onClose={() => {}} />);
    const primary = () => screen.findHostByTestId('store.software.listing:primary')!;
    await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Package manager'));
    const text = screen.getTextContent();
    expect(text).not.toContain('Needs exact packages');
    expect(text).toContain('1.4.0');
    expect(text).toContain('Version of the plugin that offers this');
    expect(text).toContain('Included with Happier');
    expect(primary().props.accessibilityHint).toBe('Enter Package manager first');
    await act(async () => { screen.root.findByProps({ accessibilityLabel: 'APT' }).props.onPress?.(); });
    await flushHookEffects();
    expect(primary().props.accessibilityHint).toBe('Enter Package name first');
    await act(async () => { changeTextTestInstance(screen.findHostByTestId('store.software.listing.input.package.identity.name'), 'Bad Name'); });
    await flushHookEffects();
    expect(primary().props.accessibilityHint).toBe('Check the package details');
    await act(async () => { changeTextTestInstance(screen.findHostByTestId('store.software.listing.input.package.identity.name'), 'google-chrome-stable'); });
    await flushHookEffects();
    expect(primary().props.accessibilityHint).toBe('Turn on at least one Machine');
    const { Switch } = await import('@/components/ui/forms/Switch');
    const second = { target: { ...target, machine: { ...target.machine, machineId: 'machine-1' } },
        machine: { ...machines.targets[0]!.machine, machineId: 'machine-1', name: 'Second box' } };
    const listing = (online: boolean) => <SoftwareListing target={target} item={item}
        machines={{ targets: [machines.targets[0]!, { ...second, machine: { ...second.machine, online } }] }}
        pushed={false} onClose={() => {}} />;
    await screen.update(listing(true));
    const secondSwitch = () => screen.root.findAllByType(Switch).find(node => node.props.accessibilityLabel === 'Second box')!;
    await act(async () => { secondSwitch().props.onValueChange(true); });
    expect(secondSwitch().props.value).toBe(true);
    await screen.update(listing(false));
    // Losing reachability must preserve the person's exact choice and still let them explicitly remove it.
    expect(secondSwitch().props.value).toBe(true);
    expect(secondSwitch().props.disabled).toBe(false);
    expect(primary().props.accessibilityHint).toBeUndefined();
    expect(screen.getTextContent()).toContain('Offline');
    await act(async () => { secondSwitch().props.onValueChange(false); });
    expect(secondSwitch().props.value).toBe(false);
    expect(primary().props.accessibilityHint).toBe('Turn on at least one Machine');

    // The Store page holds the Install on… choice: closing the listing and opening it again keeps it.
    const { SoftwareTargetsDraftProvider } = await import('./StoreSoftwareTargets');
    await act(async () => { storage.setState({ settingsScope: target.scope }); });
    const page = (open: boolean) => <SoftwareTargetsDraftProvider>{open ? listing(true) : null}</SoftwareTargetsDraftProvider>;
    await screen.update(page(true));
    await act(async () => { secondSwitch().props.onValueChange(true); });
    await screen.update(page(false));
    expect(screen.root.findAllByType(Switch)).toHaveLength(0);
    await screen.update(page(true));
    await waitForHomeGovernance(() => expect(secondSwitch().props.value).toBe(true));
    await act(async () => { storage.setState({ settingsScope: { ...target.scope, accountId: 'bob' } }); });
    expect(secondSwitch().props.value).toBe(false);
    await act(async () => { storage.setState({ settingsScope: target.scope }); });
    expect(secondSwitch().props.value).toBe(false);
});

it('lets mixed-kind Search choose the one Machine whose Software it includes, writing the route target', async () => {
    const { target } = await setup();
    const applied = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const previousState = storage.getState();
    const previousApplied = applied.getAppliedActiveServerSnapshot();
    const previousAvailable = applied.isAppliedActiveServerRuntimeAvailable();
    onTestFinished(() => {
        storage.setState(previousState, true);
        applied.publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
    });
    await act(async () => {
        storage.setState({ profileScope: target.scope, settingsScope: target.scope });
        applied.publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        // The active Account's own Machines, as the reach owner reads them once that Account is current.
        storage.getState().applyMachines([createMachineFixture({ id: 'machine-0', activeAt: Date.now() }),
            createMachineFixture({ id: 'machine-1', activeAt: Date.now() })], true,
        { sourceServerId: target.scope!.serverId, sourceAccountId: target.scope!.accountId, replace: false });
    });
    const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
    const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
    const { resolveCompactAppDestinations, resolveDestinationRefFromHref } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
    const { StoreSearchPage } = await import('./StoreSearchPage');
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
    const destination = resolveDestinationRefFromHref(catalog, '/plugins?view=search')!;
    function Page() {
        const [params, setParams] = React.useState<Record<string, string>>({ ...destination.params, q: 'Exact package',
            filters: JSON.stringify({ kind: { include: ['software'], exclude: [] } }) });
        return <DestinationInstanceHost tabId="software-search-choose" pathname="/plugins" focused visible ref={{ ...destination, params }}
            navigation={{ push: () => {}, replace: () => {}, back: () => {}, setParams: values => setParams(previous => {
                const next = { ...previous };
                for (const [key, value] of Object.entries(values)) {
                    if (value === undefined) delete next[key]; else next[key] = value;
                }
                return next;
            }) }}>
            <AppPaneProvider><StoreSearchPage presented /></AppPaneProvider>
        </DestinationInstanceHost>;
    }
    const screen = await renderScreen(<Page />, searchRenderOptions);
    // The shared chip owner the chooser renders.
    const chooser = () => screen.root.findAll(node => node.props.filter?.testID === 'store.search.software.machine')[0];
    await waitForHomeGovernance(() => expect(chooser()).toBeDefined());
    // Nothing is guessed: no Machine is named and no Machine is read until the person chooses one.
    expect(chooser()!.props.filter.selectedId).toBeNull();
    expect(screen.getTextContent()).not.toContain('Connect a Machine');
    expect(network.requests).toHaveLength(0);
    await act(async () => { chooser()!.props.filter.onChange('machine-0'); });
    await waitForHomeGovernance(() => expect(network.requests.map(request => request.targetId)).toEqual(['machine-0']));
    expect(chooser()!.props.filter.selectedId).toBe('machine-0');
    const rowID = `store.kind.search.row.${actionInputOptionValueKey(ref)}`;
    await expectSearchRow(screen, rowID);
});

it('keeps the Software Machine chooser out of a mixed-kind Search that found no Software', async () => {
    const { target } = await setup();
    const applied = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const previousState = storage.getState();
    const previousApplied = applied.getAppliedActiveServerSnapshot();
    const previousAvailable = applied.isAppliedActiveServerRuntimeAvailable();
    onTestFinished(() => {
        storage.setState(previousState, true);
        applied.publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
    });
    await act(async () => {
        storage.setState({ profileScope: target.scope, settingsScope: target.scope });
        applied.publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        storage.getState().applyMachines([createMachineFixture({ id: 'machine-0', activeAt: Date.now() })], true,
            { sourceServerId: target.scope!.serverId, sourceAccountId: target.scope!.accountId, replace: false });
    });
    const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
    const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
    const { resolveCompactAppDestinations, resolveDestinationRefFromHref } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
    const { StoreSearchPage } = await import('./StoreSearchPage');
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
    const destination = resolveDestinationRefFromHref(catalog, '/plugins?view=search')!;
    const params = { ...destination.params, q: 'zz-no-software-matches-this' };
    const screen = await renderScreen(<DestinationInstanceHost tabId="software-search-none" pathname="/plugins" focused visible
        ref={{ ...destination, params }} navigation={{ push: () => {}, replace: () => {}, back: () => {}, setParams: () => {} }}>
        <AppPaneProvider><StoreSearchPage presented /></AppPaneProvider>
    </DestinationInstanceHost>, searchRenderOptions);
    // The page and its held Machines are mounted (the chooser reads them synchronously), so a chooser would be here now.
    await waitForHomeGovernance(() => expect(screen.findByTestId('store.search.field')).not.toBeNull());
    await flushHookEffects();
    await flushHookEffects();
    // The chooser narrows Software results; with none it would sit above every other kind's results.
    expect(screen.root.findAll(node => node.props.filter?.testID === 'store.search.software.machine')).toHaveLength(0);
    expect(screen.findHostByTestId('store.search.software.source')).toBeNull();
});
