import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { AccountProfileSchema} from '@happier-dev/protocol/account/profile';
import { PluginProjectionV2Schema} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS} from '@happier-dev/protocol/rpc/methods';
import { createWorkBoardV1} from '@happier-dev/protocol/boards/workBoardV1';
import { type PublicActionInputById } from '@happier-dev/protocol/actions/actionSpecs';
import { flushHookEffects, renderScreen as renderBaseScreen, standardCleanup } from '@/dev/testkit';
import { HappierInputField, useHappierInputPickerPort } from '@happier-dev/plugin-ui/presentation';
import { View } from 'react-native';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { USAGE_QUERY_INPUT_FIELDS } from '@happier-dev/protocol/inputs/usageQuery';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installSessionActionFixture } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { createHydratedPlainMachineFixture, createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { widgetProjectionEntry } from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { createWorkBoardArtifactBoundary } from '@/dev/testkit/harness/workBoardArtifactBoundary';
import { createWorkBoardAccountStore } from '@/components/boards/model/workBoardAccountStore';
import { buildAccountWidgetAddSections } from './accountWidgetAddSections';
import { resolveSemanticInputTypePickerReference } from '@/components/sessions/actions/inputTypePickerPort';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

// Only network transports are replaced: Account admission, the catalog, executor,
// draft binding and options demand all remain real.
const discovery = vi.hoisted(() => ({ requests: [] as PublicActionInputById['action.options.resolve'][], wait: null as (() => Promise<void>) | null,
    unrelatedMachine: false, fail: false }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async (args: { method: string; machineId?: string; payload: unknown }) => {
        if (args.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)
            return { protocolVersion: 1, projection: pickerProjections.get(args.machineId ?? '') ?? projectionWire };
        throw new Error(`Unexpected daemon RPC: ${args.method}`);
    },
}));
installDisconnectedServerSocketBoundary();
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const { buildWidgetCandidateSetup } = await import('@/components/widgets/surface/widgetSurfaceSetup');
const { buildWidgetGroupInputsCandidate } = await import('@/components/widgets/group/widgetGroupInputs');
const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
const { WidgetSetupStep } = await import('./WidgetSetupStep');
const { ItemGroup } = await import('@/components/ui/lists/ItemGroup');
const { WidgetSetupFieldRow } = await import('./WidgetSetupFieldRow');
const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
const { WidgetPreviewStage } = await import('@/components/widgets/flow/WidgetPreviewStage');
const { storage } = await import('@/sync/domains/state/storage');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const { normalizePluginUiProjection } = await import('@/sync/domains/plugins/ui/projection');
const { unionPluginUiProjections } = await import('@/sync/domains/plugins/ui/projectionUnion');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { InputTypePickerHostProvider } = await import('@/components/sessions/actions/InputTypePickerHostProvider');
const pickerProjections = new Map<string, ReturnType<typeof PluginProjectionV2Schema.parse>>();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let releaseLoader: (() => void) | undefined;
let projectionWire: ReturnType<typeof PluginProjectionV2Schema.parse>;
let scope: WidgetSurfaceRefV1;
beforeEach(async () => {
    await homes.reset();
    const serverIdentityId = 'srv_setup_home';
    const serverId = await homes.addHome({ name: 'Setup', serverUrl: 'https://setup-home.test', serverIdentityId, accountId: 'me', currentAccount: true });
    const profile = AccountProfileSchema.parse({ id: 'me', connectedAccountsV4: [{ ref: { service: { pluginId: 'acme.options', localId: 'cloud' }, accountId: 'mine' },
        status: 'connected', authenticationModeId: 'token', configurationReady: true, configurationRevision: null,
        revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', scopes: [] }] });
    homes.answer(serverId, '/v1/account/profile', { body: profile });
    const external = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://setup-home.test', serverIdentityId,
        accountId: 'me', machineId: 'machine_1', actionId: 'action.options.resolve', tokenEpoch: 0,
        execute: async payload => {
            const input = (await import('@happier-dev/protocol/actions')).PUBLIC_ACTION_INPUT_SCHEMAS['action.options.resolve'].parse(payload);
            discovery.requests.push(input);
            await discovery.wait?.();
            if (discovery.fail) throw new Error('options read failed');
            const selected = input.consumer?.kind === 'widget' ? input.consumer.selectedSession?.sessionId : undefined;
            return { actionId: 'widgets.item.add', fieldPath: input.fieldPath ?? null, optionsSourceId: null,
                options: [{ value: 'choice', label: `${selected ?? 'ambient'}:${input.draftInput?.filter ?? 'none'}` }] };
        } });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://setup-home.test', serverIdentityId, accountId: 'me',
        credentials: { token: createAccountTokenForTests('me', { currentAccount: true }) },
        request: async (input, init) => {
            const url = new URL(String(input));
            const response = await external.handle(url, init);
            if (url.pathname === '/v1/machines' && response && discovery.unrelatedMachine) {
                const current: unknown = await response.json();
                if (!Array.isArray(current)) throw new Error('Expected the Machine census');
                return Response.json([{ ...createPlainMachineRowFixture({ id: 'unrelated', accountId: 'me' }), createdAt: 2 }, ...current]);
            }
            return response ?? homes.request(input, init);
        } });
    scope = { serverId: connection.home.id, accountId: 'me', owner: { kind: 'home' } };
    for (const id of ['A', 'B']) installSessionActionFixture({ homes, storage, serverId, session: { id } });
    storage.setState({ machines: { machine_1: createMachineFixture({ id: 'machine_1', active: true, activeAt: Date.now() }) }, profile });
    const consumer = { pluginId: 'acme.options', localId: 'checks' };
    const entries = [{ ...widgetProjectionEntry({ ...candidate.surface!, target: 'session', inputs: { fields: [
        ...candidate.inputs!.fields, { path: 'connection', title: 'Connection', widget: 'select', connectedAccountOptions: true },
    ] }, inputSchema: { type: 'object', properties: { session: { type: 'object' }, filter: { type: 'string' }, result: { type: 'string' },
        connection: { type: 'object', required: ['service', 'accountId'], additionalProperties: false, properties: {
            service: { type: 'object', required: ['pluginId', 'localId'], additionalProperties: false,
                properties: { pluginId: { type: 'string' }, localId: { type: 'string' } } }, accountId: { type: 'string' },
        } } } }, resources: [consumer] }),
        connectedAccountPurposeBindings: [{ path: 'connection', purpose: 'metrics', consumer }] },
    widgetProjectionEntry({ pluginId: 'acme.options', localId: 'first', target: 'app', inputs: { fields: [
        { path: 'period', title: 'Period', widget: 'select', inputType: { pluginId: 'acme.options', localId: 'choice' } },
        { path: 'result', title: 'Owned result', widget: 'select', inputType: { pluginId: 'acme.options', localId: 'choice' }, contextMode: 'own' },
    ] }, inputSchema: { type: 'object', properties: { period: { type: 'string' }, result: { type: 'string' } }, additionalProperties: false } }),
    { ...widgetProjectionEntry({ pluginId: 'acme.options', localId: 'personal', target: 'app', inputs: { fields: [
        { path: 'connection', title: 'Connection', widget: 'select', required: true, connectedAccountOptions: true },
    ] }, inputSchema: { type: 'object', properties: { connection: { type: 'object', required: ['service', 'accountId'], additionalProperties: false,
        properties: { service: { type: 'object', required: ['pluginId', 'localId'], additionalProperties: false,
            properties: { pluginId: { type: 'string' }, localId: { type: 'string' } } }, accountId: { type: 'string' } } },
    }, additionalProperties: false }, resources: [consumer] }), connectedAccountPurposeBindings: [{ path: 'connection', purpose: 'metrics', consumer }] }];
    projectionWire = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
        installedPackagesById: { 'acme.options': { id: 'acme.options', displayName: 'Options', enabled: true,
            occurrenceId: 'acme.options#1', source: { kind: 'local', locator: '/plugins/acme.options' } } },
        familiesById: { pluginUi: { family: 'pluginUi', entriesById: Object.fromEntries(entries.map(entry => [entry.id, entry])) },
            inputTypes: { family: 'inputTypes', entriesById: { 'acme.options/choice': {
                id: 'acme.options/choice', pluginId: 'acme.options', pluginVersion: '1.0.0', occurrenceId: 'acme.options#1',
                definition: { id: 'choice', title: 'Choice', semantic: 'choice', valueSchema: { type: 'string' }, options: { resource: 'checks' } },
            } } } },
        resourcesById: { checks: { id: 'checks', pluginId: 'acme.options', resourceKind: 'config', scope: 'global',
            connectedAccountPurposes: [{ purpose: 'metrics', serviceRefs: [{ pluginId: 'acme.options', localId: 'cloud' }] }] } } });
    clearDaemonMergedProjectionCacheForTests();
    releaseLoader = await installRealActionExecutorModuleLoader();
});
afterEach(async () => {
    standardCleanup(); discovery.requests = []; discovery.wait = null; discovery.unrelatedMachine = false; discovery.fail = false; pickerProjections.clear(); releaseLoader?.(); releaseLoader = undefined;
    clearDaemonMergedProjectionCacheForTests(); await connection?.dispose(); connection = undefined;
});
function renderScreen(element: React.ReactElement, union = false) {
    const origin = { serverIdentityId: 'srv_setup_home', sourceRef: { machineId: 'machine_1', pluginId: 'acme.options',
        sourceCustody: { kind: 'development' as const, registeredRootId: 'options-root' } } };
    const normalized = normalizePluginUiProjection(projectionWire);
    const runtime = union ? unionPluginUiProjections([
        { machineId: 'machine_1', serverId: scope.serverId, serverIdentityId: 'srv_setup_home', phase: 'current', interactionEnabled: true,
            selectableExecutionOrigins: [origin], projection: { ...normalized, installedPackagesById: {
                ...normalized.installedPackagesById, 'acme.options': { ...normalized.installedPackagesById['acme.options']!, executionOrigin: origin },
            } } },
        { machineId: 'unrelated', serverId: scope.serverId, serverIdentityId: 'srv_setup_home', phase: 'current', interactionEnabled: true, projection: null },
    ], new Map([['acme.options', origin]])) : null;
    return renderBaseScreen(<AppShellPluginUiProjectionValueProvider value={{
        pluginUiProjection: union ? runtime!.pluginUiProjection : normalized, pluginBrowserProjection: null, phase: 'current', interactionEnabled: true,
        machineId: union ? runtime!.machineId : 'machine_1', serverId: scope.serverId, platform: 'web', accountLifetime: captureActiveServerAccountScopeLifetime(),
        reloadConnectedAccountProjection: () => {}, clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {},
    }}>{element}</AppShellPluginUiProjectionValueProvider>);
}

const candidate: WidgetCandidate = { key: 'acme.options/checks', title: 'Checks', pluginName: 'Options', sharedPluginName: false,
    icon: 'squares-four', homeDefault: 'available', target: 'session', sessionInputPath: 'session',
    sizeDeclaration: { sizes: ['small', 'medium', 'wide', 'full', 'tall', 'large'], defaultSize: 'medium' },
    surface: { pluginId: 'acme.options', localId: 'checks' }, inputs: { fields: [
        { path: 'session', title: 'Session', widget: 'json', required: true },
        { path: 'filter', title: 'Filter', widget: 'text' },
        { path: 'result', title: 'Result', widget: 'select', required: true, inputType: { pluginId: 'acme.options', localId: 'choice' } },
    ] } };

describe('WidgetSetupStep discovery', () => {
    it.each([false, true, 'session'] as const)('offers each contributed picker from its own producer in a mixed-plugin group (inherited port: %s)', async inherited => {
        const { normalizePluginUiProjection } = await import('@/sync/domains/plugins/ui/projection');
        const { loadDaemonMergedProjectionCacheEntry } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
        const accountLifetime = captureActiveServerAccountScopeLifetime()!;
        const fields = ['acme.first', 'acme.second'].map(pluginId => ({ path: pluginId, title: pluginId,
            inputType: { pluginId, localId: 'choice' } }));
        const origins = fields.map(({ inputType }, index) => ({ serverIdentityId: 'srv_setup_home', sourceRef: {
            machineId: `picker-${index}`, pluginId: inputType.pluginId,
            sourceCustody: { kind: 'development' as const, registeredRootId: `picker-root-${index}` },
        } }));
        const members = fields.map(({ inputType }, index) => {
            const { pluginId } = inputType;
            const origin = origins[index]!;
            const renderer = { pluginId, localId: 'browse' };
            const wire = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
                installedPackagesById: { [pluginId]: { id: pluginId, displayName: pluginId, version: '1.0.0', enabled: true,
                    occurrenceId: 'current', source: { kind: 'local', locator: `/plugins/${pluginId}` }, executionOrigin: origin } },
                familiesById: { inputTypes: { family: 'inputTypes', entriesById: { [`${pluginId}/choice`]: {
                    id: `${pluginId}/choice`, pluginId, pluginVersion: '1.0.0', occurrenceId: 'current', executionOrigin: origin,
                    definition: { id: 'choice', title: 'Choice', semantic: pluginId, valueSchema: { type: 'string' }, picker: 'browse' },
                    pickerSurface: { contribution: inputType, occurrenceId: 'current', projectionGeneration: 1,
                        rendererChain: [renderer], selectedRenderer: { identity: renderer,
                            renderer: { kind: 'declarative', contributionId: 'browse' },
                            availability: { state: 'available', reason: 'available', diagnostics: [] } },
                        executionOrigin: origin, resourceCapability: { readable: false, dynamic: false },
                        contributorTargetedContributions: { target: { pluginId, occurrenceId: 'current', sourceCustody: origin.sourceRef.sourceCustody }, points: [] },
                    },
                } } } } });
            pickerProjections.set(origin.sourceRef.machineId, wire);
            return { machineId: origin.sourceRef.machineId, serverId: scope.serverId, serverIdentityId: origin.serverIdentityId,
                phase: 'current' as const, interactionEnabled: true, selectableExecutionOrigins: [origin], projection: normalizePluginUiProjection(wire) };
        });
        let fieldTargets: React.ComponentProps<typeof InputTypePickerHostProvider>['fieldTargets'];
        if (inherited === 'session') {
            const appWire = pickerProjections.get('picker-0')!;
            const identity = fields[0]!.inputType;
            const key = `${identity.pluginId}/${identity.localId}`;
            const entry = appWire.familiesById.inputTypes!.entriesById[key]!;
            const { picker: _picker, ...withoutPicker } = entry.definition;
            const { pickerSurface: _surface, ...withoutSurface } = entry;
            const appWithoutPicker = PluginProjectionV2Schema.parse({ ...appWire, familiesById: {
                ...appWire.familiesById, inputTypes: { family: 'inputTypes', entriesById: { [key]: { ...withoutSurface, definition: withoutPicker } } },
            } });
            pickerProjections.set('picker-0', appWithoutPicker);
            members[0]!.projection = normalizePluginUiProjection(appWithoutPicker);
            const origin = { ...origins[0]!, sourceRef: { ...origins[0]!.sourceRef, machineId: 'picker-bound' } };
            const sessionWire = PluginProjectionV2Schema.parse({ ...appWire,
                installedPackagesById: { [identity.pluginId]: { ...appWire.installedPackagesById[identity.pluginId]!,
                    occurrenceId: 'session-current', executionOrigin: origin } },
                familiesById: { ...appWire.familiesById, inputTypes: { family: 'inputTypes', entriesById: { [key]: {
                    ...entry, occurrenceId: 'session-current', executionOrigin: origin,
                    pickerSurface: { ...entry.pickerSurface!, occurrenceId: 'session-current', executionOrigin: origin,
                        contributorTargetedContributions: { ...entry.pickerSurface!.contributorTargetedContributions,
                            target: { ...entry.pickerSurface!.contributorTargetedContributions.target, occurrenceId: 'session-current' } } },
                } } } } });
            pickerProjections.set('picker-bound', sessionWire);
            await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId: 'picker-bound', serverId: scope.serverId, accountLifetime });
            fieldTargets = { [fields[0]!.path]: { machineId: 'picker-bound', serverId: scope.serverId, sessionId: 'B' } };
        }
        await Promise.all(members.map(member => loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId: member.machineId,
            serverId: scope.serverId, accountLifetime })));
        const projection = unionPluginUiProjections(members, new Map(origins.map(origin => [origin.sourceRef.pluginId, origin]))).pluginUiProjection;
        function PickerProbe() {
            const port = useHappierInputPickerPort();
            return <>{fields.map(field => {
                const inputType = resolveSemanticInputTypePickerReference(port, field.inputType.pluginId, field);
                return <View key={field.path} testID={field.path} accessibilityLabel={port?.describe(field)?.label ?? 'missing'}
                    accessibilityValue={{ text: inputType ? `${inputType.pluginId}/${inputType.localId}` : 'missing' }} />;
            })}</>;
        }
        const fieldsWithProducer = <InputTypePickerHostProvider enabled serverId={scope.serverId} accountLifetime={accountLifetime}
            pluginUiProjection={projection} pluginUiMachineId={null} machineId={null} fieldTargets={fieldTargets}><PickerProbe /></InputTypePickerHostProvider>;
        const screen = await renderBaseScreen(inherited
            ? <InputTypePickerHostProvider enabled serverId={scope.serverId} accountLifetime={accountLifetime} machineId="machine_1">
                {fieldsWithProducer}</InputTypePickerHostProvider>
            : fieldsWithProducer);
        await vi.waitFor(() => fields.forEach(field => expect(screen.findByTestId(field.path)?.props.accessibilityLabel).toBe('inputPicker.browse')));
        fields.forEach(field => expect(screen.findByTestId(field.path)?.props.accessibilityValue.text)
            .toBe(`${field.inputType.pluginId}/${field.inputType.localId}`));
    });
    it.each([false, true])('reads contributed choices from the widget producer instead of the first reachable machine (union: %s)', async union => {
        discovery.unrelatedMachine = true;
        await publishMachineInventoryForTest(scope, [
            createHydratedPlainMachineFixture({ id: 'unrelated', accountId: scope.accountId, machine: { createdAt: 2, activeAt: Date.now() } }),
            createHydratedPlainMachineFixture({ id: 'machine_1', accountId: scope.accountId, machine: { activeAt: Date.now() } }),
        ]);
        const { resolveUiAccountActionFallbackMachineId } = await import('@/sync/ops/actions/accountActionDeps');
        expect(resolveUiAccountActionFallbackMachineId(scope)).toBe('unrelated');
        const setup = buildWidgetCandidateSetup({ candidate: { ...candidate, target: 'app', sessionInputPath: undefined,
            surface: { pluginId: 'acme.options', localId: 'first' },
            inputs: { fields: [{ path: 'period', title: 'Period', widget: 'select', required: true,
                inputType: { pluginId: 'acme.options', localId: 'choice' } }] } },
            scope, audience: 'personal', context: {}, mode: { kind: 'add', submitLabel: 'Add' }, submit: async () => ({ ok: true }) });
        const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false} serverId={scope.serverId}
            onDone={() => {}} testID="producer-options" />, union);
        await vi.waitFor(() => expect(screen.findAllByType(HappierInputField).find(field => field.props.field.path === 'period')!.props.options)
            .toEqual([expect.objectContaining({ value: 'choice', label: 'ambient:none' })]));
    });
    it('retries the same add after gallery entries rebuild, then adds another copy only by choosing the widget again', async () => {
        const board = createWorkBoardV1({ id: 'retry-board', name: 'Overview' });
        const persistence = createWorkBoardArtifactBoundary({ v: 1, boards: [board] });
        let lostAck = false;
        let readable = true;
        const store = createWorkBoardAccountStore({ ...persistence.transport,
            read: async (id, options) => { if (!readable) throw new Error('Read-back unavailable'); return persistence.transport.read(id, options); },
            update: async input => {
                const result = await persistence.transport.update(input);
                if (!lostAck) { lostAck = true; readable = false; throw new Error('Acknowledgement lost'); }
                return result;
            },
        }, () => true);
        const target = { ...scope, owner: { kind: 'workBoard', boardId: board.id } } as const;
        const completed = vi.fn();
        const addAnother = vi.fn();
        let entriesBuilt = 0;
        function GalleryStep() {
            const [chosen, setChosen] = React.useState(0);
            const boards = React.useSyncExternalStore(store.subscribe, store.getBoards, store.getBoards);
            const sections = buildAccountWidgetAddSections({ candidates: [{ ...candidate, target: 'app', sessionInputPath: undefined, inputs: { fields: [] } }],
                instances: boards.boards[0]?.widgets?.map(item => item.instance) ?? [], scope: target,
                labels: { count: count => `${count} here`, submit: 'Add' },
                addInstance: async (instance, size) => {
                    const result = await store.queue.dispatch({ kind: 'widget_add', boardId: board.id,
                        ref: { surface: target, instanceId: instance.id }, instance, ...(size ? { size } : {}) });
                    if (result.status !== 'applied') throw new Error(result.code);
                },
            });
            entriesBuilt++;
            const setup = sections.flatMap(section => section.entries).find(entry => entry.id === `plugin-${candidate.key}`)!.setup!();
            return <WidgetSetupStep key={chosen} setup={setup} phone={false} presentation="pane" onDone={completed}
                onAddAnother={() => { addAnother(); setChosen(count => count + 1); }} testID="retry-copy" />;
        }
        const screen = await renderScreen(<GalleryStep />);
        await act(async () => { screen.findByTestId('retry-copy.submit')!.props.onPress(); });
        await vi.waitFor(() => expect(store.queue.getState().failure).not.toBeNull());
        expect(completed).not.toHaveBeenCalled();
        const beforeRebuild = entriesBuilt;
        readable = true;
        // Recovery reopens the Board: an idle store reads no Board body without a view's demand.
        await act(async () => {
            const release = store.retainView(() => () => {}, 'all');
            store.invalidateBodies();
            try { await store.refresh(); } finally { release(); }
        });
        expect(entriesBuilt).toBeGreaterThan(beforeRebuild);
        expect(persistence.acknowledged().boards[0]?.widgets).toHaveLength(1);
        await act(async () => { screen.findByTestId('retry-copy.submit')!.props.onPress(); });
        await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(1));
        expect(persistence.acknowledged().boards[0]?.widgets).toHaveLength(1);
        // After an applied Add the button only returns to the picker: pressing it writes nothing.
        await act(async () => { screen.findByTestId('retry-copy.submit')!.props.onPress(); });
        expect(addAnother).toHaveBeenCalledTimes(1);
        expect(completed).toHaveBeenCalledTimes(1);
        expect(persistence.acknowledged().boards[0]?.widgets).toHaveLength(1);
        // Choosing the widget again opens a fresh step whose Add is the intentional second copy.
        await act(async () => { screen.findByTestId('retry-copy.submit')!.props.onPress(); });
        await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(2));
        const ids = persistence.acknowledged().boards[0]?.widgets?.map(item => item.instance.id);
        expect(ids).toHaveLength(2);
        expect(new Set(ids).size).toBe(2);
    });
    it('does not claim a mounted error preview is live data when its inputs resolve', async () => {
        const setup = buildWidgetCandidateSetup({ candidate: { ...candidate, target: 'app', sessionInputPath: undefined, inputs: { fields: [] } },
            scope, audience: 'personal', context: {}, mode: { kind: 'add', submitLabel: 'Add' }, submit: async () => ({ ok: true }),
            renderPreview: () => <SurfaceStateCard kind="error" replacesContent title="Read failed" /> });
        const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false} presentation="pane" onDone={() => {}} testID="read-failed" />);
        expect(screen.root.findAllByType(SurfaceStateCard).some(node => node.props.kind === 'error')).toBe(true);
        expect(screen.root.findByType(WidgetPreviewStage).props.live).not.toBe(true);
        expect(screen.findByTestId('read-failed.preview.live')).toBeNull();
        expect(screen.root.findByType(WidgetPreviewStage).props.caption).toBe('widgetAdd.preview');
    });

    it('keeps a dispatched save busy across a Home disconnect until its late receipt arrives', async () => {
        const previous = storage.getState();
        const applied = getAppliedActiveServerSnapshot();
        const available = isAppliedActiveServerRuntimeAvailable();
        let finish!: (value: { ok: true }) => void;
        const completed = vi.fn();
        const setup = buildWidgetCandidateSetup({ candidate: { ...candidate, target: 'app', sessionInputPath: undefined, inputs: { fields: [] } },
            scope: { ...scope, owner: { kind: 'home' } }, audience: 'personal', context: {},
            mode: { kind: 'add', submitLabel: 'Add' }, submit: async () => new Promise(resolve => { finish = resolve; }) });
        publishAppliedActiveServerSnapshot({ serverId: scope.serverId, serverUrl: 'https://setup-home.test', generation: 1 });
        storage.setState({ endpointStatus: 'online', socketStatus: 'connected' });
        const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false} serverId={scope.serverId}
            onDone={completed} testID="pending-home" />);
        const submit = () => screen.findAllByType(RoundButton).find(node => node.props.testID === 'pending-home.submit')!;
        try {
            await act(async () => { submit().props.onPress(); });
            expect(finish).toBeTypeOf('function');
            await act(async () => { storage.setState({ endpointStatus: 'offline' }); });
            expect(screen.getTextContent()).not.toContain('settingsPlugins.targetSelection.unreachableThisHome');
            expect(submit().props.disabled).toBe(true);
            expect(submit().props.loading).toBe(true);
            expect(completed).not.toHaveBeenCalled();
            await act(async () => { finish({ ok: true }); });
            expect(completed).toHaveBeenCalledWith({ ok: true });
        } finally {
            await screen.unmount();
            storage.setState(previous, true);
            publishAppliedActiveServerSnapshot(applied, available);
        }
    });
    it.each([[{}, false], [{ slots: { session: { label: 'This session', value: null } } }, true]] as const)(
        'shows the Usage Session input from actual host slot declarations: %j', async (context, expected) => {
            const sessionField = USAGE_QUERY_INPUT_FIELDS.find(field => field.path === 'session')!;
            const queryCandidate: WidgetCandidate = { ...candidate, target: 'app', sessionInputPath: undefined,
                inputs: { fields: [sessionField] } };
            const setup = buildWidgetCandidateSetup({ candidate: queryCandidate, scope, audience: 'personal', context,
                mode: { kind: 'edit', instance: { v: 1, id: 'query', definition: { kind: 'installed', surface: candidate.surface! },
                    bindings: { session: { kind: 'value', value: ['retained-pin'] } } } }, submit: async () => ({ ok: true }) });
            const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false} serverId={scope.serverId}
                onDone={() => {}} testID="query-scope" />);
            expect(screen.findAllByType(WidgetSetupFieldRow).some(row => row.props.entry.field.path === 'session')).toBe(expected);
            expect(setup.initial.bindings.session).toEqual({ kind: 'value', value: ['retained-pin'] });
        });
    it('says a failed choices read once for the whole form, and its one Retry reads every input again', async () => {
        discovery.fail = true;
        const first: WidgetCandidate = { ...candidate, target: 'app', sessionInputPath: undefined,
            surface: { pluginId: 'acme.options', localId: 'first' },
            inputs: { fields: [{ path: 'period', title: 'Period', widget: 'select', inputType: { pluginId: 'acme.options', localId: 'choice' } },
                { path: 'result', title: 'Owned result', widget: 'select', inputType: { pluginId: 'acme.options', localId: 'choice' } }] } };
        const setup = buildWidgetCandidateSetup({ candidate: first, scope: { ...scope, owner: { kind: 'home' } }, audience: 'personal', context: {},
            mode: { kind: 'add', submitLabel: 'Add' }, submit: async () => ({ ok: true }) });
        const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false} serverId={scope.serverId}
            onDone={() => {}} testID="choices-failed" />);
        const rows = () => screen.findAllByType(WidgetSetupFieldRow);
        const notices = () => screen.findAllByType(SurfaceStateCard).filter(card => card.props.kind === 'error');
        await vi.waitFor(() => expect(rows().map(row => row.props.optionsStatus)).toEqual(['failed', 'failed']));
        expect(notices()).toHaveLength(1);
        discovery.fail = false;
        await act(async () => { await notices()[0]!.props.action.onPress(); });
        await vi.waitFor(() => expect(rows().map(row => row.props.optionsStatus)).toEqual(['ready', 'ready']));
        expect(notices()).toHaveLength(0);
        await screen.unmount();
    });
    it('sends a group field read with its own declaring child identity', async () => {
        const first: WidgetCandidate = { ...candidate, target: 'app', sessionInputPath: undefined,
            surface: { pluginId: 'acme.options', localId: 'first' },
            inputs: { fields: [{ path: 'period', title: 'Period', widget: 'select', inputType: { pluginId: 'acme.options', localId: 'choice' } },
                { path: 'result', title: 'Owned result', widget: 'select', inputType: { pluginId: 'acme.options', localId: 'choice' }, contextMode: 'own' }] } };
        const children = [first, candidate];
        const setup = buildWidgetCandidateSetup({ candidate: buildWidgetGroupInputsCandidate({ title: 'Group', candidates: children })!,
            fieldCandidates: children, scope, audience: 'personal', context: {},
            mode: { kind: 'edit', instance: { v: 1, id: 'group', definition: { kind: 'installed', surface: first.surface! },
                bindings: { session: { kind: 'value', value: { serverId: scope.serverId, sessionId: 'B' } } } } },
            submit: async () => ({ ok: true }) });
        const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false} serverId={scope.serverId}
            onDone={() => {}} testID="group-discovery" />);
        await vi.waitFor(() => expect(discovery.requests.find(request => request.fieldPath === 'result')).toMatchObject({
            consumer: { kind: 'widget', definition: { kind: 'installed', surface: candidate.surface },
                selectedSession: { serverId: scope.serverId, sessionId: 'B' } },
        }));
        expect(discovery.requests.find(request => request.fieldPath === 'period')).toMatchObject({
            consumer: { definition: { kind: 'installed', surface: first.surface } },
        });
        expect(screen.findAllByType(WidgetSetupFieldRow).filter(row => row.props.entry.field.path === 'result')).toHaveLength(1);
        expect(screen.findAllByType(HappierInputField).find(row => row.props.field.path === 'result')!.props.options)
            .toEqual([expect.objectContaining({ value: 'choice', label: 'B:none' })]);
        expect(screen.findByType(InputTypePickerHostProvider).props.fieldTargets.result).toMatchObject({
            machineId: 'machine_1', serverId: scope.serverId, sessionId: 'B',
        });
    });
    it('names the picked value immediately while the new draft options read is held', async () => {
        const setup = buildWidgetCandidateSetup({ candidate, scope, audience: 'personal', context: {},
            mode: { kind: 'edit', instance: { v: 1, id: 'labels', definition: { kind: 'installed', surface: candidate.surface! },
                bindings: { session: { kind: 'value', value: { serverId: scope.serverId, sessionId: 'A' } } } } },
            submit: async () => ({ ok: true }) });
        const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false} serverId={scope.serverId}
            onDone={() => {}} testID="picked-label" />);
        const row = () => screen.findAllByType(WidgetSetupFieldRow).find(row => row.props.entry.field.path === 'result')!;
        await vi.waitFor(() => expect(row().props.options).toEqual([expect.objectContaining({ value: 'choice', label: 'A:none' })]));
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        discovery.wait = () => held;
        try {
            await act(async () => { row().props.onChange({ kind: 'pin', value: 'choice' }); });
            expect(row().props.optionsStatus).toBe('loading');
            expect(row().props.row).toMatchObject({ kind: 'pinned', label: 'A:none' });
            expect(screen.findAllByType(HappierInputField).find(field => field.props.field.path === 'result')!.props.valueLabel).toBe('A:none');
        } finally { release(); await screen.unmount(); }
    });

    it('does not write when a ready size-only setup is cancelled', async () => {
        const submit = vi.fn(async () => ({ ok: true as const }));
        const cancel = vi.fn();
        const setup = buildWidgetCandidateSetup({ candidate: { ...candidate, target: 'app', sessionInputPath: undefined, inputs: { fields: [] } },
            scope: { ...scope, owner: { kind: 'home' } }, audience: 'personal', context: {},
            mode: { kind: 'add', submitLabel: 'Add' }, submit });
        expect(setup.resolve(setup.initial).status).toBe('ready');
        const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false}
            onCancel={cancel} onDone={() => {}} testID="size-only" />);
        await screen.pressByTestIdAsync('size-only.size.large');
        await screen.pressByTestIdAsync('size-only.cancel');
        expect(cancel).toHaveBeenCalledOnce();
        expect(submit).not.toHaveBeenCalled();
    });
    it('names what the footer is doing while the Add is in flight, beside the button spinner', async () => {
        let finish!: (value: { ok: true }) => void;
        const setup = buildWidgetCandidateSetup({ candidate: { ...candidate, target: 'app', sessionInputPath: undefined, inputs: { fields: [] } },
            scope: { ...scope, owner: { kind: 'home' } }, audience: 'personal', context: {},
            mode: { kind: 'add', submitLabel: 'Add' }, submit: async () => new Promise(resolve => { finish = resolve; }) });
        const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false} presentation="pane" onDone={() => {}} testID="adding-pane" />);
        await act(async () => { screen.findByTestId('adding-pane.submit')!.props.onPress(); });
        expect(screen.findAllByType(RoundButton).find(node => node.props.testID === 'adding-pane.submit')!.props.loading).toBe(true);
        expect(screen.findByTestId('adding-pane.why')!.props.children).toBe('widgetAdd.adding');
        await act(async () => { finish({ ok: true }); });
        await screen.unmount();
    });

    it('previews the chosen declared size and submits it together with the input bindings', async () => {
        const sized: WidgetCandidate = { ...candidate, target: 'app', sessionInputPath: undefined,
            inputs: { fields: [{ path: 'filter', title: 'Filter', widget: 'text' as const, required: true }] },
            sizeDeclaration: { sizes: ['large', 'small', 'medium'], defaultSize: 'medium' } };
        const previews: unknown[] = [];
        const submit = vi.fn(async () => ({ ok: true as const }));
        const setup = buildWidgetCandidateSetup({ candidate: sized, scope: { ...scope, owner: { kind: 'home' } },
            audience: 'personal', context: {}, mode: { kind: 'add', submitLabel: 'Add' }, submit,
            renderPreview: ({ draft }) => { previews.push(draft); return null; } });
        const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false}
            onCancel={() => {}} onDone={() => {}} testID="size-setup" />);
        expect(screen.findByTestId('size-setup.size.small')).not.toBeNull();
        await screen.pressByTestIdAsync('size-setup.size.large');
        await act(async () => { screen.changeTextByTestId('size-setup.field.filter.input', 'open'); });
        await screen.pressByTestIdAsync('size-setup.submit');
        expect(previews.at(-1)).toEqual({ size: 'large', bindings: { filter: { kind: 'value', value: 'open' } } });
        expect(submit).toHaveBeenCalledWith({ size: 'large', bindings: { filter: { kind: 'value', value: 'open' } } });
    });

    it('says a required input with nothing to choose once, on its row: the preview and footer do not repeat it', async () => {
        const { selectBuiltinWidgetCandidates } = await import('@/components/widgets/widgetCatalog');
        const check = selectBuiltinWidgetCandidates().find(entry => entry.definition?.kind === 'builtin' && entry.definition.id === 'service_check')!;
        // The Account has no saved Checks: the Check list's own private Automation read answers empty.
        homes.answer(scope.serverId, 'POST /v3/automations/query', { body: { automations: [], nextCursor: null } });
        homes.answer(scope.serverId, 'GET /v3/automations', { body: { automations: [], nextCursor: null } });
        const setup = buildWidgetCandidateSetup({ candidate: check, scope: { ...scope, owner: { kind: 'home' } }, audience: 'personal', context: {},
            mode: { kind: 'add', submitLabel: 'Add' }, submit: async () => ({ ok: true }), renderPreview: () => null });
        const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false} presentation="pane" serverId={scope.serverId}
            onDone={() => {}} testID="no-checks" />);
        const row = () => screen.findAllByType(WidgetSetupFieldRow)[0]!;
        await vi.waitFor(() => expect([row().props.optionsStatus, row().props.options]).toEqual(['ready', []]));
        expect(screen.getTextContent()).toContain('projects.deployments.monitoring.widgetNoChecks');
        expect(screen.findByTestId('no-checks.previewWaiting')).toBeNull();
        expect(screen.getTextContent()).not.toContain('widgetAdd.stillNeeded');
        expect(screen.findByTestId('no-checks.submit')?.props.disabled).toBe(true);
        await screen.unmount();
    });

    it('draws no empty inputs column for a copy that asks for nothing, only its preview and size', async () => {
        const bare: WidgetCandidate = { ...candidate, target: 'app', sessionInputPath: undefined, inputs: { fields: [] },
            sizeDeclaration: { sizes: ['small', 'medium'], defaultSize: 'medium' } };
        const setup = buildWidgetCandidateSetup({ candidate: bare, scope: { ...scope, owner: { kind: 'home' } },
            audience: 'personal', context: {}, mode: { kind: 'add', submitLabel: 'Add' }, submit: async () => ({ ok: true }),
            renderPreview: () => null });
        const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false} onCancel={() => {}} onDone={() => {}} testID="bare-setup" />);
        // A memo component's rendered element type is its `type`, which React.memo's public type does not declare.
        const itemGroupType = (ItemGroup as unknown as Readonly<{ type: unknown }>).type;
        expect(screen.root.findAll(node => node.type === itemGroupType)).toHaveLength(0);
        expect(screen.findByTestId('bare-setup.size.small')).not.toBeNull();
        expect(screen.findByTestId('bare-setup.preview')).not.toBeNull();
    });

    it('accepts a typed JSON literal without discovery through the public field parser and binder', async () => {
        const literal: WidgetCandidate = { ...candidate, target: 'app', sessionInputPath: undefined,
            inputs: { fields: [{ path: 'filter', title: 'Filter', widget: 'json', required: true,
                inputType: { pluginId: 'acme.options', localId: 'filter' } }] },
            inputSchema: { type: 'object', properties: { filter: { type: 'object', properties: { branch: { type: 'string' } },
                required: ['branch'], additionalProperties: false } }, required: ['filter'], additionalProperties: false } };
        const submit = vi.fn(async () => ({ ok: true as const }));
        const setup = buildWidgetCandidateSetup({ candidate: literal, scope, audience: 'personal', context: {},
            mode: { kind: 'add', submitLabel: 'Add' }, submit });
        const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false} serverId={scope.serverId}
            onCancel={() => {}} onDone={() => {}} testID="literal" />);
        expect(screen.findByTestId('literal.submit')!.props.disabled).toBe(true);
        expect(screen.findByTestId('literal.field.filter.input')).not.toBeNull();
        await act(async () => { screen.changeTextByTestId('literal.field.filter.input', '{"branch":"main"}'); });
        await flushHookEffects({ cycles: 2 });
        expect(screen.findByTestId('literal.submit')!.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('literal.submit');
        expect(submit).toHaveBeenCalledWith({ size: 'medium', bindings: { filter: { kind: 'value', value: { branch: 'main' } } } });
        expect(discovery.requests).toHaveLength(0);
    });

    it('discovers against the current pinned Session and refreshes dependent options when the draft changes', async () => {
        const setup = buildWidgetCandidateSetup({ candidate, scope, audience: 'personal', context: {
            session: { ref: { serverId: scope.serverId, sessionId: 'A' }, label: 'A' },
        }, mode: { kind: 'add', submitLabel: 'Add' }, submit: async () => ({ ok: true }) });
        const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false} serverId={scope.serverId} sessionId="A"
            onCancel={() => {}} onDone={() => {}} testID="setup" />);
        await flushHookEffects({ cycles: 4 });
        const change = async (path: string, value: Parameters<React.ComponentProps<typeof WidgetSetupFieldRow>['onChange']>[0]) => {
            await act(async () => { screen.findAllByType(WidgetSetupFieldRow).find(row => row.props.entry.field.path === path)!.props.onChange(value); });
            await flushHookEffects({ cycles: 4 });
        };
        await change('session', { kind: 'pin', value: { serverId: scope.serverId, sessionId: 'B' } });
        await change('filter', { kind: 'pin', value: 'open' });
        const request = discovery.requests.filter(request => request.fieldPath === 'result').at(-1)!;
        expect(request.consumer).toMatchObject({ kind: 'widget', selectedSession: { serverId: scope.serverId, sessionId: 'B' } });
        expect(request.draftInput).toMatchObject({ session: { serverId: scope.serverId, sessionId: 'B' }, filter: 'open' });
        const options = screen.findAllByType(HappierInputField).find(row => row.props.field.path === 'result')!.props.options;
        expect(options[0]?.label).toBe('B:open');
    });

    it('discovers connection-only options for a personal field without making a shared viewer field selectable', async () => {
        const personal = { ...candidate, surface: { pluginId: 'acme.options', localId: 'personal' }, target: 'app' as const, sessionInputPath: undefined, inputs: { fields: [
            { path: 'connection', title: 'Connection', widget: 'select' as const, required: true, connectedAccountOptions: true as const },
        ] }, connectedAccountPurposeBindings: [{ path: 'connection', purpose: 'metrics', consumer: { pluginId: 'acme.options', localId: 'checks' } }] };
        const setup = buildWidgetCandidateSetup({ candidate: personal, scope, audience: 'personal', context: {},
            mode: { kind: 'add', submitLabel: 'Add' }, submit: async () => ({ ok: true }) });
        const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false} serverId={scope.serverId}
            onCancel={() => {}} onDone={() => {}} testID="connection" />);
        await flushHookEffects({ cycles: 4 });
        await vi.waitFor(() => expect(screen.findAllByType(HappierInputField).find(row => row.props.field.path === 'connection')!.props.options)
            .toEqual([expect.objectContaining({ value: { service: { pluginId: 'acme.options', localId: 'cloud' }, accountId: 'mine' } })]));
        expect(buildWidgetCandidateSetup({ candidate: personal, scope: { ...scope, owner: { kind: 'sessionBoard', sessionId: 'A' } },
            audience: 'shared', context: {}, mode: { kind: 'add', submitLabel: 'Add' }, submit: async () => ({ ok: true }) }).fields[0]?.viewer)
            .toEqual({ purpose: 'metrics' });
    });
});

describe('WidgetSetupStep on a phone', () => {
    it('keeps a visible dismiss in Edit inputs: the header caret closes the sheet when there is no step to go back to', async () => {
        const close = vi.fn();
        const setup = buildWidgetCandidateSetup({ candidate, scope, audience: 'personal', context: {
            session: { ref: { serverId: scope.serverId, sessionId: 'A' }, label: 'A' },
        }, mode: { kind: 'edit', instance: { v: 1, id: 'copy', definition: { kind: 'installed', surface: candidate.surface! }, bindings: {} } },
        submit: async () => ({ ok: true }) });
        const screen = await renderScreen(<WidgetSetupStep setup={setup} phone serverId={scope.serverId}
            onCancel={() => {}} onClose={close} onDone={() => {}} testID="edit" />);
        await flushHookEffects({ cycles: 2 });
        expect(screen.findByTestId('edit.back')).toBeNull();
        await screen.pressByTestIdAsync('edit.close');
        expect(close).toHaveBeenCalledTimes(1);
    });
});
