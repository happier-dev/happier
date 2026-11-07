import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createNewSessionPromptStore } from '../hooks/screenModel/newSessionPromptStore';
import { NewSessionComposerCard } from './NewSessionComposerCard';
import type { NewSessionSimplePanelProps } from './NewSessionSimplePanel';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { useNewSessionWorkflowStart } from '../hooks/useNewSessionWorkflowStart';
import { getStorage } from '@/sync/domains/state/storageStore';
import { act } from 'react-test-renderer';
import { createMachineFixture, flattenTestStyle } from '@/dev/testkit';
import Color from 'color';
import { activateStorageAccountScope } from '@/dev/testkit/mocks/storage';
import { GlassRuntimeEnvironmentProvider } from '@/components/ui/glass/glassRuntimeEnvironment';
import { reportPopoverContentLayout, withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { OverlayPortalHost, OverlayPortalProvider } from '@/components/ui/popover/OverlayPortal';
import { AgentInputActionMenuPopoverContent } from '@/components/sessions/agentInput/components/AgentInputActionMenuPopoverContent';
import { SelectableRow } from '@/components/ui/lists/SelectableRow';
import { NewSessionEmbeddedHostProvider, type NewSessionEmbeddedHost } from '../navigation/newSessionHost';

const platformState = vi.hoisted(() => ({ os: 'web' as 'web' | 'android', width: 1440 }));
let activeAccountScope: Awaited<ReturnType<typeof activateStorageAccountScope>> | null = null;

beforeEach(async () => {
    activeAccountScope = await activateStorageAccountScope({ serverId: 'server-a', accountId: 'account-a' });
});
afterEach(() => {
    activeAccountScope?.dispose();
    activeAccountScope = null;
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({ width: platformState.width, height: 844, scale: 1, fontScale: 1 }),
        Platform: {
            get OS() { return platformState.os; },
            select: (values: Record<string, unknown>) => values[platformState.os] ?? values.default,
        },
    });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => [],
}));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

function panelProps(): NewSessionSimplePanelProps {
    return {
            // Native refs begin unmounted; this fixture does not measure the popover boundary.
            popoverBoundaryRef: React.createRef() as NewSessionSimplePanelProps['popoverBoundaryRef'],
            headerHeight: 0, safeAreaTop: 0, safeAreaBottom: 0,
            newSessionTopPadding: 0, newSessionSidePadding: 0, newSessionBottomPadding: 0, containerStyle: {},
            promptStore: createNewSessionPromptStore('Keep this brief'), setSessionPrompt: () => {},
            handleCreateSession: () => {}, canCreate: true, isCreating: false,
            emptyAutocompleteKinds: [], emptyAutocompleteSuggestions: async () => [],
            agentType: 'codex', handleAgentClick: undefined, permissionMode: 'default',
            handlePermissionModeChange: undefined, modelMode: 'default', setModelMode: undefined,
            modelOptions: [], connectionStatus: undefined, machineName: undefined, selectedPath: '/repo',
            useProfiles: false, selectedProfileId: null,
            showResumePicker: false, resumeSessionId: null, isResumeSupportChecking: false,
        } satisfies NewSessionSimplePanelProps;
}

const workflowPopoverOptions = {
    wrapper: ({ children }: React.PropsWithChildren) => <OverlayPortalProvider>{children}<OverlayPortalHost /></OverlayPortalProvider>,
    // Supply only the native ref boundary; menu placement and selection remain real.
    createNodeMock: () => ({
        measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(80, 120, 44, 44),
        getBoundingClientRect: () => ({ x: 80, y: 120, left: 80, top: 120, width: 44, height: 44, right: 124, bottom: 164 }),
        focus: () => {}, blur: () => {}, addEventListener: () => {}, removeEventListener: () => {},
        ownerDocument: { addEventListener: () => {}, removeEventListener: () => {} },
    }),
};

async function openWorkflowPicker(screen: Awaited<ReturnType<typeof renderScreen>>) {
    await screen.pressByTestIdAsync('agent-input-action-menu-button');
    await act(async () => { reportPopoverContentLayout(screen.tree, { width: 420, height: 400 }); });
    const actions: React.ComponentProps<typeof AgentInputActionMenuPopoverContent>['actionMenuActions'] =
        screen.findByType(AgentInputActionMenuPopoverContent).props.actionMenuActions;
    const action = actions.find(item => item.id === 'workflow-start-definition');
    expect(action).toBeDefined();
    const row = screen.findAllByType(SelectableRow).find(item => item.props.onPress === action?.onPress);
    expect(row).toBeDefined();
    await act(async () => { row!.props.onPress(); });
    await act(async () => { reportPopoverContentLayout(screen.tree, { width: 420, height: 400 }); });
}

describe('New workflow entry', () => {
    it('lets an empty embedded composer hide its status without hiding the next draft or launch status', async () => {
        const props = { ...panelProps(), promptStore: createNewSessionPromptStore(''),
            connectionStatus: { text: 'Machine unavailable', color: 'red', dotColor: 'red' } };
        const host: NewSessionEmbeddedHost = {
            params: {}, setParams: () => {}, openDraft: () => {}, onHandedOff: () => {}, demanded: false,
        };
        const element = (emptyComposerStatus: NewSessionEmbeddedHost['emptyComposerStatus'], isCreating = false) => (
            <NewSessionEmbeddedHostProvider host={{ ...host, emptyComposerStatus }}>
                <NewSessionComposerCard panelProps={{ ...props, isCreating }} layout="embedded" attachments={false} voiceAffordance="none" />
            </NewSessionEmbeddedHostProvider>
        );
        const screen = await renderScreen(element(undefined));
        try {
            expect(screen.findByTestId('agent-input-connection-status-text')).not.toBeNull();
            await screen.update(element({ text: 'Session started', color: 'green', dotColor: 'green' }));
            expect(screen.getTextContent()).toContain('Session started');
            await screen.update(element(null));
            expect(screen.findByTestId('agent-input-connection-status-text')).toBeNull();
            await act(async () => { props.promptStore.setPrompt('Start a session'); });
            expect(screen.findByTestId('agent-input-connection-status-text')).not.toBeNull();
            await act(async () => { props.promptStore.setPrompt(''); });
            expect(screen.findByTestId('agent-input-connection-status-text')).toBeNull();
            await screen.update(element(null, true));
            expect(screen.findByTestId('agent-input-connection-status-text')).not.toBeNull();
        } finally {
            await screen.unmount();
        }
    });
    it('keeps ordinary Machine and Agent controls without a second prompt or Send in a creation form', async () => {
        const screen = await renderScreen(<NewSessionComposerCard panelProps={{ ...panelProps(), machineName: 'Workstation', machinePopover: { renderContent: null } }}
            layout="embedded" inputPresentation="controlsOnly" attachments={false} voiceAffordance="none" />);
        expect(Boolean(screen.findByTestId('new-session-composer-input'))).toBe(false);
        expect(Boolean(screen.findByTestId('new-session-composer-send'))).toBe(false);
        expect(screen.getTextContent()).toContain('Workstation');
        await screen.unmount();
    });
    it('does not observe Machine inventory while no unsettled Workflow project needs a Where label', async () => {
        const store = getStorage(), previous = store.getState();
        const props = { ...panelProps(), selectedMachineId: 'machine-1', targetServerId: 'server-a' };
        let renders = 0;
        const hook = await renderHook(() => {
            renders++;
            return useNewSessionWorkflowStart({ panelProps: props, prompt: 'Keep this brief' });
        });
        try {
            const settled = renders;
            await act(async () => store.getState().applyMachines([createMachineFixture({ id: 'unrelated-machine' })], false,
                { sourceServerId: 'server-a', sourceAccountId: 'account-a' }));
            expect(renders).toBe(settled);
            expect(hook.getCurrent().composer).toBeNull();
            // The current picker choice is not the retained request: without an unsettled request,
            // even this Machine has no Workflow Where presentation to refresh.
            await act(async () => store.getState().applyMachines([createMachineFixture({ id: 'machine-1' })], false,
                { sourceServerId: 'server-a', sourceAccountId: 'account-a' }));
            expect(renders).toBe(settled);
        } finally {
            await hook.unmount();
            store.setState(previous, true);
        }
    });
    it('names the exact Provider model on the real composer chip using picker presentation', async () => {
        const { DaemonProviderModelProjectionGroupV1Schema } = await import('@happier-dev/protocol/rpc');
        const { AgentIcon } = await import('@/agents/registry/AgentIcon');
        const ref = { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: 'pc_deepseek', modelId: 'deepseek-v4-flash' };
        const group = DaemonProviderModelProjectionGroupV1Schema.parse({
            connectionId: ref.providerConnectionId, providerName: 'DeepSeek', connectionName: 'DeepSeek',
            connectionRole: 'named', connectionDisplayNameMode: 'custom', connectionRevision: 1,
            authorization: { authorized: true }, manualModelPolicy: 'allowed', supportsFreeformModelIds: false,
            suppressedConnectedServiceIds: [], modelLoadAction: 'descriptor_absent', modelLoadPreflightPolicy: null,
            rows: [{ ref, descriptor: { id: ref.modelId, name: 'DeepSeek V4 Flash' },
                sources: { manual: false, static: true, probe: false }, confidence: 'verified_static',
                compatibility: { result: { status: 'experimental', selectedProtocol: 'anthropic-messages',
                    reasons: ['compatibility_evidence_missing'], confirmationScope: { kind: 'model', modelId: ref.modelId } },
                    compatibilityFingerprint: 'compatibility:v1:deepseek', confirmed: true },
                endpointHealth: 'available', catalog: { stale: false }, loadState: 'unknown', visibility: 'visible' }],
        });
        const props = {
            ...panelProps(), agentType: 'claude', modelMode: ref.modelId,
            agentPickerOptions: [{ id: ref.agentTargetKey, label: 'Claude', icon: <AgentIcon agentId="claude" size={20} /> }],
            modelPickerPresentation: { declarationContext: { kind: 'account' as const }, agentTargetKey: ref.agentTargetKey, selected: group.rows[0]!.ref, nativeModels: [],
                providerGroups: [group], hiddenNativeModelKeys: new Set<string>(), providerProjectionAuthoritative: true,
                fallbackLabel: 'Loading model', fieldLabel: 'Model' },
        };
        const screen = await renderScreen(<NewSessionComposerCard panelProps={props} layout="screen" attachments={false} />);
        expect(screen.getTextContent()).toContain('DeepSeek V4 Flash');
        expect(screen.getTextContent()).not.toContain(ref.modelId);
        expect(screen.findByTestId('agent-input-agent-chip-logo')).not.toBeNull();
        await screen.update(<NewSessionComposerCard panelProps={{ ...props, modelPickerPresentation: {
            ...props.modelPickerPresentation, providerGroups: [{ ...group, rows: [{ ...group.rows[0]!, descriptor: {
                id: ref.modelId, name: 'DeepSeek Flash renamed',
            } }] }],
        } }} layout="screen" attachments={false} />);
        expect(screen.getTextContent()).toContain('DeepSeek Flash renamed');
        await screen.update(<NewSessionComposerCard panelProps={{ ...props, modelPickerPresentation: {
            ...props.modelPickerPresentation, providerGroups: [], providerProjectionAuthoritative: false,
        } }} layout="screen" attachments={false} />);
        expect(screen.getTextContent()).toContain(ref.modelId);
        expect(screen.getTextContent()).not.toContain('Loading model');
        await screen.update(<NewSessionComposerCard panelProps={{ ...props, modelPickerPresentation: {
            ...props.modelPickerPresentation, providerGroups: [], providerProjectionAuthoritative: true,
        } }} layout="screen" attachments={false} />);
        expect(screen.getTextContent()).toContain('Loading model');
        expect(screen.getTextContent()).not.toContain(ref.modelId);
    });
    it('allows an ordinary session to submit without an optional composer document', async () => {
        const props = panelProps();
        const screen = await renderScreen(<NewSessionComposerCard panelProps={props} layout="screen" attachments={false} />);
        expect(screen.findByTestId('new-session-composer-send')?.props.disabled).toBe(false);
        await screen.update(<NewSessionComposerCard panelProps={{ ...props, canCreate: false }} layout="screen" attachments={false} />);
        expect(screen.findByTestId('new-session-composer-send')?.props.disabled).toBe(true);
    });
    it('locks the typed prompt while the session is being created', async () => {
        const props = panelProps();
        const screen = await renderScreen(<NewSessionComposerCard panelProps={props} layout="screen" attachments={false} />);
        expect(screen.findByTestId('new-session-composer-input')?.props.editable).not.toBe(false);
        await screen.update(<NewSessionComposerCard panelProps={{ ...props, isCreating: true }} layout="screen" attachments={false} />);
        expect(screen.findByTestId('new-session-composer-input')?.props.editable).toBe(false);
    });
    it('keeps the card and its composer chrome out of a keystroke: only the text leaf follows the prompt store', async () => {
        const { AgentInput } = await import('@/components/sessions/agentInput');
        const props = panelProps();
        const screen = await renderScreen(<NewSessionComposerCard panelProps={props} layout="screen" attachments={false} />);
        const before = screen.findByType(AgentInput).props;
        await act(async () => { props.promptStore.setPrompt('Keep this brief, now longer'); });
        expect(screen.findByTestId('new-session-composer-input')?.props.value).toBe('Keep this brief, now longer');
        // A re-rendered card hands AgentInput a fresh props object (and fresh chip arrays).
        expect(screen.findByType(AgentInput).props).toBe(before);
    });
    it('retains the selected workflow and its inputs when the screen panel recomposes across phone width', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');
        const previous = getStorage().getState().profileScope;
        const props = { ...panelProps(), selectedMachineId: 'machine-1', targetServerId: 'server-a' };
        platformState.width = 1440;
        const restorePopoverGlobals = withPopoverWebGlobals();
        let cleanupScreen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            await act(async () => {
                getStorage().setState({ profileScope: { serverId: 'server-a', accountId: 'account-a' } });
            });
            const screen = await renderScreen(<NewSessionSimplePanel {...props} />, workflowPopoverOptions);
            cleanupScreen = screen;
            await openWorkflowPicker(screen);
            await screen.pressByTestIdAsync('workflow-choice:builtin:plan-with-a-panel');
            const input = screen.findByTestId('workflow-run-inputs');
            expect(input).not.toBeNull();
            for (const width of [390, 430, 1440]) {
                platformState.width = width;
                await screen.update(<NewSessionSimplePanel {...props} />);
                expect(screen.findByTestId('workflow-run-inputs')).toBe(input);
                expect(screen.findByTestId('new-session-composer-input')?.props.value).toBe('Keep this brief');
            }
        } finally {
            await cleanupScreen?.unmount();
            restorePopoverGlobals();
            platformState.width = 1440;
            await act(async () => { getStorage().setState({ profileScope: previous }); });
        }
    });
    it('keeps the admitted read-only document on the same floating material plane', async () => {
        const { AgentInput } = await import('@/components/sessions/agentInput');
        const store = getStorage();
        const previous = store.getState().settings;
        platformState.os = 'android';
        try {
            await act(async () => {
                store.setState({ settings: { ...previous, glassBlurEnabled: true, glassSurfaceMaterials: null } });
            });
            const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ nativeRenderer: true }}>
                <AgentInput value="Frozen document" placeholder="Document" surfaceGroup="floating"
                    autocompleteKinds={[]} autocompleteSuggestions={async () => []} />
            </GlassRuntimeEnvironmentProvider>);
            const surface = screen.findByTestId('agent-input-material-surface');
            expect(surface).not.toBeNull();
            expect(Color(flattenTestStyle(surface?.props.style).backgroundColor as string).alpha()).toBe(0.02);
            expect(screen.getTextContent()).toContain('Frozen document');
            expect(screen.findByTestId('new-session-composer-input')).toBeNull();
        } finally {
            platformState.os = 'web';
            await act(async () => { store.setState({ settings: previous }); });
        }
    });
    it('gives the phone floating composer its own material coat and restores solid when its group is off', async () => {
        const store = getStorage();
        const previous = store.getState().settings;
        platformState.os = 'android';
        try {
            await act(async () => {
                store.setState({ settings: { ...previous, glassBlurEnabled: true, glassSurfaceMaterials: null } });
            });
            const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ nativeRenderer: true }}>
                <NewSessionComposerCard panelProps={panelProps()} layout="screen" attachments={false} surfaceGroup="floating" />
            </GlassRuntimeEnvironmentProvider>);
            const surface = screen.findByTestId('agent-input-material-surface');
            expect(surface).not.toBeNull();
            expect(Color(flattenTestStyle(surface?.props.style).backgroundColor as string).alpha()).toBe(0.02);
            expect(screen.findByTestId('new-session-composer-input')?.props.value).toBe('Keep this brief');
            await act(async () => {
                store.setState({ settings: { ...previous, glassBlurEnabled: false, glassSurfaceMaterials: null } });
            });
            expect(Color(flattenTestStyle(screen.findByTestId('agent-input-material-surface')?.props.style).backgroundColor as string).alpha()).toBe(1);
            await act(async () => {
                store.setState({ settings: { ...previous, glassBlurEnabled: true, glassSurfaceMaterials: null } });
                screen.tree.update(<GlassRuntimeEnvironmentProvider value={{ nativeRenderer: true }}>
                    <NewSessionComposerCard panelProps={panelProps()} layout="screen" attachments={false} />
                </GlassRuntimeEnvironmentProvider>);
            });
            expect(Color(flattenTestStyle(screen.findByTestId('agent-input-material-surface')?.props.style).backgroundColor as string).alpha()).toBe(1);
        } finally {
            platformState.os = 'web';
            await act(async () => { store.setState({ settings: previous }); });
        }
    });
    it.each(['screen', 'embedded'] as const)('offers Workflow through the %s composer menu without replacing the plain-session prompt', async layout => {
        await withPopoverWebGlobals(async () => {
            const screen = await renderScreen(<NewSessionComposerCard panelProps={panelProps()} layout={layout} attachments={false} />, workflowPopoverOptions);
            await openWorkflowPicker(screen);
            expect(screen.findByTestId('workflow-choice:builtin:plan-with-a-panel')).not.toBeNull();
            expect(screen.findByTestId('new-session-composer-input')?.props.value).toBe('Keep this brief');
        });
    });
    it('lets an agent open, arm, change and remove the mounted Workflow through current-context commands', async () => {
        const { serveActionHomes } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
        const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://new-workflow-command.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const { renderMountedCurrentUiContext } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
        const { readCurrentUiContextActionReader } = await import('@/components/appShell/currentUiContext/currentUiContextActionRuntime');
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { ACTION_ID_FAMILIES_V1 } = await import('@happier-dev/protocol/actions/actionIds');
        try { await withPopoverWebGlobals(async () => {
            const screen = await renderMountedCurrentUiContext(<OverlayPortalProvider>
                <NewSessionComposerCard panelProps={panelProps()} layout="screen" attachments={false} /><OverlayPortalHost />
            </OverlayPortalProvider>, { createNodeMock: workflowPopoverOptions.createNodeMock });
            const executor = createDefaultActionExecutor();
            const invoke = async (description: string, input?: { id: string }) => {
                const commands = readCurrentUiContextActionReader({ surface: 'agent' })?.readCurrentUiContext()?.commands ?? [];
                const command = commands.find(row => row.description?.startsWith(description));
                expect(command, description).toBeDefined();
                await act(async () => { expect(await executor.execute(ACTION_ID_FAMILIES_V1.current_ui_context[1],
                    { commandId: command!.id, ...(input ? { input } : {}) }, { surface: 'agent' })).toMatchObject({ ok: true }); });
            };
            try {
                await invoke('new-session.workflow.open');
                expect(screen.findByTestId('workflow-choice:builtin:plan-with-a-panel')).not.toBeNull();
                await invoke('new-session.workflow.activate', { id: 'builtin:plan-with-a-panel' });
                expect(screen.findByTestId('new-session-workflow-remove')).not.toBeNull();
                const armedLabel = screen.findByTestId('new-session-workflow-chip')?.props.accessibilityLabel;
                expect(armedLabel).toEqual(expect.any(String));
                await invoke('new-session.workflow.open');
                await invoke('new-session.workflow.activate', { id: 'builtin:review-and-converge' });
                expect(screen.findByTestId('new-session-workflow-chip')?.props.accessibilityLabel).not.toBe(armedLabel);
                await invoke('new-session.workflow.remove');
                expect(screen.findByTestId('new-session-workflow-remove')).toBeNull();
                expect(screen.findByTestId('new-session-composer-input')?.props.value).toBe('Keep this brief');
            } finally { await screen.unmount(); }
        }); } finally { await home.dispose(); }
    });
    it('retains the floating material when a selected workflow replaces the phone composer', async () => {
        const store = getStorage();
        const previous = store.getState();
        platformState.os = 'android';
        try {
            await act(async () => {
                store.setState({ profileScope: { serverId: 'server-a', accountId: 'account-a' }, settings: { ...previous.settings, glassBlurEnabled: true, glassSurfaceMaterials: null } });
            });
            const props = { ...panelProps(), selectedMachineId: 'machine-1', targetServerId: 'server-a' };
            const hook = await renderHook(() => useNewSessionWorkflowStart({ panelProps: props, prompt: 'Keep this brief', surfaceGroup: 'floating' }));
            const content = hook.getCurrent().chip.collapsedContentPopover?.renderContent;
            if (typeof content !== 'function') throw new Error('Workflow picker content is missing');
            const pickerNode = content({ requestClose: () => {}, maxHeight: 420 });
            if (!React.isValidElement(pickerNode)) throw new Error('Workflow picker is missing');
            const picker = await renderScreen(pickerNode);
            await picker.pressByTestIdAsync('workflow-choice:builtin:plan-with-a-panel');
            const composer = hook.getCurrent().composer;
            if (composer === null) throw new Error('Selected workflow composer is missing');
            const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ nativeRenderer: true }}>
                {composer}
            </GlassRuntimeEnvironmentProvider>);
            expect(Color(flattenTestStyle(screen.findByTestId('agent-input-material-surface')?.props.style).backgroundColor as string).alpha()).toBe(0.02);
            expect(screen.findByTestId('new-session-composer-input')?.props.value).toBe('Keep this brief');
        } finally {
            platformState.os = 'web';
            await act(async () => { store.setState({ settings: previous.settings, profileScope: previous.profileScope }); });
        }
    });
    it('keeps typed text as the first text input, then withdraws that private draft on Account change', async () => {
        getStorage().setState({ profileScope: { serverId: 'server-a', accountId: 'account-a' } });
        const props = { ...panelProps(), selectedMachineId: 'machine-1', targetServerId: 'server-a' };
        const hook = await renderHook(() => useNewSessionWorkflowStart({ panelProps: props, prompt: 'Keep this brief' }));
        const content = hook.getCurrent().chip.collapsedContentPopover?.renderContent;
        if (typeof content !== 'function') throw new Error('Workflow picker content is missing');
        const pickerNode = content({ requestClose: () => {}, maxHeight: 420 });
        if (!React.isValidElement(pickerNode)) throw new Error('Workflow picker is missing');
        const picker = await renderScreen(pickerNode);
        await picker.pressByTestIdAsync('workflow-choice:builtin:plan-with-a-panel');
        const composer = hook.getCurrent().composer;
        if (composer === null) throw new Error('Selected workflow composer is missing');
        const screen = await renderScreen(composer);
        expect(screen.findByTestId('new-session-composer-input')?.props.value).toBe('Keep this brief');
        // No Home feature snapshot has advertised Workflow support in this fixture.
        expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(true);
        await act(async () => { getStorage().setState({ profileScope: { serverId: 'server-a', accountId: 'account-b' } }); });
        expect(hook.getCurrent().composer).toBeNull();
    });
});
