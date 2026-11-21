import * as React from 'react';
import { Dimensions } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { createNavigationPropMock } from '@/dev/testkit/mocks/reactNavigation';
import type { MachineAdministrationTargetSelectionV1 } from '@/sync/domains/machines/administration/useTargetSelection';
import { getTempData, storeTempData, type NewSessionData } from '@/utils/sessions/tempDataStore';

const routeBoundary = vi.hoisted(() => ({ params: {} as Record<string, string>, focused: true, dispatch: vi.fn(), push: vi.fn(), replace: vi.fn() }));
installApprovalCommonModuleMocks({
    text: async () => vi.importActual<typeof import('@/text')>('@/text'),
    reactNavigation: async () => {
        const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
        return createReactNavigationNativeMock({ navigation: { isFocused: () => routeBoundary.focused } });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ params: () => routeBoundary.params,
            router: { push: routeBoundary.push, replace: routeBoundary.replace },
            navigation: { dispatch: routeBoundary.dispatch, getState: () => ({ index: 1, routes: [
                { key: 'original-composer', name: 'new', params: { draftId: routeBoundary.params.draftId } },
                { key: 'add', name: 'settings/machines/add', params: routeBoundary.params },
            ] }) },
        }).module;
    },
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
// Load the real route graph outside per-interaction budgets, as the picker harness does.
await import('./MachineAddDraftScreen');
await import('./MachineAddForm');
beforeEach(async () => { routeBoundary.params = {}; routeBoundary.focused = true; routeBoundary.dispatch.mockClear(); routeBoundary.push.mockClear(); routeBoundary.replace.mockClear(); await harness.reset(); });
afterEach(async () => { const { discardMachineAdd } = await import('./useMachineAddFlow'); await act(async () => discardMachineAdd()); standardCleanup(); });

describe('Add machine Connect and Create entry', () => {
    it('opens the connection path for an explicit Connect entry when cloud creation is enabled', async () => {
        const target = await harness.addHome({ name: 'Connect', serverUrl: 'https://connect-entry.example', accountId: 'owner' });
        harness.answer(target, '/v2/account/settings', { body: { content: { t: 'plain', v: { managedMachineCreationEnabled: true } }, version: 1 } });
        routeBoundary.params = { intent: 'connect' };
        const { MachineAddDraftScreen } = await import('./MachineAddDraftScreen');
        const { readMachineAddFlowDraft } = await import('./machineAddFlowStore');
        const screen = await renderScreen(<MachineAddDraftScreen />);
        try {
            await waitForHomeGovernance(() => expect(screen.tree.findAll(node => node.props.testID === 'settings.machines.draft.form.path:create').length).toBeGreaterThan(0));
            expect(readMachineAddFlowDraft()).toMatchObject({ creating: false, path: 'thisComputer' });
            expect(screen.tree.findAll(node => node.props.testID === 'managed-picker')).toHaveLength(0);
        } finally { await screen.unmount(); }
    });
    it('opens Create in the addressed Home while retaining a connection draft for another Home', async () => {
        const connected = await harness.addHome({ name: 'Existing setup', serverUrl: 'https://retained-connect.example', accountId: 'owner' });
        const target = await harness.addHome({ name: 'Notice Home', serverUrl: 'https://notice-create.example', accountId: 'owner' });
        harness.answer(target, '/v2/account/settings', { body: { content: { t: 'plain', v: { managedMachineCreationEnabled: true } }, version: 1 } });
        const { updateMachineAddFlowDraft, readMachineAddFlowDraft } = await import('./machineAddFlowStore');
        updateMachineAddFlowDraft(current => ({ ...current, serverId: connected, path: 'ssh',
            sshDraft: { ...current.sshDraft, host: 'keep-this-host.example' } }));
        routeBoundary.params = { path: 'create', serverId: target };
        const { MachineAddDraftScreen } = await import('./MachineAddDraftScreen');
        const { MachineProvisionerPicker } = await import('@/components/settings/machines/managed/MachineProvisionerPicker');
        const screen = await renderScreen(<MachineAddDraftScreen />);
        try {
            await waitForHomeGovernance(() => expect(screen.tree.findAllByType(MachineProvisionerPicker)[0]?.props.serverId).toBe(target));
            expect(readMachineAddFlowDraft()).toMatchObject({ serverId: connected, sshDraft: { host: 'keep-this-host.example' } });
            expect(harness.requests.some(request => request.path.endsWith('/acquire'))).toBe(false);
        } finally { await screen.unmount(); }
    });
    it('retains the explicitly chosen controller as the open Create way crosses to phone width', async () => {
        const serverId = await harness.addHome({ name: 'Build', serverUrl: 'https://resize-add.example',
            serverIdentityId: 'srv_resize_add', accountId: 'owner', currentAccount: true });
        harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: { managedMachineCreationEnabled: true } }, version: 1 } });
        const machines = ['first', 'other'].map(id => createMachineFixture({
            id, installationId: `${id}-installation`, activeAt: Date.now(),
            operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } },
        }));
        await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, machines);
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1, setMachineAdministrationTargetPreference } =
            await import('@/sync/domains/machines/administration/selectionPreferences');
        storage.setState(state => ({ settingsScope: { serverId: 'srv_resize_add', accountId: 'owner' },
            settings: { ...state.settings, machineAdministrationTargetsLocalV1: setMachineAdministrationTargetPreference(
                state.settings.machineAdministrationTargetsLocalV1, MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.managedMachines,
                { serverIdentityId: 'srv_resize_add', machineId: 'first' }) } }));
        routeBoundary.params = { path: 'create', serverId };
        const { MachineAddDraftScreen } = await import('./MachineAddDraftScreen');
        const { MachineAdministrationTargetSelector } = await import('@/components/settings/machines/MachineAdministrationTargetSelector');
        const viewport = vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 1440, height: 844, scale: 1, fontScale: 1 });
        const listeners = new Set<Parameters<typeof Dimensions.addEventListener>[1]>();
        const addPlatformListener = Dimensions.addEventListener.bind(Dimensions);
        const events = vi.spyOn(Dimensions, 'addEventListener').mockImplementation((type, listener) => {
            const subscription = addPlatformListener(type, listener);
            const remove = subscription.remove.bind(subscription);
            listeners.add(listener);
            return Object.assign(subscription, { remove: () => {
                listeners.delete(listener);
                remove();
            } });
        });
        let screen = await renderScreen(<MachineAddDraftScreen />);
        try {
            const selection = (): MachineAdministrationTargetSelectionV1 | undefined => screen.tree.findAllByType(MachineAdministrationTargetSelector)
                .find(node => node.props.testIDPrefix === 'managed-picker.controller')?.props.selection;
            await waitForHomeGovernance(() => expect(selection()?.selectedTarget?.machineId).toBe('first'));
            const other = selection()?.pickerRows.find(row => row.candidate.target.machineId === 'other')?.candidate.target;
            expect(other).toBeDefined();
            await act(async () => selection()?.selectTarget(other!));
            expect(selection()?.selectedTarget?.machineId).toBe('other');
            expect(screen.findHostByTestId('settings.machines.draft.form.path:create')).not.toBeNull();

            const phone = { width: 390, height: 844, scale: 1, fontScale: 1 };
            viewport.mockReturnValue(phone);
            await act(async () => {
                for (const listener of [...listeners]) listener({ window: phone, screen: phone });
            });
            expect(screen.findHostByTestId('settings.machines.draft.form.path:create')).toBeNull();
            await waitForHomeGovernance(() => expect(selection()?.selectedTarget?.machineId).toBe('other'));

            // Settings can replace its navigator when the presentation changes.
            await screen.unmount();
            screen = await renderScreen(<MachineAddDraftScreen />);
            await waitForHomeGovernance(() => expect(selection()?.selectedTarget?.machineId).toBe('other'));
        } finally {
            await screen.unmount();
            events.mockRestore();
            viewport.mockRestore();
        }
    });
    it.each([true, false])('returns an arrived machine to its original draft once and leaves a later Add open (focused initially: %s)', async focused => {
        const target = await harness.addHome({ name: 'Build', serverUrl: 'https://composer-return.example', serverIdentityId: 'srv_composer_return', accountId: 'owner' });
        harness.answer(target, '/v2/account/settings', { body: { content: { t: 'plain', v: { managedMachineCreationEnabled: false } }, version: 1 } });
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
        const { MachineAddDraftScreen } = await import('./MachineAddDraftScreen');
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        const { NavigationContext } = await import('@react-navigation/native');
        const renderAdd = () => <NavigationContext.Provider value={createNavigationPropMock({ isFocused: () => routeBoundary.focused })}><InjectedAuthProvider credentials={null}><MachineAddDraftScreen /></InjectedAuthProvider></NavigationContext.Provider>;
        const authoring = { prompt: 'Keep this prompt', agentType: 'claude', permissionMode: 'read-only' } satisfies NewSessionData;
        const dataId = storeTempData(authoring);
        routeBoundary.params = { draftId: 'original-draft', dataId, path: 'anotherComputer' };
        routeBoundary.focused = focused;
        storage.getState().applyMachines([], true, { sourceServerId: target });
        let screen = await renderScreen(renderAdd());
        try {
            await flushHookEffects({ cycles: 10 });
            const { readMachineAddFlowDraft } = await import('./machineAddFlowStore');
            expect(readMachineAddFlowDraft().startedAtMs).not.toBeNull();
            await act(async () => storage.getState().applyMachines([createMachineFixture({ id: 'joined', activeAt: Date.now() })], true, { sourceServerId: target }));
            if (!focused) {
                expect(routeBoundary.dispatch).not.toHaveBeenCalled();
                routeBoundary.focused = true;
                await act(async () => screen.update(renderAdd()));
            }
            await waitForHomeGovernance(() => expect(routeBoundary.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'SET_PARAMS' })));
            const result = routeBoundary.dispatch.mock.calls.find(([action]) => action.type === 'SET_PARAMS')?.[0];
            expect(result).toMatchObject({ source: 'original-composer', payload: { params: { machineId: 'joined', spawnServerId: resolveServerProfileScopeIdForIdentifier(target) } } });
            expect(routeBoundary.params.draftId).toBe('original-draft');
            expect(getTempData<NewSessionData>(result.payload.params.dataId)).toMatchObject(authoring);
            expect(routeBoundary.push).not.toHaveBeenCalled();
            expect(routeBoundary.replace).not.toHaveBeenCalled();
            await screen.unmount();
            routeBoundary.dispatch.mockClear();
            screen = await renderScreen(renderAdd());
            await flushHookEffects({ cycles: 10 });
            expect(routeBoundary.dispatch).not.toHaveBeenCalled();
        } finally { await screen.unmount(); getTempData(dataId); }
    });
    it('hides Create for the addressed Account while keeping connection paths available', async () => {
        const target = await harness.addHome({ name: 'Build', serverUrl: 'https://creation-disabled.example', serverIdentityId: 'srv_creation_off', accountId: 'owner' });
        harness.answer(target, '/v2/account/settings', { body: { content: { t: 'plain', v: { managedMachineCreationEnabled: false } }, version: 1 } });
        const { MachineAddDraftScreen } = await import('./MachineAddDraftScreen');
        const screen = await renderScreen(<MachineAddDraftScreen />);
        await flushHookEffects({ cycles: 20 });
        expect(screen.tree.findAll(node => node.props.testID === 'settings.machines.draft.form.path:create')).toHaveLength(0);
        expect(screen.tree.findAll(node => node.props.testID === 'settings.machines.draft.form.path:ssh').length).toBeGreaterThan(0);
        expect(harness.requests.some(request => request.path.includes('machines.provisioners'))).toBe(false);
        await screen.unmount();
    });

    it('opens on Create one in the cloud in a browser, with Create one last on the bar (58d §D2, P-M7 order)', async () => {
        const target = await harness.addHome({ name: 'Build', serverUrl: 'https://creation-on.example', serverIdentityId: 'srv_creation_on', accountId: 'owner' });
        harness.answer(target, '/v2/account/settings', { body: { content: { t: 'plain', v: { managedMachineCreationEnabled: true } }, version: 1 } });
        const { MachineAddDraftScreen } = await import('./MachineAddDraftScreen');
        const screen = await renderScreen(<MachineAddDraftScreen />);
        await waitForHomeGovernance(() => expect(screen.tree.findAll(node => node.props.testID === 'managed-picker').length).toBeGreaterThan(0));
        // Create one is a way in beside the connection paths, not a second tab layer; it ends the bar.
        const segmentIds = screen.tree.findAll(node => typeof node.props.testID === 'string' && node.props.testID.startsWith('settings.machines.draft.form.path:'))
            .map(node => node.props.testID as string).filter((id, index, all) => all.indexOf(id) === index);
        expect(segmentIds.at(-1)).toBe('settings.machines.draft.form.path:create');
        expect(screen.tree.findAll(node => node.props.testID === 'settings.machines.draft.form.mode:create')).toHaveLength(0);
        const { readMachineAddFlowDraft } = await import('./machineAddFlowStore');
        expect(readMachineAddFlowDraft().creating).toBe(true);
        expect(harness.requests.some(request => request.path.endsWith('/acquire'))).toBe(false);
        // Choosing a connection path leaves Create one.
        await act(async () => screen.pressByTestId('settings.machines.draft.form.path:ssh'));
        expect(screen.tree.findAll(node => node.props.testID === 'managed-picker')).toHaveLength(0);
        expect(readMachineAddFlowDraft().creating).toBe(false);
        await screen.unmount();
    });

    it('watches for an SSH machine only once its command is on screen, and says one waiting line for a pairing link', async () => {
        const target = await harness.addHome({ name: 'Build', serverUrl: 'https://watch-line.example', serverIdentityId: 'srv_watch_line', accountId: 'owner' });
        harness.answer(target, '/v2/account/settings', { body: { content: { t: 'plain', v: { managedMachineCreationEnabled: true } }, version: 1 } });
        const { MachineAddDraftScreen } = await import('./MachineAddDraftScreen');
        const { readMachineAddFlowDraft } = await import('./machineAddFlowStore');
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><MachineAddDraftScreen /></InjectedAuthProvider>);
        await waitForHomeGovernance(() => expect(screen.tree.findAll(node => node.props.testID === 'settings.machines.draft.form.path:ssh').length).toBeGreaterThan(0));
        const watchLines = () => screen.tree.findAll(node => typeof node.props.testID === 'string' && node.props.testID.endsWith('.watch'));
        // An empty SSH form has no command to run yet, so nothing can be on its way.
        await act(async () => screen.pressByTestId('settings.machines.draft.form.path:ssh'));
        await flushHookEffects({ cycles: 5 });
        expect(readMachineAddFlowDraft().startedAtMs).toBeNull();
        expect(watchLines()).toHaveLength(0);
        // The pairing panel carries its own waiting line; arrival is still watched behind it.
        await act(async () => screen.pressByTestId('settings.machines.draft.form.path:anotherComputer'));
        await flushHookEffects({ cycles: 5 });
        expect(readMachineAddFlowDraft().startedAtMs).not.toBeNull();
        expect(watchLines()).toHaveLength(0);
        await screen.unmount();
    });
});
