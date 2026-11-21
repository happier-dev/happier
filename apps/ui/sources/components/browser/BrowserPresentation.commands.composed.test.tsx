import 'fake-indexeddb/auto';
import * as React from 'react';
import { Pressable } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';
import type { BrowserViewDiagnosticsProjection } from '@/sync/domains/browser/diagnostics';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';

installSettingsViewCommonModuleMocks({ storage: 'real', modal: () => vi.importActual('@/modal') });
vi.mock('@/components/ui/popover', async importOriginal =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal,
        { maxHeight: 600, maxWidth: 400, placement: 'bottom' }));
// Radix's DOM focus boundary is absent from the native test renderer; modal composition stays real.
vi.mock('@/utils/web/radixCjs', async importOriginal => {
    const actual = await importOriginal<typeof import('@/utils/web/radixCjs')>();
    const Inline = (props: React.PropsWithChildren) => props.children;
    return { ...actual, requireRadixDismissableLayer: () => ({ Root: Inline, Branch: Inline }),
        requireRadixFocusScope: () => ({ Root: Inline }) };
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { renderMountedCurrentUiContext } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
const { CurrentUiContextCommandsProvider, useCurrentUiContextComposedCommands, useCurrentUiContextCommandBridge } = await import('@/components/appShell/currentUiContext/CurrentUiContextCommands');
const { usePublishCurrentUiContext } = await import('@/components/appShell/currentUiContext/CurrentUiContextProvider');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { BrowserDiagnosticsDrawer } = await import('./diagnostics/BrowserDiagnosticsDrawer');
const { BrowserPrivacyPopover } = await import('./profile/BrowserPrivacyPopover');
const { showComputerTargetPicker } = await import('@/components/computer/showComputerTargetPicker');
const { ComputerTargetsListResponseV1Schema } = await import('@happier-dev/protocol/computer/v1');
const { Modal } = await import('@/modal');
const { CustomModal } = await import('@/modal/components/CustomModal');
const { BrowserProfileExtensionsSection } = await import('./profile/BrowserProfileExtensionsSection');
const { router } = await import('expo-router');
const { readStoreBrowserProfileRoute, readStoreMachineRoute } = await import('@/components/settings/plugins/model/pluginsSurfaceRoutes');
const { t } = await import('@/text');
let serverId: string;

function Publication() {
    const commands = useCurrentUiContextComposedCommands();
    usePublishCurrentUiContext(React.useMemo(() => ({ commands }), [commands]));
    return null;
}

beforeEach(async () => {
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(homes.request);
    await loadSyncSingletonForTests();
    const serverUrl = 'https://browser-presentation.test';
    serverId = await homes.addHome({ name: 'Browser presentation', serverUrl, serverIdentityId: 'srv_browser_presentation',
        accountId: 'presentation_owner', currentAccount: true });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await restoreConnectionToActiveServer((await TokenStorage.getCredentialsForServerUrl(serverUrl))!);
    const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
});
afterEach(async () => { await act(async () => Modal.hideAll()); standardCleanup(); await homes.reset(); });

async function mount(body: React.ReactNode) {
    return renderMountedCurrentUiContext(<CurrentUiContextCommandsProvider authority={captureActiveServerAccountScopeLifetime()}>
        <Publication />{body}
    </CurrentUiContextCommandsProvider>, { withModalProvider: true });
}

async function invoke(title: string, expectedOk = true) {
    const executor = createDefaultActionExecutor();
    const caller = { serverId, surface: 'agent' as const, authority: 'account_automation' as const };
    const read = await executor.execute('ui.current_context.read', {}, caller);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('Current UI read failed');
    const snapshot = read.result as { commands: readonly { id: string; title: string }[] };
    const command = snapshot.commands.find(row => row.title === title);
    expect(command, title).toBeDefined();
    let result: Awaited<ReturnType<typeof executor.execute>> | undefined;
    await act(async () => { result = await executor.execute('ui.current_context.command.invoke', { commandId: command!.id }, caller); });
    expect(result).toMatchObject({ ok: expectedOk });
    return result;
}

it('opens the mounted diagnostics drawer and selects an available section through the agent Action', async () => {
    const diagnostics: BrowserViewDiagnosticsProjection = { status: 'available', sourceKind: 'browserDiagnostics',
        browserSessionId: 'presentation_browser', viewId: 'presentation_view', navigationGeneration: 1,
        fidelity: 'injectedPage', trusted: false, eventCount: 0, events: [], families: (['console', 'elements'] as const).map(family => ({
            family, status: 'available', fidelity: 'injectedPage', trusted: false,
        })) };
    const screen = await mount(<BrowserDiagnosticsDrawer diagnostics={diagnostics} testID="diagnostics" />);
    expect(screen.findByTestId('diagnostics-container-expanded')).toBeNull();
    await invoke(t('browserShell.devtools.title'));
    expect(screen.findByTestId('diagnostics-container-expanded')).not.toBeNull();
    await invoke(t('browserShell.devtools.section.elements'));
    expect(screen.findByTestId('diagnostics-body-elements-panel')).not.toBeNull();
    expect(screen.findByTestId('diagnostics-body-console-panel')).toBeNull();
    await invoke(t('browserShell.devtools.close'));
    expect(screen.findByTestId('diagnostics-container-expanded')).toBeNull();
    await screen.unmount();
});

it('opens the mounted privacy panel with the profile storage and permission facts visible', async () => {
    const screen = await mount(<BrowserPrivacyPopover testID="privacy" model={{ profile: null,
        activePermissionGrantCount: 2, permissionState: 'allowed' }} />);
    expect(screen.findByTestId('privacy-panel')).toBeNull();
    expect(await invoke(t('browserShell.privacy.title'))).toMatchObject({ ok: true, result: {
        profileId: null, storageMode: null, storagePersistence: null,
        activePermissionGrantCount: 2, permissionState: 'allowed',
    } });
    expect(screen.findByTestId('privacy-panel')).not.toBeNull();
    expect(screen.findByTestId('privacy-status-identity')).not.toBeNull();
    await screen.pressByTestIdAsync('privacy');
    expect(screen.findByTestId('privacy-panel')).toBeNull();
    await screen.pressByTestIdAsync('privacy');
    expect(screen.findByTestId('privacy-panel')).not.toBeNull();
    await screen.unmount();
});

it('opens the actual Computer picker modal and navigates to policy settings through the agent Action', async () => {
    const targets = ComputerTargetsListResponseV1Schema.parse({ targets: [
        { target: { kind: 'window', displayId: ':0', pid: 10, windowId: 1 }, title: 'Studio window' }],
        grants: { capture: 'granted', input: 'granted' } });
    function Opener() {
        const commandBridge = useCurrentUiContextCommandBridge();
        return <Pressable testID="computer-picker-open" onPress={() => {
            const request = { commandBridge, accountLifetime: captureActiveServerAccountScopeLifetime(),
                scope: { serverId, sessionId: 'presentation-session', machineId: 'machine-a' },
                machineName: 'Studio', agentName: 'Agent', onSelected: () => {},
                // Action execution is the Machine boundary; picker state, modal and route stay real.
                execute: async () => ({ ok: true as const, result: targets }) };
            showComputerTargetPicker(request);
        }} />;
    }
    const screen = await mount(<Opener />);
    await screen.pressByTestIdAsync('computer-picker-open');
    expect(screen.findByTestId('computer-target-picker-modal')).not.toBeNull();
    vi.mocked(router.push).mockClear();
    await invoke(t('computerUse.picker.policyChange'));
    expect(router.push).toHaveBeenCalledWith('/settings/actions');
    const closingModal = screen.findByType(CustomModal);
    expect(closingModal.props.visible).toBe(false);
    // Native exit animation completion retires the retained modal frame.
    await act(async () => closingModal.props.onExited());
    expect(screen.findByTestId('computer-target-picker-modal')).toBeNull();
    await screen.unmount();
});

it('opens the extension store for the mounted profile and Machine through the agent Action', async () => {
    const machine = { ...createPlainMachineRowFixture({ id: 'machine-a', accountId: 'presentation_owner' }), installationId: 'installation-a' };
    homes.answer(serverId, '/v1/machines/machine-a', { body: { machine } });
    homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async input => ({
        body: await createMachineReadBatchResponseFixture(input, () => machine).json(),
    }) });
    homes.answer(serverId, '/v1/actions/browser.extensions.list', { select: async body => {
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
        return { body: { v: 1, actionId: 'browser.extensions.list', requestId: envelope.requestId,
            execution: { ok: true, result: { status: 'ready', entries: [] } } } };
    } });
    const screen = await mount(<BrowserProfileExtensionsSection scope={captureActiveServerAccountScopeLifetime()!.scope}
        serverId={serverId} machineId="machine-a" profileId="work" testID="extensions" />);
    await vi.waitFor(() => expect(screen.findByTestId('extensions.loading')).toBeNull());
    expect(screen.findByTestId('extensions.empty')).not.toBeNull();
    vi.mocked(router.push).mockClear();
    await invoke(t('capabilities.store.browserExtensionProfile.browse'));
    const route = vi.mocked(router.push).mock.calls.at(-1)?.[0];
    expect(route).toBeDefined();
    const params = Object.fromEntries(new URL(String(route), 'https://local.test').searchParams);
    expect(readStoreBrowserProfileRoute(params)).toBe('work');
    expect(readStoreMachineRoute(params)).toEqual({ serverId, machineId: 'machine-a' });
    const { setActiveUnsavedChangesGuard, clearActiveUnsavedChangesGuard } = await import('@/utils/navigation/runGuardedNavigation');
    setActiveUnsavedChangesGuard({ isDirtyRef: { current: true }, requestDecision: async () => 'keepEditing', tag: 'presentation-test' });
    vi.mocked(router.push).mockClear();
    try {
        expect(await invoke(t('capabilities.store.browserExtensionProfile.browse'), false))
            .toMatchObject({ ok: false, errorCode: 'permission_denied' });
        expect(router.push).not.toHaveBeenCalled();
    } finally { clearActiveUnsavedChangesGuard(); }
    await screen.unmount();
});
