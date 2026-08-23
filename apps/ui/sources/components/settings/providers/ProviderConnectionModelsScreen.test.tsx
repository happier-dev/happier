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
import { SelectionListScreen } from '@/components/ui/selectionList';
import type { ProviderModelLoadUiResult } from '@/providers/hooks/useProviderModelLoadAction';
import { ProviderModelManager } from '@/providers/models/ProviderModelManager';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';
import { ProviderConnectionModelsView } from './models/ProviderConnectionModelsView';

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
const probeProviderConnection = vi.hoisted(() => vi.fn(async (_input: unknown) => ({ status: 'success' as const, models: [], requestFingerprint: 'probe-request:v1:test' })));
const routerPush = vi.hoisted(() => vi.fn());
const routerBack = vi.hoisted(() => vi.fn());
const navigationDispatch = vi.hoisted(() => vi.fn());
const navigationPreventRemove = vi.hoisted(() => ({
    enabled: false,
    callback: null as null | ((event: { data: { action: unknown } }) => void),
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
vi.mock('@/components/ui/forms/MachineSetupTextField', () => ({
    MachineSetupTextField: (props: Record<string, unknown>) => React.createElement('MachineSetupTextField', props),
}));
vi.mock('@/components/ui/lists/Item', () => ({ Item: (props: Record<string, unknown>) => React.createElement('Item', props) }));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('ItemGroup', props, props.children),
}));
vi.mock('@/components/ui/icons/SafeIonicons', () => ({ SafeIonicons: () => null }));

describe('ProviderConnectionModelsScreen', () => {
    afterEach(standardCleanup);
    beforeEach(() => {
        providerHarness.reset();
        administrationTarget.controller.reset();
        navigationDispatch.mockClear();
        navigationPreventRemove.enabled = false;
        navigationPreventRemove.callback = null;
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

    it('recovers a directly opened models route when Provider availability finishes loading', async () => {
        state.providerDecisionState = 'loading';
        const { ProviderConnectionModelsScreen } = await import('./ProviderConnectionModelsScreen');
        const element = <ProviderConnectionModelsScreen connectionId="pc_a" />;
        const screen = await renderScreen(element);

        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .toContain('settingsProviders.availabilityChecking');
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
        const { ProviderConnectionModelsScreen } = await import('./ProviderConnectionModelsScreen');
        const screen = await renderScreen(<ProviderConnectionModelsScreen connectionId="pc_a" />);

        expect(screen.findByType(ProviderModelManager).props.groups[0].rows[0].descriptor.name)
            .toBe('Boundary model');
    });

    it('keeps a large manager scope stable while an unrelated manual-model draft changes', async () => {
        await withPopoverWebGlobals(async () => {
            state.models = Array.from({ length: 500 }, (_, index): DaemonProviderModelRowV1 => ({
                id: `model-${index}`,
                name: `Model ${index}`,
                source: 'probe',
                stale: false,
                loadState: 'unknown',
                visibility: 'visible',
            }));
            const { ProviderConnectionModelsScreen } = await import('./ProviderConnectionModelsScreen');
            const screen = await renderScreen(<ProviderConnectionModelsScreen connectionId="pc_a" />);
            const rootStepBefore = screen.findByType(SelectionListScreen).props.rootStep;
            expect(rootStepBefore.sections[0]?.options).toHaveLength(500);

            await act(async () => {
                screen.findByType('MachineSetupTextField').props.onChangeText?.('draft-model');
            });

            expect(screen.findByType(SelectionListScreen).props.rootStep).toBe(rootStepBefore);
        });
    });

    it('replaces the manager scope when its visibility filter changes', async () => {
        state.models = [{
            id: 'hidden-model',
            name: 'Hidden model',
            source: 'probe',
            stale: false,
            loadState: 'unknown',
            visibility: 'hidden_all_agents',
        }];
        const { ProviderConnectionModelsScreen } = await import('./ProviderConnectionModelsScreen');
        const screen = await renderScreen(<ProviderConnectionModelsScreen connectionId="pc_a" />);
        const rootStepBefore = screen.findByType(SelectionListScreen).props.rootStep;

        await act(async () => {
            screen.findAllByType('Pressable')
                .find((item) => item.props.accessibilityLabel === 'settingsProviders.models.showHidden')
                ?.props.onPress?.();
        });

        const rootStepAfter = screen.findByType(SelectionListScreen).props.rootStep;
        expect(rootStepAfter).not.toBe(rootStepBefore);
        expect(rootStepAfter.sections.flatMap((section: { options: readonly { label: string }[] }) => section.options)
            .map((option: { label: string }) => option.label)).toContain('Hidden model');
    });

    it('explains catalog-managed providers without offering manual model entry', async () => {
        state.manualModelPolicy = 'catalog-only';
        const { ProviderConnectionModelsScreen } = await import('./ProviderConnectionModelsScreen');
        const screen = await renderScreen(React.createElement(ProviderConnectionModelsScreen, { connectionId: 'pc_a' }));

        expect(screen.findAllByType('InlineAddExpander')).toHaveLength(0);
        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .toContain('settingsProviders.models.providerManagedTitle');
    });

    it('does not render an empty manager while the initial catalog is loading or failed', async () => {
        state.loading = true;
        state.models = [];
        const { ProviderConnectionModelsScreen } = await import('./ProviderConnectionModelsScreen');
        const loading = await renderScreen(<ProviderConnectionModelsScreen connectionId="pc_a" />);
        expect(loading.findAllByType(ProviderModelManager)).toHaveLength(0);
        expect(loading.findAllByType('Item').some((item) => item.props.loading === true)).toBe(true);

        state.loading = false;
        state.error = createProviderErrorV1('provider_endpoint_unreachable');
        const failed = await renderScreen(<ProviderConnectionModelsScreen connectionId="pc_a" />);
        expect(failed.findAllByType(ProviderModelManager)).toHaveLength(0);
        expect(failed.findAllByType('Item').map((item) => item.props.title))
            .toContain('settingsProviders.errors.unreachableTitle');
    });

    it('removes only through the manager callback using the current connection revision', async () => {
        const { ProviderConnectionModelsScreen } = await import('./ProviderConnectionModelsScreen');
        const screen = await renderScreen(React.createElement(ProviderConnectionModelsScreen, { connectionId: 'pc_a' }));

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
        const { ProviderConnectionModelsScreen } = await import('./ProviderConnectionModelsScreen');
        const screen = await renderScreen(<ProviderConnectionModelsScreen connectionId="pc_a" />);
        const row = screen.findByType(ProviderModelManager).props.groups[0].rows[0];

        expect(row.sources).toEqual({ manual: true, static: false, probe: false });
        expect(row).not.toHaveProperty('source');
    });

    it('adds every pasted manual model in one atomic mutation', async () => {
        mutate.mockResolvedValueOnce({ status: 'success', action: 'manualAdd' });
        const { ProviderConnectionModelsScreen } = await import('./ProviderConnectionModelsScreen');
        const screen = await renderScreen(React.createElement(ProviderConnectionModelsScreen, { connectionId: 'pc_a' }));

        await act(async () => {
            screen.findByType('MachineSetupTextField').props.onChangeText?.('model-a\nmodel-b\nmodel-c');
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
        const { ProviderConnectionModelsScreen } = await import('./ProviderConnectionModelsScreen');
        const screen = await renderScreen(<ProviderConnectionModelsScreen connectionId="pc_a" />);

        await act(async () => {
            screen.findByType('MachineSetupTextField').props.onChangeText?.('valid-model\nbad model\nvalid-model');
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
        expect(screen.findByType('MachineSetupTextField').props.value).toBe('bad model');
        expect(screen.findByType('MachineSetupTextField').props.errorText).toBeTruthy();
        expect(refresh).toHaveBeenCalledOnce();
    });

    it('renders typed operation recovery inline with the exact actionable retry', async () => {
        mutate.mockResolvedValueOnce({
            status: 'error',
            error: createProviderErrorV1('provider_endpoint_unavailable', { connectionId: 'pc_a' }),
        });
        const { ProviderConnectionModelsScreen } = await import('./ProviderConnectionModelsScreen');
        const screen = await renderScreen(<ProviderConnectionModelsScreen connectionId="pc_a" />);

        await act(async () => { await screen.findByType(ProviderModelManager).props.onResetVisibility?.(); });

        expect(alert).not.toHaveBeenCalled();
        expect(screen.findAllByType('Item').map((item) => item.props.title)).toContain('settingsProviders.errors.actions.retry');
    });

    it('shows initial transport failure and preserves stale rows when a later refresh fails', async () => {
        state.models = [];
        state.error = createProviderErrorV1('provider_endpoint_unavailable', {
            connectionId: 'pc_a',
            machineId: 'machine-a',
        });
        const { ProviderConnectionModelsScreen } = await import('./ProviderConnectionModelsScreen');
        const initialFailure = await renderScreen(<ProviderConnectionModelsScreen connectionId="pc_a" />);

        expect(initialFailure.findAllByType(ProviderModelManager)).toHaveLength(0);
        expect(initialFailure.findAllByType('Item').map((item) => item.props.title))
            .toContain('settingsProviders.errors.unreachableTitle');
        expect(initialFailure.findAllByType('Item').map((item) => item.props.title))
            .toContain('settingsProviders.errors.actions.retry');

        await act(async () => { initialFailure.tree.unmount(); });
        state.models = [{ id: 'stale-a', name: 'Stale A', source: 'manual', stale: true, loadState: 'unknown', visibility: 'visible' }];
        state.error = null;
        const staleFailure = await renderScreen(<ProviderConnectionModelsScreen connectionId="pc_a" />);
        state.error = createProviderErrorV1('provider_endpoint_unavailable', {
            connectionId: 'pc_a', machineId: 'machine-a',
        });
        const refreshButton = staleFailure.findAllByType('Pressable')
            .find((item) => item.props.accessibilityLabel === 'common.refresh');
        await act(async () => { await refreshButton?.props.onPress?.(); });
        expect(staleFailure.findAllByType(ProviderModelManager)).toHaveLength(1);
        expect(staleFailure.findByType(ProviderModelManager).props.groups[0].rows).toHaveLength(1);
        expect(staleFailure.findAllByType('Item').map((item) => item.props.title))
            .toContain('settingsProviders.errors.unreachableTitle');
    });

    it('turns an ambiguous reset transport failure into current-state review without replay', async () => {
        mutate.mockRejectedValueOnce(new Error('transport failed'));
        const { ProviderConnectionModelsScreen } = await import('./ProviderConnectionModelsScreen');
        const screen = await renderScreen(React.createElement(ProviderConnectionModelsScreen, { connectionId: 'pc_a' }));

        await act(async () => { await screen.findByType(ProviderModelManager).props.onResetVisibility?.(); });

        expect(alert).not.toHaveBeenCalled();
        expect(modelsRequestCount).toBe(2);
        expect(refresh).toHaveBeenCalledOnce();
        expect(screen.findByType(ProviderConnectionModelsView).props.errorRetry).toBeUndefined();
        expect(screen.findByType(ProviderConnectionModelsView).props.errorReviewCurrentState).toEqual(expect.any(Function));
        const titles = screen.findAllByType('Item').map((item) => item.props.title);
        expect(titles).toContain('settingsProviders.errors.mutationOutcomeUnknownTitle');
        expect(titles).toContain('settingsProviders.errors.actions.reviewCurrentState');
        await act(async () => {
            await screen.findAllByType('Item')
                .find((item) => item.props.title === 'settingsProviders.errors.actions.reviewCurrentState')
                ?.props.onPress?.();
        });
        expect(mutate).toHaveBeenCalledOnce();
        expect(modelsRequestCount).toBe(3);
        expect(refresh).toHaveBeenCalledTimes(2);
        expect(routerPush).not.toHaveBeenCalled();
    });

    it('contains a bulk visibility transport failure in the same inline recovery owner', async () => {
        mutate.mockRejectedValueOnce(new Error('transport failed'));
        const { ProviderConnectionModelsScreen } = await import('./ProviderConnectionModelsScreen');
        const screen = await renderScreen(<ProviderConnectionModelsScreen connectionId="pc_a" />);

        await act(async () => { await screen.findByType(ProviderModelManager).props.onShowAll?.(); });

        expect(alert).not.toHaveBeenCalled();
        expect(modelsRequestCount).toBe(2);
        expect(refresh).toHaveBeenCalledOnce();
        expect(screen.findByType(ProviderConnectionModelsView).props.errorRetry).toBeUndefined();
        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .toContain('settingsProviders.errors.actions.reviewCurrentState');
        await act(async () => {
            await screen.findAllByType('Item')
                .find((item) => item.props.title === 'settingsProviders.errors.actions.reviewCurrentState')
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
        const { ProviderConnectionModelsScreen } = await import('./ProviderConnectionModelsScreen');
        const screen = await renderScreen(<ProviderConnectionModelsScreen connectionId="pc_a" />);
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
        const { ProviderConnectionModelsScreen } = await import('./ProviderConnectionModelsScreen');
        const screen = await renderScreen(<ProviderConnectionModelsScreen connectionId="pc_a" />);
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

    it('keeps a typed manual-model draft through the shared navigation transaction', async () => {
        const { ProviderConnectionModelsScreen } = await import('./ProviderConnectionModelsScreen');
        const screen = await renderScreen(<ProviderConnectionModelsScreen connectionId="pc_a" />);
        expect(navigationPreventRemove.enabled).toBe(false);

        await act(async () => {
            screen.findByType('MachineSetupTextField').props.onChangeText?.('draft-model');
            await flushHookEffects({ cycles: 1, turns: 2 });
        });

        expect(navigationPreventRemove.enabled).toBe(true);
        const action = { type: 'GO_BACK' };
        await act(async () => {
            navigationPreventRemove.callback?.({ data: { action } });
            await flushHookEffects({ cycles: 1, turns: 2 });
        });
        const buttons = alert.mock.calls.at(-1)?.[2] as Array<{
            style?: string;
            onPress?: () => void;
        }>;
        await act(async () => {
            buttons.find((button) => button.style === 'cancel')?.onPress?.();
            await flushHookEffects({ cycles: 1, turns: 2 });
        });

        expect(navigationDispatch).not.toHaveBeenCalled();
        expect(mutate).not.toHaveBeenCalled();
    });

    it('contains a single-model visibility transport failure in the same inline recovery owner', async () => {
        mutate.mockRejectedValueOnce(new Error('transport failed'));
        const { ProviderConnectionModelsScreen } = await import('./ProviderConnectionModelsScreen');
        const screen = await renderScreen(<ProviderConnectionModelsScreen connectionId="pc_a" />);

        await act(async () => {
            await screen.findByType(ProviderModelManager).props.onSetVisibility?.(
                { scope: 'allAgents', providerConnectionId: 'pc_a', modelId: 'manual-a' },
                true,
            );
        });

        expect(alert).not.toHaveBeenCalled();
        expect(modelsRequestCount).toBe(2);
        expect(refresh).toHaveBeenCalledOnce();
        expect(screen.findByType(ProviderConnectionModelsView).props.errorRetry).toBeUndefined();
        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .toContain('settingsProviders.errors.actions.reviewCurrentState');
        await act(async () => {
            await screen.findAllByType('Item')
                .find((item) => item.props.title === 'settingsProviders.errors.actions.reviewCurrentState')
                ?.props.onPress?.();
        });
        expect(mutate).toHaveBeenCalledOnce();
        expect(modelsRequestCount).toBe(3);
        expect(refresh).toHaveBeenCalledTimes(2);
        expect(routerPush).not.toHaveBeenCalled();
    });

    it('contains a manual-add transport failure in the same inline recovery owner', async () => {
        mutate.mockRejectedValueOnce(new Error('transport failed'));
        const { ProviderConnectionModelsScreen } = await import('./ProviderConnectionModelsScreen');
        const screen = await renderScreen(<ProviderConnectionModelsScreen connectionId="pc_a" />);

        await act(async () => {
            screen.findByType('MachineSetupTextField').props.onChangeText?.('new-model');
        });
        await act(async () => { await screen.findByType('InlineAddExpander').props.onSave?.(); });

        expect(alert).not.toHaveBeenCalled();
        expect(modelsRequestCount).toBe(2);
        expect(refresh).toHaveBeenCalledOnce();
        expect(screen.findByType(ProviderConnectionModelsView).props.errorRetry).toBeUndefined();
        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .toContain('settingsProviders.errors.actions.reviewCurrentState');
        await act(async () => {
            await screen.findAllByType('Item')
                .find((item) => item.props.title === 'settingsProviders.errors.actions.reviewCurrentState')
                ?.props.onPress?.();
        });
        expect(mutate).toHaveBeenCalledOnce();
        expect(modelsRequestCount).toBe(3);
        expect(refresh).toHaveBeenCalledTimes(2);
        expect(routerPush).not.toHaveBeenCalled();
    });

    it('contains a manual-remove transport failure in the same inline recovery owner', async () => {
        mutate.mockRejectedValueOnce(new Error('transport failed'));
        const { ProviderConnectionModelsScreen } = await import('./ProviderConnectionModelsScreen');
        const screen = await renderScreen(<ProviderConnectionModelsScreen connectionId="pc_a" />);

        await act(async () => {
            await screen.findByType(ProviderModelManager).props.onRemoveManualModel?.('pc_a', 'manual-a');
        });

        expect(alert).not.toHaveBeenCalled();
        expect(modelsRequestCount).toBe(2);
        expect(refresh).toHaveBeenCalledOnce();
        expect(screen.findByType(ProviderConnectionModelsView).props.errorRetry).toBeUndefined();
        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .toContain('settingsProviders.errors.actions.reviewCurrentState');
        await act(async () => {
            await screen.findAllByType('Item')
                .find((item) => item.props.title === 'settingsProviders.errors.actions.reviewCurrentState')
                ?.props.onPress?.();
        });
        expect(mutate).toHaveBeenCalledOnce();
        expect(modelsRequestCount).toBe(3);
        expect(refresh).toHaveBeenCalledTimes(2);
        expect(routerPush).not.toHaveBeenCalled();
    });

    it('contains an explicit catalog-refresh transport failure in the same inline recovery owner', async () => {
        probeProviderConnection.mockRejectedValueOnce(new Error('transport failed'));
        const { ProviderConnectionModelsScreen } = await import('./ProviderConnectionModelsScreen');
        const screen = await renderScreen(<ProviderConnectionModelsScreen connectionId="pc_a" />);
        const refreshButton = screen.findAllByType('Pressable')
            .find((item) => item.props.accessibilityLabel === 'common.refresh');

        await act(async () => { await refreshButton?.props.onPress?.(); });

        expect(alert).not.toHaveBeenCalled();
        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .toContain('settingsProviders.errors.actions.retry');
    });

    it('contains a typed model-load transport failure in the same inline recovery owner', async () => {
        loadModel.mockResolvedValueOnce({
            status: 'error',
            error: createProviderErrorV1('provider_endpoint_unavailable', {
                connectionId: 'pc_a', machineId: 'machine-a',
            }),
        });
        const { ProviderConnectionModelsScreen } = await import('./ProviderConnectionModelsScreen');
        const screen = await renderScreen(<ProviderConnectionModelsScreen connectionId="pc_a" />);

        await act(async () => {
            await screen.findByType(ProviderModelManager).props.onLoadModel?.('pc_a', 'manual-a');
        });

        expect(alert).not.toHaveBeenCalled();
        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .toContain('settingsProviders.errors.actions.retry');
    });

    it('reviews an ambiguous model load on the current catalog without retaining load replay', async () => {
        loadModel.mockRejectedValueOnce(new Error('load acknowledgement lost while daemon work continues'));
        const { ProviderConnectionModelsScreen } = await import('./ProviderConnectionModelsScreen');
        const screen = await renderScreen(<ProviderConnectionModelsScreen connectionId="pc_a" />);

        await act(async () => {
            screen.findByType(ProviderModelManager).props.onLoadModel?.('pc_a', 'manual-a');
            await vi.waitFor(() => expect(modelsRequestCount).toBe(2));
        });
        await act(async () => {
            await vi.waitFor(() => expect(
                screen.findByTestId('provider-error:provider_rpc_mutation_outcome_unknown'),
            ).not.toBeNull());
        });

        const view = screen.findByType(ProviderConnectionModelsView);
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
        const { ProviderConnectionModelsScreen } = await import('./ProviderConnectionModelsScreen');
        const screen = await renderScreen(<ProviderConnectionModelsScreen connectionId="pc_a" />);
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
        const view = screen.findByType(ProviderConnectionModelsView);
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
        const { ProviderConnectionModelsScreen } = await import('./ProviderConnectionModelsScreen');
        const screen = await renderScreen(React.createElement(ProviderConnectionModelsScreen, { connectionId: 'pc_a' }));
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
        const { ProviderConnectionModelsScreen } = await import('./ProviderConnectionModelsScreen');
        const screen = await renderScreen(React.createElement(ProviderConnectionModelsScreen, { connectionId: 'pc_a' }));
        await act(async () => { await screen.findByType(ProviderModelManager).props.onLoadModel?.('pc_a', 'manual-a'); });
        expect(loadModel).toHaveBeenCalledWith('pc_a', 'manual-a');
    });

    it('refreshes the provider catalog explicitly and retains the current list while refreshing', async () => {
        const { ProviderConnectionModelsScreen } = await import('./ProviderConnectionModelsScreen');
        const screen = await renderScreen(React.createElement(ProviderConnectionModelsScreen, { connectionId: 'pc_a' }));
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
});
