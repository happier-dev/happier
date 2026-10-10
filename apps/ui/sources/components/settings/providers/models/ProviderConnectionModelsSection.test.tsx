import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1 } from '@happier-dev/protocol';
import {
    RPC_METHODS,
    type DaemonProviderModelRowV1,
    type DaemonProviderModelSettingsMutationResponseV1,
} from '@happier-dev/protocol/rpc';

import {
    createProviderConnectionViewFixture,
    createProviderConnectionsDescribeFixture,
    createProviderModelsFixture,
    createMachineAdministrationTargetSelectionMock,
    createProviderSettingsHarness,
    createDeferred,
    flushHookEffects,
    installMachineAdministrationTargetSelectionBoundary,
    installProviderSettingsRpcBoundary,
    renderScreen,
    standardCleanup,
    withPopoverWebGlobals,
} from '@/dev/testkit';
import type { ProviderModelLoadUiResult } from '@/providers/hooks/useProviderModelLoadAction';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
    providerDecisionState: 'enabled' as 'enabled' | 'loading',
    manualModelPolicy: 'allowed' as 'allowed' | 'catalog-only',
    connectionRevision: 7,
    loading: false,
    error: null as null | ReturnType<typeof createProviderErrorV1>,
    models: [{ id: 'manual-a', name: 'Manual A', source: 'manual', stale: false, loadState: 'unknown', visibility: 'visible' }] as DaemonProviderModelRowV1[],
}));
const refresh = vi.hoisted(() => vi.fn(async () => undefined));
const providerDecisionListeners = vi.hoisted(() => new Set<() => void>());
const mutate = vi.hoisted(() => vi.fn<(input: unknown) => Promise<DaemonProviderModelSettingsMutationResponseV1>>(
    async (_input) => ({ status: 'success', action: 'manualRemove' }),
));
const confirm = vi.hoisted(() => vi.fn(async () => true));
const alert = vi.hoisted(() => vi.fn());
const loadModel = vi.hoisted(() => vi.fn<(_connectionId: string, _modelId: string) => Promise<ProviderModelLoadUiResult>>(
    async (_connectionId, _modelId) => ({ status: 'loaded', source: 'requested' }),
));
const probeProviderConnection = vi.hoisted(() => vi.fn<(_input: unknown) => Promise<Readonly<{
    status: 'success';
    models: readonly DaemonProviderModelRowV1[];
    requestFingerprint: string;
}>>>(async (_input) => ({ status: 'success', models: [], requestFingerprint: 'probe-request:v1:test' })));
const routerPush = vi.hoisted(() => vi.fn());
const routerBack = vi.hoisted(() => vi.fn());
const navigationDispatch = vi.hoisted(() => vi.fn());
const navigationPreventRemove = vi.hoisted(() => ({
    enabled: false,
    callback: null as null | ((event: { data: { action: unknown } }) => void),
}));
// Controllable incumbent Account lifetime; null matches the real module under
// this harness (no registered profile scope) for existing tests.
const accountLifetimeController = vi.hoisted(() => {
    type ControllerLifetime = NonNullable<{
        scope: { serverId: string; accountId: string };
        isCurrent: () => boolean;
        onRetire: (cancel: () => void) => Readonly<{ dispose(): void }>;
    }>;
    const controller: {
        lifetime: ControllerLifetime | null;
        install(accountId: string): Readonly<{ retire(): void }>;
    } = {
        lifetime: null,
        install(accountId) {
            let retired = false;
            const retireCallbacks = new Set<() => void>();
            controller.lifetime = {
                scope: { serverId: 'server-a', accountId },
                isCurrent: () => !retired,
                onRetire: (cancel) => {
                    if (retired) {
                        cancel();
                        return Object.freeze({ dispose() {} });
                    }
                    retireCallbacks.add(cancel);
                    return Object.freeze({ dispose() { retireCallbacks.delete(cancel); } });
                },
            };
            return Object.freeze({
                retire() {
                    if (retired) return;
                    retired = true;
                    for (const cancel of [...retireCallbacks]) cancel();
                    retireCallbacks.clear();
                },
            });
        },
    };
    return controller;
});
vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    captureActiveServerAccountScopeLifetime: () => accountLifetimeController.lifetime,
}));
let modelsRequestCount = 0;
const providerHarness = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(providerHarness);
const administrationTarget = createMachineAdministrationTargetSelectionMock();
installMachineAdministrationTargetSelectionBoundary(administrationTarget);

installSettingsViewCommonModuleMocks({
    router: async () => ({
        useRouter: () => ({ push: routerPush, back: routerBack }),
        useNavigation: () => ({ dispatch: navigationDispatch }),
    }),
    storage: async () => ({
        // The page header reads the viewer's content-width preference.
        useLocalSetting: () => undefined,
        useAllMachines: () => [{
            id: 'machine-a', active: true, revokedAt: null,
            metadata: { displayName: 'Mac' }, metadataVersion: 1, daemonState: null, daemonStateVersion: 1,
            seq: 1, createdAt: 1, updatedAt: 1, activeAt: 1,
        }],
        useMachineListByServerId: () => ({ 'server-a': [{ id: 'machine-a', active: true, revokedAt: null }] }),
    }),
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ confirmResult: true, spies: { confirm, alert } }).module;
    },
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => true }));
vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => {
        const [, rerender] = React.useReducer((value: number) => value + 1, 0);
        React.useEffect(() => {
            const listener = () => rerender();
            providerDecisionListeners.add(listener);
            return () => {
                providerDecisionListeners.delete(listener);
            };
        }, []);
        return state.providerDecisionState === 'loading'
            ? null
            : { state: 'enabled', blockedBy: null, blockerCode: 'none' };
    },
}));
vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({ useActiveServerSnapshot: () => ({ serverId: 'server-a' }) }));
vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock({
        usePreventRemove: (enabled, callback) => {
            navigationPreventRemove.enabled = enabled;
            navigationPreventRemove.callback = callback;
        },
    });
});
vi.mock('@/components/ui/forms/InlineAddExpander', () => ({
    InlineAddExpander: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('InlineAddExpander', props, props.children),
}));
vi.mock('@/components/ui/forms/FieldTextInput', () => ({
    FieldTextInput: (props: Record<string, unknown>) => React.createElement('FieldTextInput', props),
}));
vi.mock('@/components/ui/lists/Item', () => ({ Item: (props: Record<string, unknown>) => React.createElement('Item', props) }));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('ItemGroup', props, props.children),
}));
vi.mock('@/components/ui/icons/SafeIonicons', () => ({ SafeIonicons: () => null }));
// The Models section is part of the connection page's one virtualized list; the recycler renders
// every segment here.
const legendList = vi.hoisted(() => ({ props: null as null | { data?: ReadonlyArray<{ key: string }> } }));
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    const mock = createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>() });
    Object.defineProperty(legendList, 'props', { get: () => mock.state.props });
    return mock.module;
});

// Install transport and platform boundaries before loading the real view graph.
const { ProviderModelManager } = await import('@/providers/models/ProviderModelManager');
const { providerModelRowKey } = await import('@/providers/models/modelRowKey');
const { ProviderConnectionModelsPage } = await import('./ProviderConnectionModelsSection');
const { useProviderConnectionModelsSection } = await import('./useProviderConnectionModelsSection');
const { useProviderConnections } = await import('@/providers/hooks/useProviderConnections');
const { useProviderSettingsTarget } = await import('@/providers/hooks/targetMachine');
const { useProviderFeatureAvailability } = await import('../ProviderFeatureAvailability');

/**
 * The connection page's Models section as the detail hosts it: the section hook over the live
 * connection read, rendered as the page's list. The rest of the page is covered by the detail's
 * own suite, including the unsaved-changes guard that joins this section's draft.
 */
function ModelsSectionHost(props: Readonly<{ connectionId: string; startAdding?: boolean }>) {
    const { enabled } = useProviderFeatureAvailability();
    const { machineId, resolveCurrentTarget, serverId } = useProviderSettingsTarget();
    const query = useProviderConnections({ enabled, active: true, machineId, serverId, connectionId: props.connectionId });
    const connection = query.data?.connections.find((item) => item.connectionId === props.connectionId) ?? null;
    const models = useProviderConnectionModelsSection({
        connectionId: props.connectionId, connection, enabled, machineId, serverId, resolveCurrentTarget,
        startAdding: props.startAdding,
    });
    return (
        <ProviderConnectionModelsPage
            connectionId={props.connectionId}
            models={models}
            header={<></>}
            footer={<></>}
            revealOnMount={false}
            onRequestClose={() => routerBack()}
        />
    );
}

type RenderedScreen = Awaited<ReturnType<typeof renderScreen>>;
function sectionState(screen: RenderedScreen) {
    return screen.findByType(ProviderConnectionModelsPage).props.models;
}
function renderedModelRowCount(screen: RenderedScreen): number {
    return screen.findAllByType('Item')
        .filter((item) => String(item.props.testID ?? '').startsWith('provider-model-manager.row:')).length;
}
function modelSegments(): ReadonlyArray<{ key: string }> {
    return (legendList.props?.data ?? []).filter((row) => row.key.startsWith('models:rows:'));
}

/** Error pages now use the real shared state card, not a pair of Item rows. */
function presentedTitles(screen: Awaited<ReturnType<typeof renderScreen>>) {
    const errors = screen.findAll(node => typeof node.props.testID === 'string'
        && node.props.testID.startsWith('provider-error:') && typeof node.props.title === 'string');
    return [...screen.findAllByType('Item').map(item => item.props.title),
        ...errors.flatMap(node => [node.props.title, node.props.action?.label].filter(Boolean))];
}

function findProviderRecoveryAction(screen: Awaited<ReturnType<typeof renderScreen>>, label: string) {
    return screen.findAll(node => node.props.accessibilityRole === 'button'
        && node.props.accessibilityLabel === label && typeof node.props.onPress === 'function')[0];
}

describe('ProviderConnectionModelsSection', () => {
    afterEach(standardCleanup);
    beforeEach(() => {
        providerHarness.reset();
        administrationTarget.controller.reset();
        navigationDispatch.mockClear();
        navigationPreventRemove.enabled = false;
        navigationPreventRemove.callback = null;
        accountLifetimeController.lifetime = null;
        mutate.mockReset();
        mutate.mockImplementation(async () => ({ status: 'success', action: 'manualRemove' }));
        state.providerDecisionState = 'enabled';
        modelsRequestCount = 0;
        state.manualModelPolicy = 'allowed';
        state.connectionRevision = 7;
        state.loading = false;
        state.error = null;
        state.models = [{ id: 'manual-a', name: 'Manual A', source: 'manual', stale: false, loadState: 'unknown', visibility: 'visible' }];
        refresh.mockClear();
        confirm.mockClear();
        alert.mockClear();
        loadModel.mockClear();
        probeProviderConnection.mockClear();
        routerPush.mockClear();
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, async () => (
            createProviderConnectionsDescribeFixture({
                connections: [createProviderConnectionViewFixture({
                    contributionKey: 'plugin/acme',
                    displayName: 'Acme',
                    providerName: 'Acme',
                })],
            })
        ));
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODELS, async () => {
            modelsRequestCount += 1;
            if (modelsRequestCount > 1) await refresh();
            if (state.loading && state.models.length === 0) return await new Promise<never>(() => undefined);
            if (state.error) return { status: 'error', error: state.error };
            return createProviderModelsFixture({
                connectionId: 'pc_a',
                connectionRevision: state.connectionRevision,
                models: state.models,
                manualModelPolicy: state.manualModelPolicy,
                modelLoadAction: 'available',
            });
        });
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODEL_SETTINGS_MUTATE, async (request) => (
            await mutate({ serverId: 'server-a', request: request.payload })
        ));
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_PROBE, async (request) => (
            await probeProviderConnection({
                ...(request.payload as { machineId: string; connectionId: string }),
                serverId: 'server-a',
            })
        ));
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODEL_LOAD, async (request) => {
            const payload = request.payload as { connectionId: string; modelId: string };
            return await loadModel(payload.connectionId, payload.modelId);
        });
    });

    it('loads the catalog once Provider availability finishes loading', async () => {
        state.providerDecisionState = 'loading';
        const element = <ModelsSectionHost connectionId="pc_a" />;
        await renderScreen(element);

        // The page shows the availability check (the detail's suite covers that notice); the
        // section reads nothing until Providers are available.
        expect(providerHarness.state.requests).toEqual([]);

        state.providerDecisionState = 'enabled';
        await act(async () => {
            providerDecisionListeners.forEach((listener) => listener());
            await Promise.resolve();
        });
        await flushHookEffects();
        expect(providerHarness.state.requests.map((request) => request.method)).toContain(
            RPC_METHODS.DAEMON_PROVIDERS_MODELS,
        );
    });

    it('renders catalog rows supplied through the shared Provider RPC boundary and real manager', async () => {
        state.models = [{
                    id: 'boundary-model',
                    name: 'Boundary model',
                    source: 'static',
                    stale: false,
                    loadState: 'loaded',
                    visibility: 'visible',
                }];
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);

        expect(screen.findByType(ProviderModelManager).props.groups[0].rows[0].descriptor.name)
            .toBe('Boundary model');
    });

    it('keeps the model rows of a large catalog mounted as they are while an unrelated draft changes', async () => {
        await withPopoverWebGlobals(async () => {
            state.models = Array.from({ length: 500 }, (_, index): DaemonProviderModelRowV1 => ({
                id: `model-${index}`,
                name: `Model ${index}`,
                source: 'probe',
                stale: false,
                loadState: 'unknown',
                visibility: 'visible',
            }));
            const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
            const segmentsBefore = modelSegments();
            // Every model is listed, in segments the page's recycler mounts near the viewport.
            expect(renderedModelRowCount(screen)).toBe(500);
            expect(segmentsBefore.length).toBeGreaterThan(1);

            await act(async () => {
                screen.findByType('FieldTextInput').props.onChangeText?.('draft-model');
            });

            const segmentsAfter = modelSegments();
            expect(segmentsAfter).toHaveLength(segmentsBefore.length);
            segmentsAfter.forEach((segment, index) => expect(segment).toBe(segmentsBefore[index]));
        });
    });

    it('lists hidden models only once asked to show them', async () => {
        state.models = [{
            id: 'hidden-model',
            name: 'Hidden model',
            source: 'probe',
            stale: false,
            loadState: 'unknown',
            visibility: 'hidden_all_agents',
        }];
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        const hiddenRow = `provider-model-manager.row:${providerModelRowKey('pc_a', 'hidden-model')}`;
        expect(screen.findByTestId(hiddenRow)).toBeNull();

        await act(async () => {
            screen.findAllByType('Pressable')
                .find((item) => item.props.accessibilityLabel === 'settingsProviders.models.showHidden')
                ?.props.onPress?.();
        });

        expect(screen.findByTestId(hiddenRow)).not.toBeNull();
    });

    it('filters the listed models by name', async () => {
        state.models = [
            { id: 'alpha', name: 'Alpha', source: 'static', stale: false, loadState: 'unknown', visibility: 'visible' },
            { id: 'beta', name: 'Beta', source: 'static', stale: false, loadState: 'unknown', visibility: 'visible' },
        ];
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        expect(renderedModelRowCount(screen)).toBe(2);

        await act(async () => {
            screen.findAllByProps({ testID: 'provider-model-manager.filter' })
                .find((node) => typeof node.props.onChangeText === 'function')
                ?.props.onChangeText('bet');
        });

        expect(renderedModelRowCount(screen)).toBe(1);
        expect(screen.findByTestId(`provider-model-manager.row:${providerModelRowKey('pc_a', 'beta')}`)).not.toBeNull();
    });

    it('explains catalog-managed providers without offering manual model entry', async () => {
        state.manualModelPolicy = 'catalog-only';
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);

        expect(screen.findAllByType('InlineAddExpander')).toHaveLength(0);
        expect(presentedTitles(screen))
            .toContain('settingsProviders.models.providerManagedTitle');
    });

    it('does not claim an empty catalog while the initial catalog is loading or failed', async () => {
        state.loading = true;
        state.models = [];
        const loading = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        expect(renderedModelRowCount(loading)).toBe(0);
        expect(loading.findByTestId('provider-model-manager.empty')).toBeNull();
        expect(loading.findAllByType('Item').some((item) => item.props.loading === true)).toBe(true);

        state.loading = false;
        state.error = createProviderErrorV1('provider_endpoint_unreachable');
        const failed = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        expect(renderedModelRowCount(failed)).toBe(0);
        expect(failed.findByTestId('provider-model-manager.empty')).toBeNull();
        expect(presentedTitles(failed))
            .toContain('settingsProviders.errors.unreachableTitle');
    });

    it('removes only through the manager callback using the current connection revision', async () => {
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);

        await act(async () => {
            await screen.findByType(ProviderModelManager).props.onRemoveManualModel?.('pc_a', 'manual-a');
        });

        expect(confirm).toHaveBeenCalledOnce();
        expect(mutate).toHaveBeenCalledWith({
            serverId: 'server-a',
            request: {
                action: 'manualRemove', machineId: 'machine-a', connectionId: 'pc_a',
                modelId: 'manual-a', expectedConnectionRevision: 7,
            },
        });
        expect(refresh).toHaveBeenCalledOnce();
    });

    it('adapts connection catalog provenance into the manager multi-source contract', async () => {
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        const row = screen.findByType(ProviderModelManager).props.groups[0].rows[0];

        expect(row.sources).toEqual({ manual: true, static: false, probe: false });
        expect(row).not.toHaveProperty('source');
    });

    it('adds every pasted manual model in one atomic mutation', async () => {
        mutate.mockResolvedValueOnce({ status: 'success', action: 'manualAdd' });
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);

        await act(async () => {
            screen.findByType('FieldTextInput').props.onChangeText?.('model-a\nmodel-b\nmodel-c');
        });
        await act(async () => {
            await screen.findByType('InlineAddExpander').props.onSave?.();
        });

        expect(mutate).toHaveBeenCalledTimes(1);
        expect(mutate).toHaveBeenCalledWith({
            serverId: 'server-a',
            request: {
                action: 'manualAdd', machineId: 'machine-a', connectionId: 'pc_a',
                expectedConnectionRevision: 7,
                models: [{ id: 'model-a' }, { id: 'model-b' }, { id: 'model-c' }],
            },
        });
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('persists valid pasted models once while retaining only rejected lines inline', async () => {
        mutate.mockResolvedValueOnce({ status: 'success', action: 'manualAdd' });
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);

        await act(async () => {
            screen.findByType('FieldTextInput').props.onChangeText?.('valid-model\nbad model\nvalid-model');
        });
        await act(async () => {
            await screen.findByType('InlineAddExpander').props.onSave?.();
        });

        expect(mutate).toHaveBeenCalledOnce();
        expect(mutate).toHaveBeenCalledWith({
            serverId: 'server-a',
            request: {
                action: 'manualAdd', machineId: 'machine-a', connectionId: 'pc_a',
                expectedConnectionRevision: 7,
                models: [{ id: 'valid-model' }],
            },
        });
        expect(screen.findByType('InlineAddExpander').props.isOpen).toBe(true);
        expect(screen.findByType('FieldTextInput').props.value).toBe('bad model');
        expect(screen.findByType('FieldTextInput').props.error).toBeTruthy();
        expect(refresh).toHaveBeenCalledOnce();
    });

    it('renders typed operation recovery inline with the exact actionable retry', async () => {
        mutate.mockResolvedValueOnce({
            status: 'error',
            error: createProviderErrorV1('provider_endpoint_unavailable', { connectionId: 'pc_a' }),
        });
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);

        await act(async () => { await screen.findByType(ProviderModelManager).props.onResetVisibility?.(); });

        expect(alert).not.toHaveBeenCalled();
        expect(presentedTitles(screen)).toContain('settingsProviders.errors.actions.retry');
    });

    it('shows initial transport failure and preserves stale rows when a later refresh fails', async () => {
        state.models = [];
        state.error = createProviderErrorV1('provider_endpoint_unavailable', {
            connectionId: 'pc_a',
            machineId: 'machine-a',
        });
        const initialFailure = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);

        expect(renderedModelRowCount(initialFailure)).toBe(0);
        expect(presentedTitles(initialFailure))
            .toContain('settingsProviders.errors.unreachableTitle');
        expect(presentedTitles(initialFailure))
            .toContain('settingsProviders.errors.actions.retry');

        await act(async () => { initialFailure.tree.unmount(); });
        state.models = [{ id: 'stale-a', name: 'Stale A', source: 'manual', stale: true, loadState: 'unknown', visibility: 'visible' }];
        state.error = null;
        const staleFailure = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        state.error = createProviderErrorV1('provider_endpoint_unavailable', {
            connectionId: 'pc_a', machineId: 'machine-a',
        });
        const refreshButton = staleFailure.findAllByType('Pressable')
            .find((item) => item.props.accessibilityLabel === 'common.refresh');
        await act(async () => { await refreshButton?.props.onPress?.(); });
        expect(renderedModelRowCount(staleFailure)).toBe(1);
        expect(staleFailure.findByType(ProviderModelManager).props.groups[0].rows).toHaveLength(1);
        expect(presentedTitles(staleFailure))
            .toContain('settingsProviders.errors.unreachableTitle');
    });

    it('turns an ambiguous reset transport failure into current-state review without replay', async () => {
        mutate.mockRejectedValueOnce(new Error('transport failed'));
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);

        await act(async () => { await screen.findByType(ProviderModelManager).props.onResetVisibility?.(); });

        expect(alert).not.toHaveBeenCalled();
        expect(modelsRequestCount).toBe(2);
        expect(refresh).toHaveBeenCalledOnce();
        expect(sectionState(screen).errorRetry).toBeUndefined();
        expect(sectionState(screen).errorReviewCurrentState).toEqual(expect.any(Function));
        const titles = presentedTitles(screen);
        expect(titles).toContain('settingsProviders.errors.mutationOutcomeUnknownTitle');
        expect(titles).toContain('settingsProviders.errors.actions.reviewCurrentState');
        await act(async () => {
            await findProviderRecoveryAction(screen, 'settingsProviders.errors.actions.reviewCurrentState')
                ?.props.onPress?.();
        });
        expect(mutate).toHaveBeenCalledOnce();
        expect(modelsRequestCount).toBe(3);
        expect(refresh).toHaveBeenCalledTimes(2);
        expect(routerPush).not.toHaveBeenCalled();
    });

    it('contains a bulk visibility transport failure in the same inline recovery owner', async () => {
        mutate.mockRejectedValueOnce(new Error('transport failed'));
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);

        await act(async () => { await screen.findByType(ProviderModelManager).props.onShowAll?.(); });

        expect(alert).not.toHaveBeenCalled();
        expect(modelsRequestCount).toBe(2);
        expect(refresh).toHaveBeenCalledOnce();
        expect(sectionState(screen).errorRetry).toBeUndefined();
        expect(presentedTitles(screen))
            .toContain('settingsProviders.errors.actions.reviewCurrentState');
        await act(async () => {
            await findProviderRecoveryAction(screen, 'settingsProviders.errors.actions.reviewCurrentState')
                ?.props.onPress?.();
        });
        expect(mutate).toHaveBeenCalledOnce();
        expect(modelsRequestCount).toBe(3);
        expect(refresh).toHaveBeenCalledTimes(2);
        expect(routerPush).not.toHaveBeenCalled();
    });

    it('settles overlapping visibility writes in the order the user issued them', async () => {
        // Two rapid toggles for the same model must not race: dispatching them
        // concurrently lets the daemon apply them in the opposite order and
        // leave the catalog showing the opposite of the user's last intent.
        const firstWrite = createDeferred<DaemonProviderModelSettingsMutationResponseV1>();
        const dispatched: boolean[] = [];
        mutate.mockImplementation(async (input) => {
            const request = (input as { request: { hidden?: boolean } }).request;
            dispatched.push(request.hidden === true);
            if (dispatched.length === 1) return await firstWrite.promise;
            return { status: 'success', action: 'setVisibility' };
        });
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        const ref = { scope: 'allAgents' as const, providerConnectionId: 'pc_a', modelId: 'manual-a' };
        const setVisibility = screen.findByType(ProviderModelManager).props.onSetVisibility;

        let both!: Promise<unknown>;
        await act(async () => {
            both = Promise.all([setVisibility?.(ref, true), setVisibility?.(ref, false)]);
            await Promise.resolve();
        });
        expect(dispatched).toEqual([true]);

        await act(async () => {
            firstWrite.resolve({ status: 'success', action: 'setVisibility' });
            await both;
            await flushHookEffects();
        });

        expect(dispatched).toEqual([true, false]);
    });

    it('refuses a queued visibility write once the selection moved to another machine', async () => {
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        const setVisibility = screen.findByType(ProviderModelManager).props.onSetVisibility;

        await act(async () => {
            administrationTarget.controller.select(null);
            await Promise.resolve();
        });
        await act(async () => {
            await setVisibility?.(
                { scope: 'allAgents', providerConnectionId: 'pc_a', modelId: 'manual-a' },
                true,
            );
            await flushHookEffects();
        });

        expect(mutate).not.toHaveBeenCalled();
    });

    it('retires an Account A queued write even when Account B restores the same machine identity', async () => {
        const accountA = accountLifetimeController.install('account-a');
        const firstWrite = createDeferred<DaemonProviderModelSettingsMutationResponseV1>();
        mutate.mockImplementationOnce(async () => await firstWrite.promise);
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        const setVisibility = screen.findByType(ProviderModelManager).props.onSetVisibility;
        const ref = { scope: 'allAgents' as const, providerConnectionId: 'pc_a', modelId: 'manual-a' };

        let both!: Promise<unknown>;
        await act(async () => {
            both = Promise.all([
                setVisibility?.(ref, true),
                setVisibility?.(ref, false),
            ]);
            await Promise.resolve();
        });
        expect(mutate).toHaveBeenCalledOnce();

        await act(async () => {
            accountA.retire();
            accountLifetimeController.install('account-b');
            await screen.update(
                <ModelsSectionHost connectionId="pc_a" startAdding />,
            );
            await flushHookEffects();
        });

        await act(async () => {
            firstWrite.resolve({ status: 'success', action: 'setVisibility' });
            await both;
            await flushHookEffects();
        });

        expect(mutate).toHaveBeenCalledOnce();
    });
    it('reports a typed manual-model draft as unsaved work to its hosting page', async () => {
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        expect(sectionState(screen).manualDraft.dirtyRef.current).toBe(false);

        await act(async () => {
            screen.findByType('FieldTextInput').props.onChangeText?.('draft-model');
            await flushHookEffects({ cycles: 1, turns: 2 });
        });

        expect(sectionState(screen).manualDraft.dirtyRef.current).toBe(true);
        await act(async () => { sectionState(screen).manualDraft.discard(); });
        expect(sectionState(screen).manualModelText).toBe('');
        expect(sectionState(screen).manualDraft.dirtyRef.current).toBe(false);
        expect(mutate).not.toHaveBeenCalled();
    });

    it('retires the Account A manual-model buffer and its editor error when the Account lifetime retires', async () => {
        const accountA = accountLifetimeController.install('account-a');
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        expect(sectionState(screen).manualDraft.dirtyRef.current).toBe(false);

        await act(async () => {
            screen.findByType('FieldTextInput').props.onChangeText?.('bad model');
            await flushHookEffects({ cycles: 1, turns: 2 });
        });
        await act(async () => {
            await screen.findByType('InlineAddExpander').props.onSave?.();
            await flushHookEffects({ cycles: 1, turns: 2 });
        });
        // Account A authored both an unsaved buffer and inline validation state.
        expect(screen.findByType('FieldTextInput').props.value).toBe('bad model');
        expect(screen.findByType('FieldTextInput').props.error).toBeTruthy();
        expect(sectionState(screen).manualDraft.dirtyRef.current).toBe(true);

        await act(async () => { accountA.retire(); });

        // The retired Account leaves no buffer or validation state behind.
        // (The catalog hook also clears Account A's rows through the same
        // lifetime, so the editor may unmount with the cleared policy —
        // the screen's own contract is what must be clean.)
        const modelsView = { props: sectionState(screen) };
        expect(modelsView.props.manualModelText).toBe('');
        expect(modelsView.props.editorError).toBeNull();
        // The page's guard stays truthful: retirement left no unsaved Account A work.
        expect(modelsView.props.manualDraft.dirtyRef.current).toBe(false);
    });

    it('keeps the typed manual-model buffer while the same Account lifetime stays current', async () => {
        accountLifetimeController.install('account-a');
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);

        await act(async () => {
            screen.findByType('FieldTextInput').props.onChangeText?.('same-account-model');
            await flushHookEffects({ cycles: 1, turns: 2 });
        });

        expect(screen.findByType('FieldTextInput').props.value).toBe('same-account-model');
        expect(sectionState(screen).manualDraft.dirtyRef.current).toBe(true);
    });

    it('contains a single-model visibility transport failure in the same inline recovery owner', async () => {
        mutate.mockRejectedValueOnce(new Error('transport failed'));
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);

        await act(async () => {
            await screen.findByType(ProviderModelManager).props.onSetVisibility?.(
                { scope: 'allAgents', providerConnectionId: 'pc_a', modelId: 'manual-a' },
                true,
            );
        });

        expect(alert).not.toHaveBeenCalled();
        expect(modelsRequestCount).toBe(2);
        expect(refresh).toHaveBeenCalledOnce();
        expect(sectionState(screen).errorRetry).toBeUndefined();
        expect(presentedTitles(screen))
            .toContain('settingsProviders.errors.actions.reviewCurrentState');
        await act(async () => {
            await findProviderRecoveryAction(screen, 'settingsProviders.errors.actions.reviewCurrentState')
                ?.props.onPress?.();
        });
        expect(mutate).toHaveBeenCalledOnce();
        expect(modelsRequestCount).toBe(3);
        expect(refresh).toHaveBeenCalledTimes(2);
        expect(routerPush).not.toHaveBeenCalled();
    });

    it('contains a manual-add transport failure in the same inline recovery owner', async () => {
        mutate.mockRejectedValueOnce(new Error('transport failed'));
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);

        await act(async () => {
            screen.findByType('FieldTextInput').props.onChangeText?.('new-model');
        });
        await act(async () => { await screen.findByType('InlineAddExpander').props.onSave?.(); });

        expect(alert).not.toHaveBeenCalled();
        expect(modelsRequestCount).toBe(2);
        expect(refresh).toHaveBeenCalledOnce();
        expect(sectionState(screen).errorRetry).toBeUndefined();
        expect(presentedTitles(screen))
            .toContain('settingsProviders.errors.actions.reviewCurrentState');
        await act(async () => {
            await findProviderRecoveryAction(screen, 'settingsProviders.errors.actions.reviewCurrentState')
                ?.props.onPress?.();
        });
        expect(mutate).toHaveBeenCalledOnce();
        expect(modelsRequestCount).toBe(3);
        expect(refresh).toHaveBeenCalledTimes(2);
        expect(routerPush).not.toHaveBeenCalled();
    });

    it('contains a manual-remove transport failure in the same inline recovery owner', async () => {
        mutate.mockRejectedValueOnce(new Error('transport failed'));
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);

        await act(async () => {
            await screen.findByType(ProviderModelManager).props.onRemoveManualModel?.('pc_a', 'manual-a');
        });

        expect(alert).not.toHaveBeenCalled();
        expect(modelsRequestCount).toBe(2);
        expect(refresh).toHaveBeenCalledOnce();
        expect(sectionState(screen).errorRetry).toBeUndefined();
        expect(presentedTitles(screen))
            .toContain('settingsProviders.errors.actions.reviewCurrentState');
        await act(async () => {
            await findProviderRecoveryAction(screen, 'settingsProviders.errors.actions.reviewCurrentState')
                ?.props.onPress?.();
        });
        expect(mutate).toHaveBeenCalledOnce();
        expect(modelsRequestCount).toBe(3);
        expect(refresh).toHaveBeenCalledTimes(2);
        expect(routerPush).not.toHaveBeenCalled();
    });

    it('contains an explicit catalog-refresh transport failure in the same inline recovery owner', async () => {
        probeProviderConnection.mockRejectedValueOnce(new Error('transport failed'));
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        const refreshButton = screen.findAllByType('Pressable')
            .find((item) => item.props.accessibilityLabel === 'common.refresh');

        await act(async () => { await refreshButton?.props.onPress?.(); });

        expect(alert).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(screen.findByTestId('provider-error:agent_error')).not.toBeNull());
        const recovery = screen.findByTestId('provider-error-action:agent_error');
        expect(recovery).not.toBeNull();
        await act(async () => { await recovery?.props.onPress?.(); });
        expect(routerPush).toHaveBeenCalledWith('/(app)/settings/providers/pc_a');
        expect(probeProviderConnection).toHaveBeenCalledOnce();
    });

    it('contains a typed model-load transport failure in the same inline recovery owner', async () => {
        loadModel.mockResolvedValueOnce({
            status: 'error',
            error: createProviderErrorV1('provider_endpoint_unavailable', {
                connectionId: 'pc_a', machineId: 'machine-a',
            }),
        });
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);

        await act(async () => {
            await screen.findByType(ProviderModelManager).props.onLoadModel?.('pc_a', 'manual-a');
        });

        expect(alert).not.toHaveBeenCalled();
        expect(presentedTitles(screen))
            .toContain('settingsProviders.errors.actions.retry');
    });

    it('reviews an ambiguous model load on the current catalog without retaining load replay', async () => {
        loadModel.mockRejectedValueOnce(new Error('load acknowledgement lost while daemon work continues'));
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);

        await act(async () => {
            screen.findByType(ProviderModelManager).props.onLoadModel?.('pc_a', 'manual-a');
            await vi.waitFor(() => expect(modelsRequestCount).toBe(2));
        });
        await act(async () => {
            await vi.waitFor(() => expect(
                screen.findByTestId('provider-error:provider_rpc_mutation_outcome_unknown'),
            ).not.toBeNull());
        });

        const view = { props: sectionState(screen) };
        expect(view.props.errorRetry).toBeUndefined();
        expect(view.props.errorLoadModel).toBeUndefined();
        expect(view.props.errorReviewCurrentState).toEqual(expect.any(Function));
        expect(loadModel).toHaveBeenCalledOnce();
        const reviewAction = screen.findByTestId('provider-error-action:provider_rpc_mutation_outcome_unknown');
        expect(reviewAction).not.toBeNull();

        await act(async () => {
            await reviewAction?.props.onPress?.();
            await vi.waitFor(() => expect(modelsRequestCount).toBe(3));
        });
        expect(loadModel).toHaveBeenCalledOnce();
        expect(routerPush).not.toHaveBeenCalled();
    });

    it('retries only catalog refresh after an acknowledged settings mutation', async () => {
        mutate.mockResolvedValueOnce({ status: 'success', action: 'resetVisibility' });
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        state.error = createProviderErrorV1('provider_endpoint_unavailable', {
            connectionId: 'pc_a', machineId: 'machine-a',
        });

        await act(async () => {
            screen.findByType(ProviderModelManager).props.onResetVisibility?.();
            await vi.waitFor(() => expect(modelsRequestCount).toBe(2));
        });
        await act(async () => {
            await vi.waitFor(() => expect(
                screen.findByTestId('provider-error-action:provider_endpoint_unavailable'),
            ).not.toBeNull());
        });
        const view = { props: sectionState(screen) };
        expect(view.props.errorRetry).toEqual(expect.any(Function));
        expect(view.props.errorLoadModel).toBeUndefined();
        expect(view.props.errorReviewCurrentState).toBeUndefined();
        expect(mutate).toHaveBeenCalledOnce();
        const retryRefreshAction = screen.findByTestId('provider-error-action:provider_endpoint_unavailable');
        expect(retryRefreshAction).not.toBeNull();

        await act(async () => {
            await retryRefreshAction?.props.onPress?.();
            await vi.waitFor(() => expect(modelsRequestCount).toBe(3));
        });
        expect(mutate).toHaveBeenCalledOnce();
    });

    it('applies show-only as one exact atomic bulk mutation and honors cancellation', async () => {
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        const exactRef = { scope: 'allAgents', providerConnectionId: 'pc_a', modelId: 'manual-a' };

        confirm.mockResolvedValueOnce(false);
        await act(async () => { await screen.findByType(ProviderModelManager).props.onShowOnly?.(exactRef); });
        expect(mutate).not.toHaveBeenCalled();

        confirm.mockResolvedValueOnce(true);
        await act(async () => { await screen.findByType(ProviderModelManager).props.onShowOnly?.(exactRef); });
        expect(mutate).toHaveBeenCalledWith({
            serverId: 'server-a',
            request: {
                action: 'bulkVisibility', machineId: 'machine-a',
                changes: [{ ref: exactRef, hidden: false }],
            },
        });
    });

    it('delegates one exact Load action through the contained load hook', async () => {
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        await act(async () => { await screen.findByType(ProviderModelManager).props.onLoadModel?.('pc_a', 'manual-a'); });
        expect(loadModel).toHaveBeenCalledWith('pc_a', 'manual-a');
    });

    it('refreshes the provider catalog explicitly and retains the current list while refreshing', async () => {
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        const refreshButton = screen.findAllByType('Pressable')
            .find((item) => item.props.accessibilityLabel === 'common.refresh');

        expect(refreshButton).toBeDefined();
        await act(async () => { await refreshButton?.props.onPress?.(); });
        expect(probeProviderConnection).toHaveBeenCalledWith({
            machineId: 'machine-a', serverId: 'server-a', connectionId: 'pc_a',
        });
        expect(refresh).toHaveBeenCalledOnce();
        expect(screen.findByType(ProviderModelManager).props.groups[0].rows).toHaveLength(1);
    });

    it('does not publish a manual catalog refresh after the selected target changes', async () => {
        const deferred = createDeferred<Readonly<{
            status: 'success'; models: readonly []; requestFingerprint: string;
        }>>();
        probeProviderConnection.mockReturnValueOnce(deferred.promise);
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        const refreshButton = screen.findAllByType('Pressable')
            .find((item) => item.props.accessibilityLabel === 'common.refresh');

        await act(async () => {
            refreshButton?.props.onPress?.();
            await Promise.resolve();
        });
        await act(async () => {
            administrationTarget.controller.setMachines([
                { machineId: 'machine-a', displayName: 'Mac' },
                { machineId: 'machine-b', displayName: 'Linux' },
            ]);
            administrationTarget.controller.select('machine-b', 'srv_test');
            await flushHookEffects();
        });
        // Target selection owns a normal catalog load. Isolate publication by
        // the still-pending manual probe from that expected request.
        refresh.mockClear();
        await act(async () => {
            deferred.resolve({ status: 'success', models: [], requestFingerprint: 'probe-request:v1:old-target' });
        });
        await vi.waitFor(() => expect(
            sectionState(screen).refreshingCatalog,
        ).toBe(false));

        expect(refresh).not.toHaveBeenCalled();
    });
});
