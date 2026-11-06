import { paneUiState } from '@/sync/domains/state/filePaneUiState';
import * as React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import {
    applyComposerPresentationTransaction,
    createComposerPresentationHostHandlers,
    readComposerPresentationSnapshot,
    readMountedComposerPresentationSnapshot,
} from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { ScopedAuthoringComposer } from '@/components/sessions/authoring/ScopedAuthoringComposer';
import type { PluginUiHostApiRequestEnvelopeV1 } from '@happier-dev/protocol/plugins/ui';
import { renderScreen as renderTestScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { serveAccountHomes, serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { ModalProvider, useModal } from '@/modal/ModalProvider';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { useWorkflowEditorHistory } from '../editor/useWorkflowEditorHistory';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { AppPaneProvider, useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import { AppPaneScopeHost } from '@/components/appShell/panes/AppPaneScopeHost';
import { getStorage } from '@/sync/domains/state/storageStore';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { AgentInput } from '@/components/sessions/agentInput';
import { createDeferred, withPopoverWebGlobals } from '@/dev/testkit';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { reportPopoverContentLayout } from '@/dev/testkit/harness/popoverHarness';
import { KeyboardShortcutProvider, useKeyboardCommand, type KeyboardCommandId } from '@/keyboard';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { getVitestNodeBuiltin } from '@/dev/vitestNodeBuiltins';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { NativeComposerInputHandle } from '@/components/ui/forms/nativeComposerInput';
import { createRenderCommitCounter } from '@/dev/testkit/performance/counts';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';

const editorCosts = vi.hoisted(() => ({
    views: new Map<string, ReturnType<typeof createRenderCommitCounter>>(),
    composers: new Set<ReturnType<typeof createRenderCommitCounter>>(),
}));

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();

type BrowserDocumentBoundary = Readonly<{ window: Readonly<{ document: Document; close(): void }> }>;
const { createRequire } = getVitestNodeBuiltin<typeof import('node:module')>('node:module');
const jsdomModule: unknown = createRequire(import.meta.url)('jsdom');
if (typeof jsdomModule !== 'object' || jsdomModule === null || !('JSDOM' in jsdomModule)
    || typeof jsdomModule.JSDOM !== 'function') throw new Error('Browser document SDK unavailable');
// jsdom has no package-owned TS declarations here; narrow its external constructor only.
const BrowserDocument = jsdomModule.JSDOM as new (html: string) => BrowserDocumentBoundary;
let announcementDocument: BrowserDocumentBoundary | undefined;
let announcementWrites: MockInstance<(value: string | null) => void>;
function readAnnouncements() {
    return announcementWrites.mock.calls.map(([value]) => value)
        .filter((value): value is string => typeof value === 'string' && value.length > 0);
}
const promptFocus = vi.fn();
/** Selections the real composer applies to its native input (an OS boundary). */
const promptSelection = vi.fn();
const bindingBoundaries: Array<() => Promise<void>> = [];
const retireEditorContents: Array<() => Promise<void>> = [];
let executeWorkflowCommand: (commandId: KeyboardCommandId) => boolean = () => false;
let restoreKeyboardWindow: (() => void) | undefined;
// The react-native mock is evaluated during the hoisted imports, so the window it reads is hoisted with it.
const viewport = vi.hoisted(() => ({ window: { width: 1200, height: 800 } }));
// These are fixture inputs to the real storage/pane owners, not pane decisions.
const paneState = {
    detailsAvailable: true,
    rightOpen: false,
};

function InitialPaneState({ children }: React.PropsWithChildren) {
    const { dispatch } = useAppPaneContext();
    const initiallyOpen = React.useRef(paneState.rightOpen).current;
    React.useLayoutEffect(() => {
        if (initiallyOpen) dispatch({ type: 'openRight', scopeId: 'workflow-editor', tabId: 'workflow-flow' });
    }, [dispatch, initiallyOpen]);
    return <>{children}</>;
}

function ObserveKeyboardCommands() {
    executeWorkflowCommand = useKeyboardCommand();
    return null;
}

type ModalEntries = ReturnType<typeof useModal>['state']['modals'];
function ObserveModalEntries({ observe }: Readonly<{ observe: (entries: ModalEntries) => void }>) {
    observe(useModal().state.modals);
    return null;
}

async function renderScreen(element: React.ReactElement, options?: Parameters<typeof renderTestScreen>[1]) {
    getStorage().setState({ localSettings: { ...getStorage().getState().localSettings,
        uiMultiPanePanelsEnabled: paneState.detailsAvailable } });
    const SuppliedWrapper = options?.wrapper;
    let modalEntries: ModalEntries = [];
    const observeModals = (entries: ModalEntries) => { modalEntries = entries; };
    const wrapper = ({ children }: React.PropsWithChildren) => <InjectedAuthProvider credentials={null}><ModalProvider>
        <ObserveModalEntries observe={observeModals} /><KeyboardShortcutProvider handlers={{}}>
        <ObserveKeyboardCommands /><AppPaneProvider><InitialPaneState>
        {SuppliedWrapper ? <SuppliedWrapper>{children}</SuppliedWrapper> : children}
    </InitialPaneState></AppPaneProvider></KeyboardShortcutProvider></ModalProvider></InjectedAuthProvider>;
    const screen = await renderTestScreen(element, { ...options, wrapper, createNodeMock: nativeElement => {
        const supplied = options?.createNodeMock?.(nativeElement);
        if (supplied !== null && supplied !== undefined) return supplied;
        // Test Renderer supplies no host geometry. Real Popovers need the same
        // anchor measurements the browser supplies before their controls are usable.
        if (nativeElement.type === 'View' || nativeElement.type === 'Pressable') return {
            addEventListener() {},
            removeEventListener() {},
            getBoundingClientRect: () => ({ left: 100, top: 100, width: Math.min(600, viewport.window.width), height: 40 }),
            measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) =>
                callback(100, 100, Math.min(600, viewport.window.width), 40),
        };
        // Native text refs are an OS boundary. The real AgentInput and
        // MultiTextInput own focus requests, restored selection and edits.
        if (nativeElement.type !== 'TextInput' && nativeElement.type !== 'HappierComposerInput') return null;
        const input = { focus: promptFocus, blur: () => {}, setSelection: promptSelection, setTextAndSelection: () => {},
            offsetAtPoint: async () => null, setDropCaret: () => {},
            measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) =>
                callback(0, 0, viewport.window.width, 0) } satisfies NativeComposerInputHandle;
        return { ...input, setNativeProps: () => {} };
    } });
    let retired = false;
    const retireContent = async () => {
        if (retired) return;
        retired = true;
        // The app's global providers outlive route contents. Retire the editor
        // while the real Modal manager still holds its presentation custody.
        await screen.update(<></>);
    };
    retireEditorContents.push(retireContent);
    const settlePopoverLayout = async () => {
        await act(async () => { reportPopoverContentLayout(screen, { width: Math.min(360, viewport.window.width), height: 320 }); });
        await flushHookEffects({ cycles: 2, frames: 1 });
    };
    return { ...screen, visibleModals: () => modalEntries.filter(entry => 'visible' in entry && entry.visible === true), retireContent,
        pressByTestIdAsync: async (testID: string) => {
            await settlePopoverLayout();
            await screen.pressByTestIdAsync(testID);
            await settlePopoverLayout();
        },
        unmount: async () => { await retireContent(); await screen.unmount(); } };
}

function stepComposer(screen: Awaited<ReturnType<typeof renderScreen>>, blockId: string) {
    const composer = screen.findAllByType(AgentInput).find(node => node.props.composerRef?.blockId === blockId);
    if (composer === undefined) throw new Error(`No mounted step composer ${blockId}`);
    return composer;
}

function composerProps(screen: Awaited<ReturnType<typeof renderScreen>>, blockId: string): React.ComponentProps<typeof AgentInput> {
    // The renderer erases props types; selecting the actual component establishes this boundary.
    return stepComposer(screen, blockId).props as React.ComponentProps<typeof AgentInput>;
}

function stepComposerRef(screen: Awaited<ReturnType<typeof renderScreen>>, blockId: string) {
    const ref = composerProps(screen, blockId).composerRef;
    if (ref?.kind !== 'workflowAuthoring') throw new Error(`Wrong composer address for ${blockId}`);
    return ref;
}

function stepDocumentRef(screen: Awaited<ReturnType<typeof renderScreen>>, blockId: string) {
    const composer = screen.findAllByType(ScopedAuthoringComposer).find(node => node.props.custody.ref.blockId === blockId);
    if (!composer) throw new Error(`No addressed step document ${blockId}`);
    return (composer.props as React.ComponentProps<typeof ScopedAuthoringComposer>).custody.ref;
}

const MACHINE_COMPOSER_SCOPE = {
    kind: 'machine' as const,
    machineId: 'machine-1',
    serverId: 'server-a',
    directory: '/Users/me/project',
    machineHomeDir: '/Users/me',
};

vi.mock('react-native', async () => {
    const React = await import('react');
    const { createRenderCommitCounter, useRenderCommitCounter } = await import('@/dev/testkit/performance/counts');
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const native = await createReactNativeWebMock({
        useWindowDimensions: () => viewport.window,
    });
    // Observe executions and layout commits at the native boundary. The real
    // editor, menus, composers, inspector and store subscriptions run beneath it.
    const View = React.forwardRef<React.ComponentRef<typeof native.View>, React.ComponentProps<typeof native.View>>((props, ref) => {
        const counter = React.useMemo(() => {
            const value = createRenderCommitCounter();
            if (props.testID) editorCosts.views.set(props.testID, value);
            if (props.testID === 'agent-input-composer') editorCosts.composers.add(value);
            return value;
        }, [props.testID]);
        useRenderCommitCounter(counter);
        return React.createElement(native.View, { ...props, ref });
    });
    return { ...native, View };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) });
});
// Native recycling is the boundary; the real SelectionList owns its rows and selection.
vi.mock('@legendapp/list/react-native', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/legendList')).createCapturingLegendListMock({
        original: await importOriginal<Record<string, unknown>>(), renderItems: true,
    }).module);
// Native navigation/focus is a system boundary.
vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});
// Native DOM presentation is external; the Modal registry, custody and components stay real.
vi.mock('@/utils/web/radixCjs', async () =>
    (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
// The renderer has no DOM roots. Keep the actual modal body below the portal SDK boundary.
vi.mock('@/utils/web/reactDomCjs', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/utils/web/reactDomCjs')>()),
    requireReactDOM: () => ({ createPortal: (children: React.ReactNode) => children }),
}));

beforeEach(() => {
    // A fresh page starts closed; earlier Flow cases persist their real pane intents.
    paneUiState.remove('workflow-editor');
    // Observe browser DOM writes below the real live-region/announcement owner.
    announcementDocument = new BrowserDocument('<!doctype html><html><body></body></html>');
    const document = announcementDocument.window.document;
    const region = document.createElement('div');
    region.setAttribute('data-happier-live-region', 'true');
    document.body.appendChild(region);
    announcementWrites = vi.spyOn(region, 'textContent', 'set');
    vi.stubGlobal('document', document);
    promptFocus.mockClear();
    executeWorkflowCommand = () => false;
    restoreKeyboardWindow = withPopoverWebGlobals();
    viewport.window = { width: 1200, height: 800 };
    paneState.detailsAvailable = true;
    paneState.rightOpen = false;
    getStorage().setState({ settings: settingsDefaults, localSettings: localSettingsDefaults });
});

// Module transform is paid once, outside any single case's time budget.
beforeAll(async () => {
    await loadSyncSingletonForTests();
    await loadHarness();
}, 300_000);

afterEach(async () => {
    for (const retire of retireEditorContents.splice(0)) await retire();
    await standardCleanup();
    paneUiState.remove('workflow-editor');
    for (const dispose of bindingBoundaries.splice(0)) await dispose();
    restoreKeyboardWindow?.();
    announcementDocument?.window.close();
    announcementDocument = undefined;
    vi.unstubAllGlobals();
});

async function bindingHome() {
    const boundary = await serveActionHomes({ homes: [{ key: 'workflow', serverUrl: 'https://workflow-binding.test', accountId: 'account-a' }], route: () => undefined });
    bindingBoundaries.push(() => boundary.dispose());
    return { serverId: boundary.homes.workflow!.id, accountId: 'account-a' };
}

const AGENT_TARGET = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };

async function loadHarness() {
    const body = await import('./WorkflowEditorBody');
    const draftModule = await import('@/sync/domains/workflows/workflowEditorDraft');
    const edits = await import('@happier-dev/protocol/workflows/workflowDefinitionEditV1');
    const authoring = await import('@/sync/domains/workflows/workflowAuthoring');
    return { ...body, ...draftModule, ...edits, ...authoring };
}

type Harness = Awaited<ReturnType<typeof loadHarness>>;

function buildDraft(harness: Harness, overrides: Partial<{ name: string; text: string }> = {}) {
    const base = harness.setWorkflowDefaultField(
        harness.createWorkflowEditorDraft({
            draftId: 'draft-1',
            name: overrides.name ?? 'Review',
            blocks: [{
                kind: 'step',
                id: 'analyze',
                document: { text: overrides.text ?? 'Analyze the repository', references: [], attachments: [] },
                input: [],
                result: { kind: 'text' },
            }],
        }),
        'agentTarget',
        AGENT_TARGET,
    );
    return base;
}

/** The SegmentedChoiceItem element behind a Conversation or Workspace segmented choice's test id prefix. */
function segmentedField(screen: Awaited<ReturnType<typeof renderScreen>>, testIDPrefix: string) {
    const match = screen.findAll((node) => node.props?.testIDPrefix === testIDPrefix && Array.isArray(node.props?.options)
        && typeof node.props?.onChange === 'function')[0];
    if (match === undefined) throw new Error(`No segmented choice ${testIDPrefix}`);
    return match as unknown as { props: {
        options: ReadonlyArray<Readonly<{ id: string; label: string; unavailableReason?: string }>>;
        value: string; subtitle?: unknown; onChange: (id: string) => void;
    } };
}

/** The DropdownMenu element (not its host View) behind a field-select test id. */
function dropdownField(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) {
    const match = screen.findAll((node) => node.props?.testID === testID && typeof node.props?.onSelect === 'function')[0];
    if (match === undefined) throw new Error(`No field select ${testID}`);
    return match as unknown as { props: { items: ReadonlyArray<Readonly<Record<string, unknown>>>; selectedId: string; onSelect: (id: string) => void } };
}

const OPEN_SETTINGS_GROUPS: ReadonlyMap<string, boolean> = new Map([
    ['where', true], ['agent', true], ['conversation', true], ['inputs', true],
]);


it.each(['session', 'detached_run'] as const)('shows the read-only execution target %s as a value and keeps the writable chooser (M7)', async executionTarget => {
    const harness = await loadHarness();
    const { WorkflowInspector } = await import('../editor/WorkflowInspector');
    const { resolveWorkflowRunAsTargets } = await import('../run/workflowRunAsTargets');
    const onChangeExecutionTarget = vi.fn();
    const props: React.ComponentProps<typeof WorkflowInspector> = {
        subject: { kind: 'workflow' }, presentation: 'pane', draft: buildDraft(harness), onChange: () => {},
        machineName: 'Studio', groupDisclosure: OPEN_SETTINGS_GROUPS, executionTarget,
        runAsTargets: resolveWorkflowRunAsTargets({ detachedExecutionRun: 'supported' }),
        onChangeExecutionTarget, testIDPrefix: 'execution-target',
    };
    const screen = await renderScreen(<WorkflowInspector {...props} documentEditable={false} />);
    expect(screen.findByTestId('execution-target-run-as-readonly')).not.toBeNull();
    expect(screen.getTextContent()).toContain('workflows.page.sections.eachStepRunsIn');
    expect(screen.getTextContent()).toContain(executionTarget === 'session'
        ? 'workflows.page.sections.aSession' : 'workflows.page.sections.aBackgroundRun');
    expect(screen.findByTestId('execution-target-run-as:session')).toBeNull();
    expect(screen.findByTestId('execution-target-run-as:detached_run')).toBeNull();
    expect(onChangeExecutionTarget).not.toHaveBeenCalled();

    await screen.update(<WorkflowInspector {...props} documentEditable />);
    expect(screen.findByTestId('execution-target-run-as-readonly')).toBeNull();
    expect(screen.findByTestId('execution-target-run-as:session')).not.toBeNull();
    expect(screen.findByTestId('execution-target-run-as:detached_run')).not.toBeNull();
    const nextTarget = executionTarget === 'session' ? 'detached_run' : 'session';
    await screen.pressByTestIdAsync(`execution-target-run-as:${nextTarget}`);
    expect(onChangeExecutionTarget).toHaveBeenCalledWith(nextTarget);
});

it('keeps closed workflow and step summaries on the exact admitted Home name without chooser options', async () => {
    const harness = await loadHarness();
    const { WorkflowInspector } = await import('../editor/WorkflowInspector');
    const { WorkflowContinuityControls } = await import('../editor/WorkflowContinuityControls');
    const { WorkflowAccountLifetimeProvider } = await import('../workflowAccountScope');
    const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
    const { createSessionFixture } = await import('@/dev/testkit');
    const homes = await serveAccountHomes({ homes: [
        { key: 'addressed', serverUrl: 'https://workflow-summary-addressed.test', accountId: 'summary-addressed' },
        { key: 'focused', serverUrl: 'https://workflow-summary-focused.test', accountId: 'summary-focused' },
    ], route: request => ['/v2/sessions', '/v2/sessions/active', '/v2/sessions/archived'].includes(request.path)
        ? Response.json({ sessions: [], nextCursor: null, hasNext: false }) : undefined });
    bindingBoundaries.push(() => homes.dispose());
    const serverId = homes.homes.addressed!.id;
    const sessionId = 'selected-summary';
    const addressed = createSessionFixture({ id: sessionId, serverId, metadata: {
        ...createSessionFixture().metadata!, name: 'Addressed name', machineId: 'machine-1',
    } });
    const focused = { ...addressed, serverId: homes.homes.focused!.id, metadata: { ...addressed.metadata!, name: 'Wrong Home name' } };
    getStorage().setState({ isDataReady: true, sessions: { [sessionId]: focused },
        sessionListRowsByServerId: { [serverId]: { [sessionId]: addressed }, [focused.serverId!]: { [sessionId]: focused } } });
    const draft = harness.setWorkflowDefaultField(buildDraft(harness), 'conversation', { kind: 'existing_session', sessionId, machineId: 'machine-1' });
    let bound = false;
    let firstBinding: ReturnType<typeof useServerCredentialAccountScopeBinding>['binding'] = null;
    function Summary({ admitted, retained = false }: { admitted: boolean; retained?: boolean }) {
        const { binding } = useServerCredentialAccountScopeBinding(serverId);
        bound = Boolean(binding);
        if (binding && !firstBinding) firstBinding = binding;
        const props = { draft, onChange: () => {}, existingSessions: [{ sessionId, machineId: 'machine-1', label: 'Stale option name' }],
            machineName: 'Studio', documentEditable: false };
        return <WorkflowAccountLifetimeProvider value={admitted ? (retained ? firstBinding : binding) ?? null : null}>
            <WorkflowInspector {...props} subject={{ kind: 'workflow' }} presentation="pane" testIDPrefix="closed-default" />
            <WorkflowInspector {...props} subject={{ kind: 'block', blockId: 'analyze' }} presentation="popover" testIDPrefix="closed-step" />
            <WorkflowContinuityControls draft={draft} conversation={undefined} workspace={undefined}
                inherited={{ conversation: draft.defaults.conversation, workspace: draft.defaults.workspace }}
                existingSessions={props.existingSessions} onChangeConversation={() => {}} onChangeWorkspace={() => {}}
                testIDPrefix="closed-inherited" />
        </WorkflowAccountLifetimeProvider>;
    }
    const screen = await renderScreen(<Summary admitted />);
    await waitForHomeGovernance(() => expect(bound).toBe(true));
    expect(screen.getTextContent()).toContain('Addressed name');
    expect(screen.getTextContent()).not.toContain('Wrong Home name');
    expect(screen.getTextContent()).not.toContain('Stale option name');
    await act(async () => { getStorage().setState(state => ({ sessionListRowsByServerId: {
        ...state.sessionListRowsByServerId, [serverId]: { [sessionId]: { ...addressed, metadata: { ...addressed.metadata!, name: 'Current addressed name' } } },
    } })); });
    expect(screen.getTextContent()).toContain('Current addressed name');
    expect(screen.getTextContent()).not.toContain('Wrong Home name');
    expect(screen.getTextContent()).not.toContain('Stale option name');
    const locked = { ...addressed, metadata: null, ownerMetadataView: null, encryptionMode: 'e2ee' as const,
        encryptedContentAvailability: 'encrypted_content_unavailable' as const };
    await act(async () => { getStorage().setState(state => ({ sessionListRowsByServerId: {
        ...state.sessionListRowsByServerId, [serverId]: { [sessionId]: locked },
    } })); });
    expect(screen.getTextContent()).not.toContain('Current addressed name');
    expect(screen.getTextContent()).not.toContain('Stale option name');
    expect(screen.getTextContent()).not.toContain('Wrong Home name');
    await act(async () => { getStorage().setState(state => ({ sessionListRowsByServerId: {
        ...state.sessionListRowsByServerId, [serverId]: {},
    } })); });
    expect(screen.getTextContent()).not.toContain('Stale option name');
    expect(screen.getTextContent()).not.toContain('Wrong Home name');
    await act(async () => { getStorage().setState(state => ({ sessionListRowsByServerId: {
        ...state.sessionListRowsByServerId, [serverId]: { [sessionId]: addressed },
    } })); });
    await screen.update(<Summary admitted retained />);
    await act(async () => { await homes.switchAccount('addressed', 'summary-replacement'); });
    await waitForHomeGovernance(() => expect(firstBinding?.isCurrent()).toBe(false));
    expect(screen.getTextContent()).not.toContain('Addressed name');
    expect(screen.getTextContent()).not.toContain('Stale option name');
    expect(screen.getTextContent()).not.toContain('Wrong Home name');
    await screen.update(<Summary admitted={false} />);
    expect(screen.getTextContent()).not.toContain('Current addressed name');
    expect(screen.getTextContent()).not.toContain('Wrong Home name');
    expect(screen.getTextContent()).not.toContain('Stale option name');
    await screen.unmount();
});

async function renderBody(
    harness: Harness,
    overrides: Record<string, unknown> = {},
    renderOptions?: Parameters<typeof renderScreen>[1],
) {
    const draft = (overrides.draft as ReturnType<typeof buildDraft>) ?? buildDraft(harness);
    const element = React.createElement(harness.WorkflowEditorBody, {
        draft,
        onChange: () => {},
        machineName: 'Mac Studio',
        composerScope: MACHINE_COMPOSER_SCOPE,
        selectedBlockId: null,
        onSelectBlock: () => {},
        onCustomizeBlock: () => {},
        view: 'steps',
        onChangeView: () => {},
        // Content cases read the settings rows; the quiet-by-default rule has its own case.
        inspectorGroupDisclosure: OPEN_SETTINGS_GROUPS,
        ...overrides,
    } as never);
    return renderScreen(element, renderOptions);
}

it.each(['root', 'nested'] as const)('opens and closes Step options through every real %s block control', async location => {
    const harness = await loadHarness();
    const { WorkflowInspector } = await import('../editor/WorkflowInspector');
    const assigned = new Set<string>();
    const retain = (block: ReturnType<Harness['createWorkflowBlock']>) => {
        for (const id of harness.collectWorkflowBlockIds({ ...buildDraft(harness), blocks: [block] })) assigned.add(id);
        return block;
    };
    const blocks = [
        retain(harness.createWorkflowLeafBlock({ kind: 'wait' }, assigned)),
        retain(harness.createWorkflowBlock('step', assigned)),
        retain(harness.createWorkflowLeafBlock({ kind: 'action', actionId: 'notifications.notify_me' }, assigned)),
        retain(harness.createWorkflowLeafBlock({ kind: 'workflow', workflowRef: 'builtin:review-and-converge' }, assigned)),
        ...(['parallel', 'loop', 'if'] as const).map(kind => retain(harness.createWorkflowBlock(kind, assigned))),
    ];
    for (const evaluatorKind of ['step', 'action'] as const) {
        const loop = retain(harness.createWorkflowBlock('loop', assigned));
        const evaluator = retain(evaluatorKind === 'step' ? harness.createWorkflowBlock('step', assigned)
            : harness.createWorkflowLeafBlock({ kind: 'action', actionId: 'notifications.notify_me' }, assigned));
        if (loop.kind !== 'loop' || (evaluator.kind !== 'step' && evaluator.kind !== 'action')) throw new Error('Wrong evaluator factory kind');
        blocks.push({ ...loop, repetition: { kind: 'evaluate', maxIterations: 2, history: 'latest', evaluator } });
    }
    let draft = { ...buildDraft(harness), blocks };
    if (location === 'nested') {
        const conditional = retain(harness.createWorkflowBlock('if', assigned));
        const loop = retain(harness.createWorkflowBlock('loop', assigned));
        const parallel = retain(harness.createWorkflowBlock('parallel', assigned));
        if (conditional.kind !== 'if' || loop.kind !== 'loop' || parallel.kind !== 'parallel') throw new Error('Wrong block factory kind');
        draft = { ...draft, blocks: [{ ...parallel, branches: [{ ...parallel.branches[0]!, blocks: [
            { ...loop, body: [{ ...conditional, then: blocks,
                otherwise: [retain(harness.createWorkflowLeafBlock({ kind: 'wait' }, assigned))] }] },
        ] }] }] };
    }
    const screen = await renderBody(harness, { draft });
    for (const block of harness.walkWorkflowBlocks(draft.blocks)) {
        const suffix = block.kind === 'step' ? 'customize'
            : block.kind === 'parallel' || block.kind === 'loop' || block.kind === 'if' ? 'summary' : 'options';
        const control = `workflow-editor-${block.kind}-${block.id}-${suffix}`;
        expect(screen.findHostByTestId(control), `visible Step options for ${location} ${block.kind} ${block.id}`).not.toBeNull();
        await screen.pressByTestIdAsync(control);
        expect(screen.findHostByTestId('workflow-editor-inspector-options')).not.toBeNull();
        expect(screen.findAllByType(WorkflowInspector).some(node => node.props.subject?.kind === 'block'
            && node.props.subject.blockId === block.id)).toBe(true);
        await screen.pressByTestIdAsync('workflow-editor-inspector-done');
        expect(screen.findHostByTestId('workflow-editor-inspector-options')).toBeNull();
        expect(screen.findHostByTestId(control)).not.toBeNull();
    }
    await screen.unmount();
});

/** Unrelated-publication selector evaluations by root count, so the larger cases can compare slopes. */
const unrelatedSelectorWorkByRoots = new Map<number, number>();

/** Activates a prompt's static picture the way a press does; the live composer replaces it. */
async function activatePromptPreview(screen: Awaited<ReturnType<typeof renderScreen>>, promptTestID: string) {
    const field = screen.findHostByTestId(promptTestID)!.findAll(node =>
        node.props.testID === 'agent-input-document-preview-field' && typeof node.props.onPress === 'function').at(0);
    if (field === undefined) throw new Error(`No prompt picture in ${promptTestID}`);
    await act(async () => field.props.onPress());
    await flushHookEffects();
}

function liveComposerCount(screen: Awaited<ReturnType<typeof renderScreen>>) {
    return screen.findAll(node => typeof node.type === 'string' && node.props.testID === 'agent-input-composer').length;
}

it.each([8, 100, 500])('measures the real %s-root editor: one live composer for the prompt being edited', async count => {
    const harness = await loadHarness();
    const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
    const telemetryEnabled = syncPerformanceTelemetry.isEnabled();
    syncPerformanceTelemetry.configure({ enabled: true });
    const { useWorkflowAuthoringHost } = await import('./useWorkflowAuthoringHost');
    const serverId = 'fix210-editor-home';
    let machineComparisons = 0;
    const machines = Array.from({ length: 100 }, (_, index) => createMachineFixture({ id: `diag185-machine-${index}` }));
    for (const machine of machines) {
        const id = machine.id;
        Object.defineProperty(machine, 'id', { get: () => { machineComparisons += 1; return id; } });
    }
    getStorage().setState({ machines: {}, machineListByServerId: { [serverId]: machines },
        machineListStatusByServerId: { [serverId]: 'idle' } });
    const initial = harness.createWorkflowEditorDraft({ draftId: 'diag185', name: 'Review', blocks: Array.from({ length: count }, (_, index) => ({
        kind: 'wait', id: `diag185-${index}`, document: { text: 'Review', references: [], attachments: [] },
    })) });
    let current = initial;
    let commits = 0;
    const stringifies = vi.spyOn(JSON, 'stringify');
    function Controlled() {
        const [draft, setDraft] = React.useState(initial);
        const [selected, select] = React.useState<string | null>(null);
        const host = useWorkflowAuthoringHost({ serverId, projectTarget: { machineId: 'diag185-machine-0', directory: '/repo' } });
        expect(host.composerScope).toMatchObject({ kind: 'machine', machineId: 'diag185-machine-0',
            serverId, machineHomeDir: '/Users/tester' });
        expect(host.authoringFacts.machineName).toBe('tester.local');
        current = draft;
        return <React.Profiler id="DIAG185" onRender={() => { commits += 1; }}>
            <harness.WorkflowEditorBody draft={draft} onChange={setDraft} machineName="Mac Studio"
                {...host} selectedBlockId={selected} onSelectBlock={select}
                onCustomizeBlock={select} view="steps" onChangeView={() => {}} onSave={() => {}} />
        </React.Profiler>;
    }
    editorCosts.views.clear();
    editorCosts.composers.clear();
    const screen = await renderScreen(<Controlled />);
    await flushHookEffects();
    const measure = (phase: string) => {
        const rows = [...editorCosts.views].filter(([id]) => /^workflow-editor-wait-diag185-\d+$/.test(id));
        const result = { phase, roots: count, commits, machineComparisons,
            mountedComposers: editorCosts.composers.size,
            unaffectedComposerExecutions: [...editorCosts.composers].slice(1)
                .reduce((sum, counter) => sum + counter.read().renders, 0),
            viewFibers: [...editorCosts.views.values()].reduce((sum, counter) => sum + counter.read().renders, 0),
            rowFibers: rows.reduce((sum, [, counter]) => sum + counter.read().renders, 0),
            unaffectedRowFibers: rows.filter(([id]) => id !== 'workflow-editor-wait-diag185-0')
                .reduce((sum, [, counter]) => sum + counter.read().renders, 0),
            unrelatedGapFibers: [...editorCosts.views].filter(([id]) => /^workflow-editor-gap-diag185-\d+$/.test(id))
                .reduce((sum, [, counter]) => sum + counter.read().renders, 0),
            menuSerializations: stringifies.mock.calls.filter(([value]) => Array.isArray(value)
                && value.some(item => item?.id === 'duplicate' && typeof item?.label === 'string')).length };
        console.info('DIAG185 real editor cost', result);
        commits = 0;
        machineComparisons = 0;
        for (const counter of editorCosts.views.values()) counter.reset();
        for (const counter of editorCosts.composers) counter.reset();
        stringifies.mockClear();
        return result;
    };
    const mount = measure('mount');
    expect(mount.rowFibers).toBeGreaterThanOrEqual(count);
    // Nobody is editing yet: every prompt is its picture, none mounts the composer.
    expect(mount.mountedComposers).toBe(0);
    expect(screen.findAll(node => typeof node.type === 'string' && node.props.testID === 'agent-input-document-preview')).toHaveLength(count);
    await activatePromptPreview(screen, 'workflow-editor-wait-diag185-0-prompt');
    const activation = measure('activation');
    expect(activation.mountedComposers).toBe(1);
    expect(liveComposerCount(screen)).toBe(1);
    expect(promptFocus).toHaveBeenCalled();
    const input = screen.findHostByTestId('workflow-editor-wait-diag185-0-prompt')!.findAll(node =>
        node.props.testID === 'new-session-composer-input' && typeof node.props.onChange === 'function').at(-1)!;
    await act(async () => input.props.onChange({ nativeEvent: {
        text: 'Reviewx', selection: { start: 7, end: 7 }, eventCount: 1, references: [],
    } }));
    await flushHookEffects();
    expect(current.blocks[0]?.kind === 'wait' && current.blocks[0].document.text).toBe('Reviewx');
    const key = measure('keystroke');
    expect(key.unaffectedComposerExecutions).toBe(0);
    await screen.pressByTestIdAsync('workflow-editor-wait-diag185-0-options');
    await flushHookEffects();
    const inspector = measure('selection-and-inspector');
    expect(inspector.unaffectedRowFibers).toBe(0);
    expect(inspector.unrelatedGapFibers).toBe(0);
    expect(inspector.menuSerializations).toBeLessThanOrEqual(1);
    expect(inspector.unaffectedComposerExecutions).toBe(0);
    // Settings are a real authoring-facts input, but Wait cards and their gaps
    // do not display the composer's Enter-to-send preference.
    await act(async () => getStorage().setState(state => ({ settings: {
        ...state.settings, agentInputEnterToSend: !state.settings.agentInputEnterToSend,
    } })));
    await flushHookEffects();
    const settings = measure('unrelated-settings-change');
    expect(settings.unaffectedRowFibers).toBe(0);
    expect(settings.unrelatedGapFibers).toBe(0);
    // An unrelated root publication leaves every exact-Machine input unchanged.
    syncPerformanceTelemetry.reset();
    await act(async () => getStorage().setState(state => ({ isDataReady: !state.isDataReady })));
    await flushHookEffects();
    const selectorWork = syncPerformanceTelemetry.snapshot().events
        .filter(event => event.name.startsWith('sync.store.storage.selector.'))
        .reduce((sum, event) => sum + event.count, 0);
    const publication = measure('unrelated-store-publication');
    console.info('UI-EDITORROWS unrelated publication selector work', { roots: count, selectorWork,
        byName: Object.fromEntries(syncPerformanceTelemetry.snapshot().events
            .filter(event => event.name.startsWith('sync.store.storage.selector.') && event.count >= count)
            .map(event => [event.name.slice('sync.store.storage.selector.'.length), event.count])) });
    unrelatedSelectorWorkByRoots.set(count, selectorWork);
    syncPerformanceTelemetry.configure({ enabled: telemetryEnabled });
    syncPerformanceTelemetry.reset();
    // The eager editor cost 46 selector evaluations per root + 43 (DIAG188). A picture row keeps the
    // row chrome's own (heading text, menus) plus its material and placement reads: about 15.
    expect(selectorWork).toBeLessThan(46 * count + 43);
    const fewer = [...unrelatedSelectorWorkByRoots].filter(([roots]) => roots < count);
    for (const [roots, work] of fewer) expect((selectorWork - work) / (count - roots)).toBeLessThan(20);
    stringifies.mockRestore();
    expect(key.commits).toBe(1);
    expect(key.unaffectedRowFibers).toBe(0);
    expect(key.unrelatedGapFibers).toBe(0);
    expect(key.menuSerializations).toBe(0);
    expect(publication.commits).toBe(0);
    expect(publication.machineComparisons).toBe(0);
    // Editing the next prompt moves the one live composer; the first keeps its text as a picture.
    await activatePromptPreview(screen, 'workflow-editor-wait-diag185-1-prompt');
    expect(liveComposerCount(screen)).toBe(1);
    const firstPicture = screen.findHostByTestId('workflow-editor-wait-diag185-0-prompt')!
        .findAll(node => node.props.testID === 'agent-input-document-preview-text').at(0);
    expect(firstPicture?.props.children).toContain('Reviewx');
    const sibling = screen.findHostByTestId('workflow-editor-wait-diag185-1-prompt')!.findAll(node =>
        node.props.testID === 'new-session-composer-input' && typeof node.props.onChange === 'function').at(-1)!;
    await act(async () => sibling.props.onChange({ nativeEvent: {
        text: 'Reviewy', selection: { start: 7, end: 7 }, eventCount: 1, references: [],
    } }));
    await flushHookEffects();
    expect(current.blocks[0]?.kind === 'wait' && current.blocks[0].document.text).toBe('Reviewx');
    expect(current.blocks[1]?.kind === 'wait' && current.blocks[1].document.text).toBe('Reviewy');
    await screen.unmount();
});

it.each(['chooser', 'drag'] as const)('acquires unopened Session options only on this editor\'s %s intent', async (intent) => {
    const harness = await loadHarness();
    const { useWorkflowAuthoringHost } = await import('./useWorkflowAuthoringHost');
    const { WorkflowAccountLifetimeProvider } = await import('../workflowAccountScope');
    const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
    const { useEntityDragDropRuntime } = await import('@/components/ui/treeDragDrop');
    const metadata = { flavor: 'claude', claudeSessionId: 'resume', claudeTranscriptPath: '/tmp/session.jsonl',
        machineId: 'machine-1', path: '/Users/me/project', host: 'host', name: 'Unopened continuation' };
    const session = createPlainSessionCurrentProjectionRecordFixture({ id: 'unopened', active: true, metadata });
    const elsewhere = createPlainSessionCurrentProjectionRecordFixture({ id: 'elsewhere', active: true,
        metadata: { ...metadata, machineId: 'machine-2', name: 'Other machine' } });
    const batch = createSessionReadBatchHttpBoundary(request => {
        const record = [session, elsewhere].find(row => request.path === `/v2/sessions/${row.id}`);
        return record ? Response.json({ session: record }) : undefined;
    });
    const homes = await serveAccountHomes({ homes: [
        { key: 'editor', serverUrl: 'https://workflow-intent.test', accountId: 'intent-account' },
        { key: 'other', serverUrl: 'https://workflow-other-intent.test', accountId: 'other-account' },
        { key: 'focused', serverUrl: 'https://workflow-focused-intent.test', accountId: 'focused-account' },
    ], route: request => {
        if (request.path === '/v2/sessions') return Response.json({ sessions: request.home === 'focused' ? [] : [session, elsewhere], nextCursor: null, hasNext: false });
        if (request.path === '/v2/sessions/active' || request.path === '/v2/sessions/archived') {
            return Response.json({ sessions: [], nextCursor: null, hasNext: false });
        }
        return batch.handle(request);
    } });
    bindingBoundaries.push(() => homes.dispose());
    getStorage().setState({ isDataReady: true, sessions: {}, sessionListRowsByServerId: {} });
    // Account restore legitimately bootstraps the focused Home before an editor mounts.
    const beforeMount = homes.requests.length;
    const editorRequests = () => homes.requests.slice(beforeMount);
    const hosts = new Map<string, ReturnType<typeof useWorkflowAuthoringHost>>();
    let runtime: ReturnType<typeof useEntityDragDropRuntime>;
    function Editor({ serverId, prefix }: { serverId: string; prefix: string }) {
        const host = useWorkflowAuthoringHost({ serverId, projectTarget: { machineId: 'machine-1', directory: '/Users/me/project' } });
        hosts.set(prefix, host);
        runtime = useEntityDragDropRuntime();
        return <harness.WorkflowEditorBody {...host} draft={{ ...buildDraft(harness), draftId: prefix }} onChange={() => {}}
            machineName="Mac Studio" projectTarget={{ machineId: 'machine-1', directory: '/Users/me/project' }}
            selectedBlockId={null} onSelectBlock={() => {}} onCustomizeBlock={() => {}}
            view="steps" onChangeView={() => {}} testIDPrefix={prefix} inspectorGroupDisclosure={OPEN_SETTINGS_GROUPS} />;
    }
    function AddressedEditor(props: { serverId: string; prefix: string }) {
        const { binding } = useServerCredentialAccountScopeBinding(props.serverId);
        return <WorkflowAccountLifetimeProvider value={binding ?? null}><Editor {...props} /></WorkflowAccountLifetimeProvider>;
    }
    const serverId = homes.homes.editor!.id;
    const screen = await renderScreen(<><AddressedEditor serverId={serverId} prefix="demanded" />
        <AddressedEditor serverId={homes.homes.other!.id} prefix="closed" /></>);
    await waitForHomeGovernance(() => expect(hosts.get('demanded')?.sessionBindingScope?.serverId).toBe(serverId));
    expect(editorRequests().filter(request => request.home !== 'focused' && request.path === '/v2/sessions')).toHaveLength(0);
    expect(batch.componentRequests).toHaveLength(0);
    const scope = hosts.get('demanded')!.sessionBindingScope!;
    let retireSource: (() => void) | undefined;
    try {
        if (intent === 'chooser') {
            const choice = segmentedField(screen, 'demanded-defaults-continuity-conversation');
            await act(async () => { choice.props.onChange('continue'); });
        } else {
            retireSource = runtime!.registerSource({ id: 'intent-source', scope, isCurrent: () => true,
                getItem: () => ({ kind: 'session', scope, address: { serverId, sessionId: session.id } }) });
            await act(async () => {
                const target = runtime!.getDestinations('intent-source').find(destination => destination.label === 'workflows.editor.addStep')!;
                runtime!.begin('intent-source', 'keyboard')!.choose(target.targetId);
            });
        }
        await waitForHomeGovernance(() => expect(hosts.get('demanded')?.existingSessions.map(option => option.sessionId)).toEqual([session.id]));
        expect(hosts.get('demanded')?.sessionDropCandidates.map(option => option.sessionId).sort()).toEqual([elsewhere.id, session.id]);
        expect(editorRequests().some(request => request.home === 'other' && request.path === '/v2/sessions')).toBe(false);
        expect(getStorage().getState().sessions[session.id]).toBeUndefined();
        if (intent === 'chooser') {
            expect(screen.findHostByTestId('demanded-defaults-continuity-conversation-session-unopened')).not.toBeNull();
        } else {
            await flushHookEffects();
            expect(runtime!.getSnapshot().admission?.status, JSON.stringify(runtime!.getSnapshot().admission)).toBe('allowed');
        }
    } finally {
        await act(async () => { runtime!.cancel(); retireSource?.(); });
        await screen.unmount();
    }
});

/** Keep credential authority, inventory, snapshot acquisition and rendered inspectors real. */
async function renderChooserLifetimeEditor() {
    const harness = await loadHarness();
    const { useWorkflowAuthoringHost } = await import('./useWorkflowAuthoringHost');
    const { WorkflowAccountLifetimeProvider } = await import('../workflowAccountScope');
    const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
    const { useEntityDragDropRuntime } = await import('@/components/ui/treeDragDrop');
    const { SelectionList } = await import('@/components/ui/selectionList/SelectionList');
    const session = createPlainSessionCurrentProjectionRecordFixture({ id: 'continuation-c', active: true,
        metadata: { flavor: 'claude', claudeSessionId: 'resume-c', claudeTranscriptPath: '/tmp/c.jsonl',
            machineId: 'machine-1', path: '/Users/me/project', host: 'host', name: 'Continuation C' } });
    let failSnapshot = false;
    let snapshotGate: ReturnType<typeof createDeferred<void>> | undefined;
    const batch = createSessionReadBatchHttpBoundary(async request => {
        if (request.path !== `/v2/sessions/${session.id}`) return undefined;
        await snapshotGate?.promise;
        return failSnapshot ? Response.json({ error: 'unavailable' }, { status: 503 }) : Response.json({ session });
    });
    const homes = await serveAccountHomes({ homes: [
        { key: 'editor', serverUrl: 'https://chooser-lifetime.test', accountId: 'chooser-account' },
        { key: 'other', serverUrl: 'https://chooser-other.test', accountId: 'other-account' },
        { key: 'focused', serverUrl: 'https://chooser-focused.test', accountId: 'focused-account' },
    ], route: request => {
        if (request.path === '/v2/sessions') return Response.json({ sessions: request.home === 'focused' ? [] : [session], nextCursor: null, hasNext: false });
        if (request.path === '/v2/sessions/active' || request.path === '/v2/sessions/archived') {
            return Response.json({ sessions: [], nextCursor: null, hasNext: false });
        }
        return batch.handle(request);
    } });
    bindingBoundaries.push(() => homes.dispose());
    getStorage().setState({ isDataReady: true, sessions: {}, sessionListRowsByServerId: {} });
    let host!: ReturnType<typeof useWorkflowAuthoringHost>;
    let runtime!: ReturnType<typeof useEntityDragDropRuntime>;
    let changeMachine!: (machineId: string) => void;
    function Editor({ serverId }: { serverId: string }) {
        const [machineId, setMachineId] = React.useState('machine-1');
        changeMachine = setMachineId;
        const projectTarget = { machineId, directory: '/Users/me/project' };
        host = useWorkflowAuthoringHost({ serverId, projectTarget });
        runtime = useEntityDragDropRuntime();
        const [draft, setDraft] = React.useState(() => buildDraft(harness));
        return <harness.WorkflowEditorBody {...host} draft={draft} onChange={setDraft}
            machineName="Mac Studio" projectTarget={projectTarget}
            selectedBlockId="analyze" onSelectBlock={() => {}} onCustomizeBlock={() => {}}
            view="steps" onChangeView={() => {}} inspectorGroupDisclosure={OPEN_SETTINGS_GROUPS} />;
    }
    function AddressedEditor({ serverId }: { serverId: string }) {
        const { binding } = useServerCredentialAccountScopeBinding(serverId);
        return <WorkflowAccountLifetimeProvider value={binding ?? null}><Editor serverId={serverId} /></WorkflowAccountLifetimeProvider>;
    }
    const serverId = homes.homes.editor!.id;
    const screen = await renderScreen(<AddressedEditor serverId={serverId} />);
    await waitForHomeGovernance(() => expect(host.sessionBindingScope?.serverId).toBe(serverId));
    const defaults = 'workflow-editor-defaults-continuity';
    const step = 'workflow-editor-inspector-continuity';
    const menu = (prefix: string) => segmentedField(screen, `${prefix}-conversation`);
    const picker = (prefix: string) => screen.findAllByType(SelectionList).find(node => node.props.testID === `${prefix}-conversation-session-picker`);
    const reads = () => batch.componentRequests.filter(request => request.path === `/v2/sessions/${session.id}`).length;
    let version = 1;
    const refresh = async (patch: Readonly<Record<string, unknown>> = {}) => {
        await act(async () => { getStorage().getState().applyServerScopedSessionListRowPatches(serverId,
            [{ sessionId: session.id, patch: { metadataVersion: ++version, ...patch } }]); });
        await flushHookEffects();
    };
    const open = async (prefix = defaults) => {
        await act(async () => { menu(prefix).props.onChange('continue'); });
        await waitForHomeGovernance(() => expect(host.existingSessions.map(option => option.sessionId)).toEqual([session.id]));
        expect(picker(prefix)).toBeDefined();
    };
    return { screen, homes, serverId, defaults, step, open, menu, picker, reads, refresh,
        host: () => host, runtime: () => runtime,
        fail: () => { failSnapshot = true; },
        block: () => { snapshotGate = createDeferred<void>(); return snapshotGate; },
        changeMachine: (machineId: string) => act(async () => { changeMachine(machineId); }),
        switchHome: () => screen.update(<AddressedEditor serverId={homes.homes.other!.id} />),
    };
}

it.each(['archive', 'remove', 'failure', 'kind switch', 'dismiss', 'bind'] as const)(
    'retires this chooser demand after %s without restarting detailed reads', async transition => {
        const editor = await renderChooserLifetimeEditor();
        await editor.open();
        const originalRows = Object.values(getStorage().getState().sessionListRowsByServerId[editor.serverId] ?? {});
        if (transition === 'archive') await editor.refresh({ archivedAt: 42 });
        else if (transition === 'remove') await act(async () => { getStorage().getState().clearSessionListRowsForServerScope(editor.serverId); });
        else if (transition === 'failure') {
            editor.fail();
            await editor.refresh();
        } else if (transition === 'kind switch') {
            await act(async () => { editor.menu(editor.defaults).props.onChange('fresh'); });
        } else if (transition === 'dismiss') {
            await act(async () => { editor.picker(editor.defaults)!.props.onRequestClose(); });
        } else {
            await act(async () => { await editor.picker(editor.defaults)!.props.onSelect('continuation-c'); });
        }
        await waitForHomeGovernance(() => expect(editor.picker(editor.defaults)).toBeUndefined());
        await flushHookEffects();
        const settledReads = editor.reads();
        // Reappearance/version updates cannot reopen a vanished chooser or acquire new details.
        if (transition === 'remove') {
            await act(async () => { getStorage().getState().applyServerScopedSessionListRows(editor.serverId,
                originalRows, { source: 'ordinary', mode: 'replace' }); });
        }
        await editor.refresh({ archivedAt: null });
        expect(editor.reads()).toBe(settledReads);
        expect(editor.picker(editor.defaults)).toBeUndefined();
        await editor.screen.unmount();
    },
);

it('retains the second inspector demand until its chooser also closes', async () => {
    const editor = await renderChooserLifetimeEditor();
    await editor.open();
    await editor.screen.pressByTestIdAsync('workflow-editor-step-analyze-customize');
    await editor.open(editor.step);
    await act(async () => { editor.picker(editor.defaults)!.props.onRequestClose(); });
    const before = editor.reads();
    await editor.refresh();
    await waitForHomeGovernance(() => expect(editor.reads()).toBeGreaterThan(before));
    expect(editor.picker(editor.step)).toBeDefined();
    await act(async () => { editor.picker(editor.step)!.props.onRequestClose(); });
    await flushHookEffects();
    const after = editor.reads();
    await editor.refresh();
    expect(editor.reads()).toBe(after);
    await editor.screen.unmount();
});

it.each(['defaults', 'step'] as const)('keeps the %s chooser intent when real acquisition is loading with no current options', async inspector => {
    const editor = await renderChooserLifetimeEditor();
    const prefix = editor[inspector];
    if (inspector === 'step') await editor.screen.pressByTestIdAsync('workflow-editor-step-analyze-customize');
    await editor.open(prefix);
    const gate = editor.block();
    const before = editor.reads();
    try {
        await editor.refresh();
        await waitForHomeGovernance(() => expect(editor.reads()).toBeGreaterThan(before));
        expect(editor.host().sessionOptionsStatus).toBe('loading');
        await editor.changeMachine('machine-elsewhere');
        expect(editor.host().existingSessions).toEqual([]);
        expect(editor.picker(prefix)).toBeUndefined();
        await editor.changeMachine('machine-1');
        expect(editor.picker(prefix)).toBeDefined();
    } finally { await act(async () => { gate.resolve(); }); }
    await waitForHomeGovernance(() => expect(editor.host().sessionOptionsStatus).toBe('ready'));
    await act(async () => { editor.picker(prefix)!.props.onRequestClose(); });
    await flushHookEffects();
    const after = editor.reads();
    await editor.refresh();
    expect(editor.reads()).toBe(after);
    await editor.screen.unmount();
});

it.each(['Home', 'Account'] as const)('retires chooser intent during %s acquisition', async retirement => {
    const editor = await renderChooserLifetimeEditor();
    await editor.open();
    const gate = editor.block();
    const before = editor.reads();
    await editor.refresh();
    await waitForHomeGovernance(() => expect(editor.reads()).toBeGreaterThan(before));
    try {
        if (retirement === 'Home') await editor.switchHome();
        else await act(async () => { await editor.homes.switchAccount('editor', 'replacement-account'); });
    } finally { await act(async () => { gate.resolve(); }); }
    await waitForHomeGovernance(() => expect(editor.picker(editor.defaults)).toBeUndefined());
    await flushHookEffects();
    if (retirement === 'Home') {
        expect(editor.homes.requests.filter(request => request.home === 'other' && request.path === '/v2/sessions')).toHaveLength(0);
    }
    const after = editor.reads();
    await editor.refresh();
    expect(editor.reads()).toBe(after);
    await editor.screen.unmount();
});

it('does not acquire this Home for another Home Session drag', async () => {
    const editor = await renderChooserLifetimeEditor();
    const scope = { serverId: editor.homes.homes.other!.id, accountId: 'other-account' };
    const runtime = editor.runtime();
    const unregister = runtime.registerSource({ id: 'wrong-home', scope, isCurrent: () => true,
        getItem: () => ({ kind: 'session', scope, address: { serverId: scope.serverId, sessionId: 'continuation-c' } }) });
    try {
        await act(async () => { runtime.begin('wrong-home', 'keyboard'); });
        await flushHookEffects();
        expect(editor.reads()).toBe(0);
        expect(editor.homes.requests.filter(request => request.home === 'editor' && request.path === '/v2/sessions')).toHaveLength(0);
        expect(editor.host().existingSessions).toEqual([]);
    } finally {
        await act(async () => { runtime.cancel(); unregister(); });
        await editor.screen.unmount();
    }
});

it('expands a called workflow in editor Flow while selection reveals the parent call, not the read-only child', async () => {
    const harness = await loadHarness();
    const { getBuiltinWorkflowCatalogV1 } = await import('@happier-dev/protocol/workflows');
    const child = getBuiltinWorkflowCatalogV1().find((entry) => entry.id === 'builtin:plan-with-a-panel')!;
    const childNodeId = JSON.stringify(['call', child.definition.blocks[0]!.id]);
    const onSelectBlock = vi.fn();
    const draft = harness.createWorkflowEditorDraft({ draftId: 'nested-flow', name: 'Nested', defaults: { agentTarget: AGENT_TARGET },
        blocks: [{ kind: 'workflow', id: 'call', workflowRef: child.id,
            input: { request: { kind: 'literal', value: 'Review the plan' } } }],
    });
    paneState.rightOpen = true;
    const screen = await renderBody(harness, { draft, view: 'flow', onSelectBlock, onRunNow: () => {} });
    expect(screen.findByTestId('workflow-editor-flow-node-call'), screen.getTextContent()).not.toBeNull();
    await vi.waitFor(() => expect(screen.findByTestId(`workflow-editor-flow-node-${childNodeId}`), screen.getTextContent()).not.toBeNull());
    await screen.pressByTestIdAsync(`workflow-editor-flow-node-${childNodeId}`);
    expect(onSelectBlock).toHaveBeenCalledWith('call');
});

it('keeps description metadata editable outside the portable draft and offers a return to its reviewed run', async () => {
    const harness = await loadHarness();
    const onChangeDescription = vi.fn();
    const onBackToRun = vi.fn();
    const screen = await renderBody(harness, {
        description: 'Accepted description', onChangeDescription,
        onBackToRun,
    });
    const description = screen.findByTestId('workflow-editor-description');
    expect(description?.props.value).toBe('Accepted description');
    await act(async () => description?.props.onChangeText('Edited description'));
    expect(onChangeDescription).toHaveBeenCalledWith('Edited description');
    await act(async () => screen.findByTestId('workflow-editor-back-to-run')?.props.onPress());
    expect(onBackToRun).toHaveBeenCalledOnce();
});

/**
 * The rendered document order of the named surfaces.
 *
 * Reading order is the contract these cases are about — a pinned command bar
 * before the document, and the first prompt before optional configuration — so
 * it is asserted from the painted tree rather than from props.
 */
function renderedOrder(
    screen: Awaited<ReturnType<typeof renderScreen>>,
    testIDs: readonly string[],
): string[] {
    const seen: string[] = [];
    for (const node of screen.findAll((candidate) => (
        typeof candidate.type === 'string'
        && typeof candidate.props?.testID === 'string'
        && testIDs.includes(candidate.props.testID)
    ))) {
        const testID = node.props.testID as string;
        if (!seen.includes(testID)) seen.push(testID);
    }
    return seen;
}

function flattenTestStyle(style: unknown, state: Readonly<Record<string, boolean>> = { pressed: false }): Record<string, unknown> {
    // A Pressable style callback is resolved at rest unless a state is named.
    if (typeof style === 'function') return flattenTestStyle(style(state), state);
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, entry) => ({ ...acc, ...flattenTestStyle(entry, state) }), {});
    }
    if (typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

describe('workflow editor body', () => {
    it('keeps the authoring Session in the one Settings/Agent details pane and retires its hidden renderer', async () => {
        const harness = await loadHarness();
        const screen = await renderBody(harness, { authoringSessionId: 'author-session', authoringServerId: 'server-a', onSave: () => {} });
        expect(screen.findByTestId('workflow-editor-details-tabs:settings')).not.toBeNull();
        await screen.pressByTestIdAsync('workflow-editor-details-tabs:settings');
        expect(screen.findByTestId('session-in-pane-inactive:author-session')).not.toBeNull();
    });
    it('offers Edit with an agent in the header and shows its seeded composer in the Agent tab (04 §4.7; DESIGN-1 B8)', async () => {
        const harness = await loadHarness();
        const onEditWithAgent = vi.fn();
        const header = await renderBody(harness, { onEditWithAgent, onSave: () => {} });
        // No agent conversation yet: the pane has no Agent tab and nothing opens as a modal.
        expect(header.findByTestId('workflow-editor-details-tabs:agent')).toBeNull();
        await header.pressByTestIdAsync('workflow-editor-settings-toggle');
        // Docked panes use the lab's compact action, while retaining its name
        // for assistive technology and the same authoring command.
        const editAction = header.findHostByTestId('workflow-editor-edit-with-agent');
        expect(editAction?.findAll((node) => typeof node.type === 'string' && node.props.children === 'workflows.authoring.edit')).toHaveLength(0);
        expect(editAction?.props.accessibilityLabel).toBe('workflows.authoring.edit');
        await header.pressByTestIdAsync('workflow-editor-edit-with-agent');
        expect(onEditWithAgent).toHaveBeenCalledTimes(1);
        expect(header.visibleModals()).toEqual([]);
        await header.unmount();

        const seeded = await renderBody(harness, {
            onEditWithAgent,
            onSave: () => {},
            authoringDraft: { draftId: 'agent-draft-1', serverId: 'server-a', isCurrent: () => true, onSessionCreated: () => {} },
        });
        expect(seeded.findByTestId('workflow-editor-details-tabs:agent')).not.toBeNull();
        expect(seeded.findByTestId('workflow-editor-agent-draft')).not.toBeNull();
        // Pressing it again returns to that conversation instead of starting another.
        await seeded.pressByTestIdAsync('workflow-editor-details-tabs:settings');
        await seeded.pressByTestIdAsync('workflow-editor-edit-with-agent');
        expect(onEditWithAgent).toHaveBeenCalledTimes(1);
        expect(seeded.findByTestId('workflow-editor-agent-draft')).not.toBeNull();
    });
    it('can suppress only its title field when a wrapper owns the visible name', async () => {
        const harness = await loadHarness();
        const screen = await renderBody(harness, {
            showNameField: false,
            projectTarget: { machineId: 'machine-1', directory: '/Users/me/project' },
            projectMachines: [{ id: 'machine-1', metadata: { displayName: 'Mac Studio', homeDir: '/Users/me' } }],
        });

        expect(screen.findByTestId('workflow-editor-name')).toBeNull();
        expect(screen.findByTestId('workflow-editor-machine-row')).not.toBeNull();
        expect(screen.findByTestId('workflow-editor-defaults')).not.toBeNull();
        expect(screen.findByTestId('workflow-editor-project-directory-readonly')).not.toBeNull();
        expect(screen.getTextContent()).toContain('~/project');
    });

    it('offers Start from an example only while the document is untouched (owner 09.16.21)', async () => {
        const harness = await loadHarness();
        const pristine = await renderBody(harness, { draft: buildDraft(harness, { text: '' }) });
        expect(pristine.findByTestId('workflow-editor-add-root-examples')).not.toBeNull();
        const authored = await renderBody(harness, { draft: buildDraft(harness, { text: 'Check the build' }) });
        expect(authored.findByTestId('workflow-editor-add-root-examples')).toBeNull();
    });

    it('leads with identity and one primary; rare operations are in ⋯', async () => {
        const harness = await loadHarness();
        const exported = vi.fn();
        const screen = await renderBody(harness, {
            onRunNow: () => {},
            onSave: () => {},
            onSchedule: () => {},
            onExportJson: () => {},
            saveStatus: { kind: 'unsaved' },
            menuActions: [{ id: 'export', title: 'workflows.exportJson', onSelect: exported }],
        });

        // The editable name is the page's identity, in the page.
        expect(screen.findByTestId('workflow-editor-name')?.props.value).toBe('Review');
        // One primary; Schedule is not a page action (triggers are the Triggers section).
        expect(screen.findByTestId('workflow-editor-run-now')).not.toBeNull();
        expect(screen.findByTestId('workflow-editor-schedule')).toBeNull();
        expect(screen.findByTestId('workflow-editor-export-json')).toBeNull();
        // Save lives inside the save status element, as its own receipt.
        const status = screen.findByTestId('workflow-editor-save-status');
        expect(status?.findAll((node) => node.props?.testID === 'workflow-editor-save').length).toBeGreaterThan(0);
        expect(screen.findByTestId('workflow-editor-menu')).not.toBeNull();
    });

    it('authors loop count and item sources as canonical value references', async () => {
        const harness = await loadHarness();
        const changed = vi.fn();
        const draft = harness.createWorkflowEditorDraft({
            draftId: 'loop-draft', name: 'Loop', defaults: { agentTarget: AGENT_TARGET },
            blocks: [{
                kind: 'loop', id: 'repeat', repetition: { kind: 'count', count: { kind: 'literal', value: 2 } },
                body: [{ kind: 'step', id: 'inside', document: { text: 'Work', references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
            }],
        });
        const screen = await renderBody(harness, { draft: { ...draft, inputs: [{ name: 'rounds', valueType: 'number', required: true }] }, onChange: changed });

        // The document reads the loop as a sentence; its options open beside it.
        expect(screen.getTextContent()).toContain('workflows.page.inspector.repeatTimes');
        await screen.pressByTestIdAsync('workflow-editor-loop-repeat-summary');
        const source = dropdownField(screen, 'workflow-editor-inspector-loop-repeat-count-input-0-value');
        const input = source.props.items.find((item) => item.category === 'workflows.condition.fromRun')!;
        await act(async () => { source.props.onSelect(input.id as string); });
        expect(changed.mock.calls[0]?.[0].blocks[0].repetition.count.kind).toBe('input');
    });

    it('authors named inputs in declaration order and keeps them separate from step prompts', async () => {
        const harness = await loadHarness();
        const changed = vi.fn();
        const screen = await renderBody(harness, { onChange: changed });

        await screen.pressByTestIdAsync('workflow-editor-inputs-add');
        const next = changed.mock.calls[0]?.[0];
        expect(next.inputs).toEqual([{
            name: 'input',
            valueType: 'string',
            required: false,
        }]);
        expect(next.blocks[0].document.text).toBe('Analyze the repository');
    });

    it('authors a canonical participant input or ordered list through the existing type field', async () => {
        const { WorkflowInputsEditor } = await import('@/components/workflows/editor/WorkflowInputsEditor');
        const onChange = vi.fn();
        const inputs: WorkflowEditorDraft['inputs'] = [{ name: 'reviewer', valueType: 'json', required: true,
            inputType: { hostType: 'session' }, defaultFrom: 'origin_session' }];
        const screen = await renderScreen(<WorkflowInputsEditor inputs={inputs} onChange={onChange} testIDPrefix="workflow-editor" />);
        const type = dropdownField(screen, 'workflow-editor-input-0-type');
        await act(async () => { type.props.onSelect('agentParticipant'); });
        expect(onChange).toHaveBeenLastCalledWith([{
            name: 'reviewer', valueType: 'json', required: true, inputType: { hostType: 'agentParticipant' },
        }]);
        await act(async () => { type.props.onSelect('agentParticipantList'); });
        expect(onChange).toHaveBeenLastCalledWith([{
            name: 'reviewer', valueType: 'json', required: true, inputType: { hostType: 'agentParticipant' }, multiple: true,
        }]);
        await act(async () => { type.props.onSelect('string'); });
        expect(onChange).toHaveBeenLastCalledWith([{ name: 'reviewer', valueType: 'string', required: true }]);
    });

    it('labels parallel branches by localized position without authoring a schema field', async () => {
        const harness = await loadHarness();
        const changed = vi.fn();
        const draft = harness.createWorkflowEditorDraft({
            draftId: 'parallel-draft', name: 'Review', defaults: { agentTarget: AGENT_TARGET },
            blocks: [{
                kind: 'parallel', id: 'parallel', failurePolicy: 'fail_stop',
                branches: [{
                    id: 'branch-a',
                    blocks: [{
                        kind: 'step', id: 'step-a',
                        document: { text: 'Review', references: [], attachments: [] },
                        input: [], result: { kind: 'text' },
                    }],
                }],
            }],
        });
        const screen = await renderBody(harness, { draft, onChange: changed });
        expect(screen.findByTestId('workflow-editor-parallel-parallel-branch-branch-a-label')).not.toBeNull();
        // An unnamed lane reads "Lane 1" (its placeholder) until the author names it (07).
        expect(screen.findHostByTestId('workflow-editor-parallel-parallel-branch-branch-a-label')?.props.placeholder)
            .toContain('workflows.page.inspector.lane');
        expect(changed).not.toHaveBeenCalled();
    });

    it('uses the shared Session authoring controls for workflow defaults and the step options', async () => {
        const harness = await loadHarness();
        const screen = await renderBody(harness, { selectedBlockId: 'analyze' });

        expect(screen.findByTestId('workflow-editor-defaults')).not.toBeNull();
        // Step options never render as a document column beside the steps.
        expect(screen.findByTestId('workflow-editor-inspector')).toBeNull();
        await screen.pressByTestIdAsync('workflow-editor-step-analyze-customize');
        // Wide: Step options is the anchored popover beside the step, not a modal.
        expect(screen.visibleModals()).toEqual([]);
        expect(screen.findByTestId('workflow-editor-inspector-options')).not.toBeNull();
        expect(screen.findByTestId('workflow-editor-inspector')).not.toBeNull();
        await screen.pressByTestIdAsync('workflow-editor-inspector-done');
        expect(screen.findByTestId('workflow-editor-inspector-options')).toBeNull();
    });

    it('places Step options against the step card while focus returns to the control that opened it', async () => {
        const harness = await loadHarness();
        const { Popover } = await import('@/components/ui/popover/Popover');
        const screen = await renderBody(harness, { selectedBlockId: 'analyze' });
        await screen.pressByTestIdAsync('workflow-editor-step-analyze-customize');
        const popover = screen.root.findAllByType(Popover).find((node) => node.props.open);
        expect(popover).toBeDefined();
        // The card is what the panel avoids; the chip is where focus comes back to.
        expect(popover!.props.anchorRef).not.toBe(popover!.props.focusReturnRef);
        expect(popover!.props.placement).toBe('auto-vertical');
    });

    it('keeps one page tree across the phone breakpoint: the same scroll, step card and open Step options', async () => {
        const harness = await loadHarness();
        const { Popover } = await import('@/components/ui/popover/Popover');
        const { KeyboardAwareScrollView } = await import('@/components/ui/keyboardAvoidance/KeyboardAwareScrollView');
        const cardNodes: object[] = [];
        const element = <harness.WorkflowEditorBody draft={buildDraft(harness)} onChange={() => {}}
            machineName="Mac Studio" composerScope={MACHINE_COMPOSER_SCOPE} selectedBlockId="analyze" onSelectBlock={() => {}}
            onCustomizeBlock={() => {}} view="steps" onChangeView={() => {}} onRunNow={() => {}} />;
        const screen = await renderScreen(element, { createNodeMock: node => {
            // The placement ref is on the outer listitem, not the inner step editor's testID.
            if (node.props.role !== 'listitem') return undefined;
            // A remount would receive a new platform node, losing focus, selection and scroll.
            const card = { measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(100, 100, 600, 160) };
            cardNodes.push(card);
            return card;
        } });
        const currentAnchor = () => screen.findAllByType(Popover).find(node => node.props.open)?.props.anchorRef.current;
        await screen.pressByTestIdAsync('workflow-editor-step-analyze-customize');
        const firstCard = currentAnchor();
        expect(firstCard === cardNodes.at(-1)).toBe(true);
        const firstScroll = screen.findAllByType(KeyboardAwareScrollView as never)[0];
        const cardCount = cardNodes.length;

        paneState.detailsAvailable = false;
        viewport.window = { width: 390, height: 844 };
        getStorage().setState({ localSettings: { ...getStorage().getState().localSettings, uiMultiPanePanelsEnabled: false } });
        await screen.update(React.cloneElement(element));
        // Recomposed as the phone page (value rows and the bottom bar) without remounting the document.
        expect(screen.findHostByTestId('workflow-editor-phone-bar')).not.toBeNull();
        expect(screen.findAllByType(KeyboardAwareScrollView as never)).toHaveLength(1);
        expect(screen.findAllByType(KeyboardAwareScrollView as never)[0] === firstScroll).toBe(true);
        expect(cardNodes.length).toBe(cardCount);

        paneState.detailsAvailable = true;
        viewport.window = { width: 1440, height: 1000 };
        getStorage().setState({ localSettings: { ...getStorage().getState().localSettings, uiMultiPanePanelsEnabled: true } });
        await screen.update(React.cloneElement(element));
        expect(screen.findHostByTestId('workflow-editor-phone-bar')).toBeNull();
        expect(screen.findAllByType(KeyboardAwareScrollView as never)[0] === firstScroll).toBe(true);
        expect(cardNodes.length).toBe(cardCount);
        expect(currentAnchor() === firstCard).toBe(true);
        expect(screen.findHostByTestId('workflow-editor-inspector-done')).not.toBeNull();
    });

    it('keeps the Step options header outside the page that scrolls', async () => {
        const harness = await loadHarness();
        const screen = await renderBody(harness, { selectedBlockId: 'analyze' });
        await screen.pressByTestIdAsync('workflow-editor-step-analyze-customize');
        const page = screen.findByTestId('workflow-editor-inspector-options-page');
        expect(page).not.toBeNull();
        const idsIn = (root: NonNullable<typeof page>) => root.findAll((node) => typeof node.props.testID === 'string').map((node) => node.props.testID as string);
        expect(idsIn(page!)).not.toContain('workflow-editor-inspector-done');
        expect(idsIn(page!)).toContain('workflow-editor-inspector-review');
        expect(screen.findByTestId('workflow-editor-inspector-done')).not.toBeNull();
    });

    it('offers only the engine picker and Permissions in workflow Agent and model settings', async () => {
        const harness = await loadHarness();
        const changed = vi.fn();
        const screen = await renderBody(harness, {
            onChange: changed,
            authoringFacts: {
                agentTargets: [{ id: 'agent:happier.agent.claude/claude', label: 'Claude Code', target: AGENT_TARGET, agentId: 'claude' }],
            },
        });

        const defaults = screen.findByTestId('workflow-editor-defaults');
        if (defaults === null) throw new Error('Expected workflow default controls');
        const rowIds = defaults.findAll(node => typeof node.type === 'string'
            && typeof node.props.testID === 'string'
            && node.props.testID.startsWith('workflow-editor-defaults-')
            && node.props.testID.endsWith('-row')).map(node => node.props.testID);
        expect(rowIds).toEqual([
            'workflow-editor-defaults-agentTarget-row',
            'workflow-editor-defaults-permissionMode-row',
        ]);
        expect(defaults.findAll(node => typeof node.props.testID === 'string'
            && node.props.testID.endsWith('-unavailable'))).toHaveLength(0);

        await screen.pressByTestIdAsync('workflow-editor-defaults-permissionMode');
        const { AgentInputChipPickerPopover } = await import('@/components/sessions/agentInput/components/AgentInputChipPickerPopover');
        const picker = screen.root.findAllByType(AgentInputChipPickerPopover).find(node => node.props.open);
        if (picker === undefined) throw new Error('Expected the Permissions picker');
        await act(async () => { picker.props.onSelect('yolo'); });
        expect(changed.mock.lastCall?.[0].defaults.permissionMode).toBe('yolo');
    });

    /**
     * The strict Workflow schema requires an effective Agent, so a host that
     * contributes its Agent catalog must produce a real picker here. Without
     * those facts the field stays explicitly unavailable rather than pretending
     * to offer a choice — both directions are the contract.
     */
    it('offers the host-contributed Agent targets and states unavailability without them', async () => {
        const harness = await loadHarness();
        const changed = vi.fn();
        const withoutFacts = await renderBody(harness);
        expect(withoutFacts.findByTestId('workflow-editor-defaults-agentTarget')?.props.accessibilityLabel).toContain('workflows.input.unavailable');
        await withoutFacts.unmount();

        const screen = await renderBody(harness, {
            onChange: changed,
            authoringFacts: {
                agentTargets: [
                    { id: 'agent:happier.agent.claude/claude', label: 'Claude Code', target: AGENT_TARGET, agentId: 'claude' },
                    {
                        id: 'agent:happier.agent.codex/codex',
                        label: 'Codex',
                        agentId: 'codex',
                        target: {
                            kind: 'agent' as const,
                            identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                        },
                    },
                ],
            },
        });

        const chip = screen.findByTestId('workflow-editor-defaults-agentTarget');
        expect(chip).not.toBeNull();
        expect(chip?.props.accessibilityLabel).toContain('Claude Code');
    });

    it('opens workflow settings as the canonical full-width solid phone sheet', async () => {
        viewport.window = { width: 390, height: 844 };
        paneState.detailsAvailable = false;
        const harness = await loadHarness();
        const screen = await renderBody(harness, { onRunNow: () => {} });
        await screen.pressByTestIdAsync('workflow-editor-phone-more');
        await screen.pressByTestIdAsync('workflow-editor-phone-settings');
        expect(screen.visibleModals()).toEqual([expect.objectContaining({
            chrome: expect.objectContaining({ phonePresentation: 'sheet', material: 'solid' }),
        })]);
        expect(screen.findByTestId('workflow-editor-defaults')).not.toBeNull();
    });

    it('opens the same controlled step options as the canonical phone sheet', async () => {
        viewport.window = { width: 390, height: 844 };
        paneState.detailsAvailable = false;
        const harness = await loadHarness();
        const changed = vi.fn();
        const screen = await renderBody(harness, { onChange: changed });

        expect(screen.findByTestId('workflow-editor-inspector')).toBeNull();
        await screen.pressByTestIdAsync('workflow-editor-step-analyze-customize');

        // One presentation owner: the anchored popover, which a phone shows as the shared sheet
        // (no centred card modal beside it).
        expect(screen.visibleModals()).toEqual([]);
        const sheets = screen.root.findAll((node) => node.props?.open === true && node.props?.phonePresentation === 'sheet'
            && node.props?.accessibilityLabel === 'workflows.page.inspector.stepOptions');
        expect(sheets.length).toBeGreaterThan(0);
        expect(screen.findByTestId('workflow-editor-inspector-options')).not.toBeNull();
        expect(changed).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('workflow-editor-inspector-done');
        expect(screen.findByTestId('workflow-editor-inspector-options')).toBeNull();
    });

    /**
     * Flow's Edit action must land on an editor that exists. A branch frame is
     * not a block, so selecting it and pressing Edit used to select an id no
     * editor owns and request focus on a prompt that was never registered — an
     * inert action. The owning group is the real editor for a branch.
     */
    it('reveals the owning group editor when Edit is pressed on a Flow branch frame', async () => {
        const harness = await loadHarness();
        const changeView = vi.fn();
        const draft = harness.setWorkflowDefaultField(harness.createWorkflowEditorDraft({
            draftId: 'parallel-draft', name: 'Review',
            blocks: [{
                kind: 'parallel', id: 'parallel', failurePolicy: 'fail_stop',
                branches: [{
                    id: 'branch-a',
                    blocks: [{
                        kind: 'step', id: 'step-a',
                        document: { text: 'Review', references: [], attachments: [] },
                        input: [], result: { kind: 'text' },
                    }],
                }],
            }],
        }), 'agentTarget', AGENT_TARGET);
        const selections: Array<string | null> = [];
        // Flow is the editor scope's right pane on a wide layout.
        paneState.rightOpen = true;
        function Host(): React.ReactElement {
            const [selectedBlockId, setSelectedBlockId] = React.useState<string | null>(null);
            return React.createElement(harness.WorkflowEditorBody, {
                draft,
                onChange: () => {},
                machineName: 'Mac Studio',
                composerScope: MACHINE_COMPOSER_SCOPE,
                selectedBlockId,
                onSelectBlock: (blockId: string | null) => { selections.push(blockId); setSelectedBlockId(blockId); },
                onCustomizeBlock: () => {},
                view: 'flow',
                onChangeView: changeView,
                onRunNow: () => {},
            } as never);
        }
        const screen = await renderScreen(React.createElement(Host));

        await screen.pressByTestIdAsync('workflow-editor-flow-node-parallel#branch-a');
        // The selection is the real block the editor can show, never the frame id.
        expect(selections.at(-1)).toBe('parallel');
        expect(harness.findWorkflowBlock(draft, selections.at(-1) ?? '')?.kind).toBe('parallel');

        const edit = screen.findByTestId('workflow-editor-flow-edit-step');
        expect(edit?.props.accessibilityLabel).toBe('workflows.a11y.editBlock');
        await screen.pressByTestIdAsync('workflow-editor-flow-edit-step');
        expect(changeView).toHaveBeenCalledWith('steps');
        expect(selections.at(-1)).toBe('parallel');
        // A group has no prompt; nothing is asked to focus that cannot.
        expect(promptFocus).not.toHaveBeenCalled();
    });

    it('returns focus to the evaluator prompt when Edit is pressed on its Flow node', async () => {
        const harness = await loadHarness();
        const changeView = vi.fn();
        const draft = harness.setWorkflowDefaultField(harness.createWorkflowEditorDraft({
            draftId: 'loop-draft', name: 'Judge',
            blocks: [{
                kind: 'loop', id: 'judge',
                repetition: {
                    kind: 'evaluate', maxIterations: 3, history: 'latest',
                    evaluator: {
                        kind: 'step', id: 'judge-step',
                        document: { text: 'Decide', references: [], attachments: [] },
                        input: [], result: { kind: 'decision', decisions: ['continue', 'stop'] },
                    },
                },
                body: [{
                    kind: 'step', id: 'summarize',
                    document: { text: 'Summarize', references: [], attachments: [] },
                    input: [], result: { kind: 'text' },
                }],
            }],
        }), 'agentTarget', AGENT_TARGET);
        paneState.rightOpen = true;
        const screen = await renderBody(harness, {
            draft, view: 'flow', selectedBlockId: 'judge-step', onChangeView: changeView, onRunNow: () => {},
        });

        expect(screen.findByTestId('workflow-editor-flow-edit-step')?.props.accessibilityLabel)
            .toBe('workflows.a11y.editStep');
        await screen.pressByTestIdAsync('workflow-editor-flow-edit-step');
        expect(changeView).toHaveBeenCalledWith('steps');
        expect(promptFocus).toHaveBeenCalledTimes(1);
    });

    it('shows Machine and project as one field that opens the choices, which wrap without a phone-breaking minimum', async () => {
        const harness = await loadHarness();
        const screen = await renderBody(harness, {
            projectTarget: { machineId: 'machine-1', directory: '/Users/me/project' },
            projectMachines: [{ id: 'machine-1', metadata: { displayName: 'Mac Studio', homeDir: '/Users/me' } }],
            onChangeProjectTarget: vi.fn(),
        });

        // One row and one value: the where-summary, home-relative, never a raw absolute path.
        expect(screen.getTextContent()).toContain('Mac Studio · ~/project');
        expect(screen.findByTestId('workflow-editor-project-directory')).toBeNull();
        await screen.pressByTestIdAsync('workflow-editor-machine-row');
        expect(screen.findByTestId('workflow-editor-where-popover')).not.toBeNull();
        const folder = screen.findByTestId('workflow-editor-project-directory');
        expect(folder?.props.role ?? folder?.props.accessibilityRole).toBe('button');
        expect(flattenTestStyle(folder?.props.style)).toMatchObject({ minWidth: 0, flexShrink: 1 });
    });

    it('authors a typed step input reference without interpolating it into prompt text', async () => {
        const harness = await loadHarness();
        const changed = vi.fn();
        // Adding an input is Step options' (DESIGN-7 N27), opened from the step's own chip.
        const screen = await renderBody(harness, { onChange: changed, selectedBlockId: 'analyze' });

        await screen.pressByTestIdAsync('workflow-editor-step-analyze-customize');
        await screen.pressByTestIdAsync('workflow-editor-inspector-add-input');
        const next = changed.mock.calls[0]?.[0];
        expect(next.blocks[0].input).toEqual([{ kind: 'literal', value: '' }]);
        expect(next.blocks[0].document.text).toBe('Analyze the repository');
    });

    it('authors a scoped producer workspace path for a downstream step', async () => {
        const harness = await loadHarness();
        const changed = vi.fn();
        const base = buildDraft(harness);
        const draft = {
            ...base,
            blocks: [...base.blocks, {
                kind: 'step' as const,
                id: 'implement',
                document: { text: 'Implement the analysis', references: [], attachments: [] },
                input: [{ kind: 'literal' as const, value: '' }],
                result: { kind: 'text' as const },
            }],
        };
        // The binding editors show on the selected step (DESIGN-13).
        const screen = await renderBody(harness, { draft, onChange: changed, selectedBlockId: 'implement' });

        const source = dropdownField(screen, 'workflow-editor-step-implement-input-0-value');
        const folder = source.props.items.find((item) => item.category === 'workflows.condition.whereItWorks')!;
        await act(async () => { source.props.onSelect(folder.id as string); });
        expect(changed.mock.calls[0]?.[0].blocks[1].input).toEqual([{
            kind: 'workspace',
            producer: { blockId: 'analyze', scope: { kind: 'current' } },
            field: 'directory',
        }]);
    });

    it('offers Run now and Save as separate commands; Run now never saves', async () => {
        const harness = await loadHarness();
        const ran = vi.fn();
        const saved = vi.fn();
        const scheduled = vi.fn();
        const screen = await renderBody(harness, {
            onRunNow: ran,
            onSave: saved,
            onSchedule: scheduled,
            projectTarget: { machineId: 'machine-1', directory: '/Users/me/project' },
            saveStatus: { kind: 'unsaved' },
        });

        await screen.pressByTestIdAsync('workflow-editor-run-now');
        expect(ran).toHaveBeenCalledTimes(1);
        expect(saved).not.toHaveBeenCalled();
        expect(scheduled).not.toHaveBeenCalled();

        await screen.pressByTestIdAsync('workflow-editor-save');
        expect(saved).toHaveBeenCalledTimes(1);
        expect(ran).toHaveBeenCalledTimes(1);
    });

    it('composes one page scroll: identity, the header chips, then the document', async () => {
        const harness = await loadHarness();
        const screen = await renderBody(harness, {
            onRunNow: () => {},
            onSave: () => {},
            projectTarget: { machineId: 'machine-1', directory: '/Users/me/project' },
            projectMachines: [{ id: 'machine-1', metadata: { displayName: 'Mac Studio', homeDir: '/Users/me' } }],
            onChangeProjectTarget: () => {},
        });

        const { KeyboardAwareScrollView } = await import('@/components/ui/keyboardAvoidance/KeyboardAwareScrollView');
        expect(screen.findAllByType(KeyboardAwareScrollView as never)).toHaveLength(1);
        expect(screen.findHostByTestId('workflow-editor-scroll')?.props.keyboardShouldPersistTaps).toBe('handled');
        expect(renderedOrder(screen, [
            'workflow-editor-header',
            'workflow-editor-chips',
            'workflow-editor-steps-presentation',
        ])).toEqual(['workflow-editor-header', 'workflow-editor-chips', 'workflow-editor-steps-presentation']);
        // Where and Agent & model are header chips over their one owners; the
        // Where chip says the one summary string.
        const where = screen.root.findAll((node) => node.props?.filter?.id === 'workflow-where')[0];
        expect(where?.props.filter.valueLabel).toBe('Mac Studio · ~/project');
        expect(screen.findByTestId('workflow-editor-header-engine')).not.toBeNull();
        // Settings are a pane, closed until asked for; the document carries no settings wall.
        expect(screen.findByTestId('workflow-editor-defaults')).toBeNull();
    });

    it('opens and closes Flow in the real right pane while Workflow settings use the details slot', async () => {
        const harness = await loadHarness();
        const screen = await renderBody(harness, {
            onRunNow: () => {},
            onSave: () => {},
            projectTarget: { machineId: 'machine-1', directory: '/Users/me/project' },
            projectMachines: [{ id: 'machine-1', metadata: { displayName: 'Mac Studio', homeDir: '/Users/me' } }],
            onChangeProjectTarget: () => {},
        });
        const host = screen.findByType(AppPaneScopeHost);
        expect(host.props.scopeId).toBe('workflow-editor');
        expect(host.props.mainMinWidthPx).toBe(420);
        expect(host.props.rightPaneBuiltinAdapter.destinationIds).toEqual(['workflow-flow']);
        expect(host.props.rightSidebarAdapter).toBeUndefined();
        expect(host.props.detailsPaneBuiltinAdapter).toBeUndefined();
        expect(host.props.destinationDetails).toBeNull();
        expect(screen.findHostByTestId('workflow-editor-flow-node-analyze')).toBeNull();
        expect(screen.findHostByTestId('workflow-editor-settings-pane')).toBeNull();
        await screen.pressByTestIdAsync('workflow-editor-flow-toggle');
        expect(screen.findHostByTestId('workflow-editor-flow-node-analyze')).not.toBeNull();
        expect(screen.findHostByTestId('workflow-editor-step-analyze-prompt')).not.toBeNull();
        expect(paneUiState.readAll()?.['workflow-editor']?.right.isOpen).toBe(true);

        await screen.pressByTestIdAsync('workflow-editor-settings-toggle');
        expect(screen.findHostByTestId('workflow-editor-settings-pane')).not.toBeNull();
        expect(screen.findHostByTestId('workflow-editor-flow-node-analyze')).not.toBeNull();
        const order = [
            'workflow-editor-machine-row',
            'workflow-editor-defaults',
            'workflow-editor-defaults-continuity-row',
            'workflow-editor-inputs-row',
            'workflow-editor-final-output-row',
        ];
        expect(renderedOrder(screen, order)).toEqual(order);
        await screen.pressByTestIdAsync('workflow-editor-flow-toggle');
        expect(screen.findHostByTestId('workflow-editor-flow-node-analyze')).toBeNull();
        expect(screen.findHostByTestId('workflow-editor-settings-pane')).not.toBeNull();
        expect(paneUiState.readAll()?.['workflow-editor']?.right.isOpen).toBe(false);
    });

    it('keeps an untouched draft silent and reveals one validity readout after a refused Run', async () => {
        const harness = await loadHarness();
        const ran = vi.fn();
        const onSelectBlock = vi.fn();
        const screen = await renderBody(harness, {
            draft: buildDraft(harness, { text: '' }),
            projectTarget: { machineId: 'machine-1', directory: '/Users/me/project' },
            onRunNow: ran,
            onSave: () => {},
            onSelectBlock,
        });
        expect(screen.findByTestId('workflow-editor-validity')).toBeNull();

        await screen.pressByTestIdAsync('workflow-editor-run-now');
        expect(ran).not.toHaveBeenCalled();
        expect(screen.findByTestId('workflow-editor-validity')).not.toBeNull();
        expect(screen.getTextContent()).toContain('workflows.page.issuesToFix');
        // One readout, on the header's status line beside the save state ("Saved · 1 thing to fix").
        const status = screen.findByTestId('workflow-editor-save-status');
        expect(status?.findAll((node) => node.props?.testID === 'workflow-editor-validity').length).toBeGreaterThan(0);
        expect(screen.findAllByTestId('workflow-editor-validity').filter((node) => typeof node.type === 'string').length).toBe(1);
        expect(onSelectBlock).toHaveBeenCalledWith('analyze');
    });

    it('counts every issue at once: an unwritten prompt and a blank required Action field (DESIGN-7 P3)', async () => {
        const harness = await loadHarness();
        const base = buildDraft(harness, { text: '' });
        const draft = { ...base, blocks: [...base.blocks,
            { kind: 'action' as const, id: 'notify', actionId: 'notifications.notify_me', input: { message: { kind: 'literal' as const, value: '' } } }] };
        const screen = await renderBody(harness, {
            draft,
            projectTarget: { machineId: 'machine-1', directory: '/Users/me/project' },
            onRunNow: () => {},
            onSave: () => {},
        });
        await screen.pressByTestIdAsync('workflow-editor-run-now');
        // The canonical validator's one pass: the prompt and the Message, not "1" then "1 more".
        expect(screen.getTextContent()).toContain('workflows.page.issuesToFix:{"count":2}');
    });

    it('reads a valid draft as Ready on the save status line (07 one validity readout)', async () => {
        const harness = await loadHarness();
        const screen = await renderBody(harness, {
            projectTarget: { machineId: 'machine-1', directory: '/Users/me/project' },
            onRunNow: () => {},
            onSave: () => {},
        });
        const status = screen.findByTestId('workflow-editor-save-status');
        expect(status?.findAll((node) => node.props?.testID === 'workflow-editor-ready').length).toBeGreaterThan(0);
        expect(screen.getTextContent()).toContain('workflows.page.readyToRun');
    });

    it('does not claim Ready while the canonical Run command still needs a target', async () => {
        const harness = await loadHarness();
        const screen = await renderBody(harness, {
            projectTarget: null,
            onRunNow: () => {},
            onSave: () => {},
            saveStatus: { kind: 'saved', savedAtMs: null },
        });
        expect(screen.findByTestId('workflow-editor-ready')).toBeNull();
        expect(screen.findByTestId('workflow-editor-save-status')).not.toBeNull();
    });

    it('opens the Where picker instead of refusing when Run now has no machine', async () => {
        const harness = await loadHarness();
        const ran = vi.fn();
        const screen = await renderBody(harness, {
            projectTarget: null,
            machineName: null,
            projectMachines: [{ id: 'machine-1', metadata: { displayName: 'Mac Studio', homeDir: '/Users/me' } }],
            onChangeProjectTarget: () => {},
            onRunNow: ran,
        });
        const chip = () => screen.root.findAll((node) => node.props?.filter?.id === 'workflow-where')[0];
        // Missing is stated once, by the Where chip.
        expect(chip()?.props.filter.muted).toBe(true);
        expect(chip()?.props.filter.valueLabel).toBe('workflows.page.where.choose');
        expect(chip()?.props.filter.open).toBe(false);

        await screen.pressByTestIdAsync('workflow-editor-run-now');
        expect(ran).not.toHaveBeenCalled();
        expect(chip()?.props.filter.open).toBe(true);
        expect(announcementWrites).not.toHaveBeenCalled();
    });

    /**
     * UX §1/§4.2: the first prompt is the visual center, not something reached
     * after a schema wall. Inputs and shared defaults are optional refinements
     * and follow the authored steps.
     */
    it('composes the settings, then the blocks, for a host without page commands', async () => {
        const harness = await loadHarness();
        const screen = await renderBody(harness, {
            projectTarget: { machineId: 'machine-1', directory: '/Users/me/project' },
            projectMachines: [{ id: 'machine-1', metadata: { displayName: 'Mac Studio', homeDir: '/Users/me' } }],
            onChangeProjectTarget: () => {},
        });

        const order = [
            'workflow-editor-machine-row',
            'workflow-editor-defaults',
            'workflow-editor-inputs-row',
            'workflow-editor-final-output-row',
            'workflow-editor-list-root',
        ];
        expect(renderedOrder(screen, order)).toEqual(order);
    });

    /**
     * 04 §5.2 (D10): Workflow settings are quiet by default. Each group is one
     * line of effective values until it holds a value set for this workflow,
     * needs attention, or the person opens it; the person's choice is view
     * state. A required-but-missing machine keeps Where it runs open even when
     * the person closed it, so a closed group never hides what is required.
     */
    it('keeps settings groups as summaries until a value, a missing requirement or the person opens them', async () => {
        const harness = await loadHarness();
        const toggled = vi.fn();
        const pristine = harness.createWorkflowEditorDraft({ draftId: 'draft-quiet', name: 'Quiet' });
        const screen = await renderBody(harness, {
            draft: pristine,
            inspectorGroupDisclosure: new Map([['where', false]]),
            onChangeInspectorGroup: toggled,
        });
        // Where it runs: the machine is required and missing, so it stays open.
        expect(screen.findByTestId('workflow-editor-where-field')).not.toBeNull();
        // Everything else is a one-line summary of its effective values.
        expect(screen.findByTestId('workflow-editor-defaults')).toBeNull();
        expect(screen.findByTestId('workflow-editor-defaults-continuity-row')).toBeNull();
        expect(screen.findByTestId('workflow-editor-inputs-row')).toBeNull();
        expect(screen.getTextContent()).toContain('workflows.conversation.sharedRun · workflows.workspace.inherit');
        expect(screen.getTextContent()).toContain('workflows.page.inspector.none · workflows.finalOutput.none');

        await screen.pressByTestIdAsync('workflow-editor-group-inputs-header');
        expect(toggled).toHaveBeenCalledWith('inputs', true);
        await screen.unmount();

        // The person's choice opens it; a value set for this workflow opens another.
        const opened = await renderBody(harness, {
            draft: harness.setWorkflowDefaultField(pristine, 'conversation', { kind: 'fresh' }),
            projectTarget: { machineId: 'machine-1', directory: '/Users/me/project' },
            inspectorGroupDisclosure: new Map([['inputs', true]]),
        });
        expect(opened.findByTestId('workflow-editor-inputs-row')).not.toBeNull();
        expect(opened.findByTestId('workflow-editor-defaults-continuity-row')).not.toBeNull();
        expect(opened.findByTestId('workflow-editor-defaults')).toBeNull();
        // With the machine chosen, Where it runs follows the ordinary rule.
        expect(opened.findByTestId('workflow-editor-where-field')).not.toBeNull();
    });

    /**
     * Continuing a workspace reuses its exact dirty state, and parallel branches
     * that resolve to one directory write to it together. Both are allowed and
     * both are stated where the choice is made — only when they apply.
     */
    it('discloses workspace reuse and shared parallel writes only where they apply', async () => {
        const harness = await loadHarness();
        const linear = await renderBody(harness);
        expect(linear.findByTestId('workflow-editor-defaults-continuity-workspace-shared-parallel-note')).toBeNull();
        expect(linear.findByTestId('workflow-editor-defaults-continuity-workspace-reuse-note')).toBeNull();
        await linear.unmount();

        const withParallel = harness.insertWorkflowBlock(buildDraft(harness), {
            list: { kind: 'root' },
            block: harness.createWorkflowBlock('parallel', new Set(['analyze'])),
        });
        const parallel = await renderBody(harness, { draft: withParallel });
        expect(parallel.findByTestId('workflow-editor-defaults-continuity-workspace-shared-parallel-note')).not.toBeNull();
        await parallel.unmount();

        const isolated = await renderBody(harness, {
            draft: harness.setWorkflowDefaultField(withParallel, 'workspace', {
                kind: 'new_worktree',
                source: { kind: 'original' },
            }),
        });
        expect(isolated.findByTestId('workflow-editor-defaults-continuity-workspace-shared-parallel-note')).toBeNull();
    });

    /**
     * The runtime continues an earlier conversation only with that
     * conversation's Agent and folder; a mismatch is refused, never silently
     * forked. That consequence is stated on the continuation choices, and
     * nowhere a new conversation is already what runs.
     */
    it('states that a continued conversation keeps its Agent and folder only on continuation choices', async () => {
        const harness = await loadHarness();
        const noteId = 'workflow-editor-defaults-continuity-conversation-continuation-note';
        const shared = await renderBody(harness);
        expect(shared.findByTestId(noteId)).toBeNull();
        await shared.unmount();

        const fresh = await renderBody(harness, {
            draft: harness.setWorkflowDefaultField(buildDraft(harness), 'conversation', { kind: 'fresh' }),
        });
        expect(fresh.findByTestId(noteId)).toBeNull();
        await fresh.unmount();

        const continued = await renderBody(harness, {
            draft: harness.setWorkflowDefaultField(
                buildDraft(harness),
                'conversation',
                { kind: 'existing_session', sessionId: 'session-9', machineId: 'machine-1' },
            ),
            existingSessions: [{ sessionId: 'session-9', machineId: 'machine-1', label: 'Ship release' }],
        });
        expect(continued.findByTestId(noteId)?.props.children).toBe('workflows.conversation.continuingKeepsAgentAndFolder');
        await continued.unmount();
    });

    /**
     * Parallel branches get separate conversations only when every step in
     * them actually runs fresh. Under the shared default they share the Run's
     * conversation, so the group must not claim otherwise.
     */
    it('says parallel branches use separate conversations only when every branch step runs fresh', async () => {
        const harness = await loadHarness();
        const noteId = 'workflow-editor-inspector-parallel-parallel-1-separate-conversations';
        const withParallel = harness.insertWorkflowBlock(buildDraft(harness), {
            list: { kind: 'root' },
            block: harness.createWorkflowBlock('parallel', new Set(['analyze'])),
        });
        const shared = await renderBody(harness, { draft: withParallel });
        expect(shared.findByTestId('workflow-editor-parallel-parallel-1')).not.toBeNull();
        await shared.pressByTestIdAsync('workflow-editor-parallel-parallel-1-summary');
        expect(shared.findByTestId(noteId)).toBeNull();
        await shared.unmount();

        const freshDraft = harness.setWorkflowDefaultField(withParallel, 'conversation', { kind: 'fresh' });
        const fresh = await renderBody(harness, { draft: freshDraft });
        await fresh.pressByTestIdAsync('workflow-editor-parallel-parallel-1-summary');
        expect(fresh.findByTestId(noteId)?.props.children).toBe('workflows.conversation.branchesUseSeparate');
        await fresh.unmount();

        const oneShared = await renderBody(harness, {
            draft: harness.setWorkflowStepExecutionField(freshDraft, 'step-1', 'conversation', { kind: 'shared_run' }),
        });
        await oneShared.pressByTestIdAsync('workflow-editor-parallel-parallel-1-summary');
        expect(oneShared.findByTestId(noteId)).toBeNull();
        await oneShared.unmount();
    });

    it('keeps Undo and Redo as icon controls on a phone, their labels only as accessible names (DESIGN-6 N20)', async () => {
        viewport.window = { width: 390, height: 700 };
        paneState.detailsAvailable = false;
        const harness = await loadHarness();
        const undo = vi.fn();
        const screen = await renderBody(harness, { onRunNow: () => {}, onSave: () => {},
            history: { undoLabel: 'Rename step', redoLabel: null, undo, redo: () => {} } });
        const control = screen.findAll((node) => node.props?.testID === 'workflow-editor-undo' && node.props?.iconName !== undefined);
        expect(control.length).toBeGreaterThan(0);
        // The label is the accessible name, never visible text in the document.
        expect(screen.getTextContent()).not.toContain('workflows.editor.undoAction');
        await screen.pressByTestIdAsync('workflow-editor-undo');
        expect(undo).toHaveBeenCalledTimes(1);
    });

    it('keeps the phone bottom bar above the floating page navigation instead of under it', async () => {
        viewport.window = { width: 390, height: 700 };
        paneState.detailsAvailable = false;
        const harness = await loadHarness();
        const { StyleSheet } = await import('react-native');
        const { SessionCockpitBottomChromeHeightContext } = await import('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry');
        const floatingNavigation = ({ children }: React.PropsWithChildren) =>
            <SessionCockpitBottomChromeHeightContext.Provider value={84}>{children}</SessionCockpitBottomChromeHeightContext.Provider>;
        const screen = await renderBody(harness, { onRunNow: () => {}, onSave: () => {}, saveStatus: { kind: 'unsaved' } },
            { wrapper: floatingNavigation });
        const bar = screen.findHostByTestId('workflow-editor-phone-bar');
        expect(Number(StyleSheet.flatten(bar?.props.style)?.paddingBottom)).toBeGreaterThanOrEqual(84);
    });

    it('recomposes on a phone: the name stays in the page, value rows, Steps | Flow and a bottom bar', async () => {
        viewport.window = { width: 390, height: 700 };
        paneState.detailsAvailable = false;
        const harness = await loadHarness();
        const { KeyboardAwareScrollView } = await import('@/components/ui/keyboardAvoidance/KeyboardAwareScrollView');
        const screen = await renderBody(harness, { onRunNow: () => {}, onSave: () => {}, saveStatus: { kind: 'unsaved' } });

        expect(screen.findAllByType(KeyboardAwareScrollView as never)).toHaveLength(1);
        // The same pane host as a wide page (one tree across widths), without side slots on a phone.
        expect(screen.findAllByType(AppPaneScopeHost)).toHaveLength(1);
        expect(screen.findHostByTestId('workflow-editor-settings-pane')).toBeNull();
        expect(screen.findHostByTestId('workflow-editor-flow-pane')).toBeNull();
        expect(screen.findByTestId('workflow-editor-name')).not.toBeNull();
        const order = [
            'workflow-editor-header',
            'workflow-editor-save-status',
            'workflow-editor-where-row',
            'workflow-editor-view:steps',
            'workflow-editor-steps-presentation',
        ];
        expect(renderedOrder(screen, order)).toEqual(order);
        const bar = screen.findHostByTestId('workflow-editor-phone-bar');
        expect(bar?.findAll((node) => node.props?.testID === 'workflow-editor-run-now').length).toBeGreaterThan(0);
        expect(bar?.findAll((node) => node.props?.testID === 'workflow-editor-phone-save').length).toBeGreaterThan(0);
        await screen.pressByTestIdAsync('workflow-editor-where-row');
        expect(screen.visibleModals()).toHaveLength(1);
        // One Add: the bar's. The document ends without a second, identical Add (lab P1).
        expect(bar?.findAll((node) => node.props?.testID === 'workflow-editor-phone-add').length).toBeGreaterThan(0);
        expect(screen.findHostByTestId('workflow-editor-add-root')).toBeNull();
        // Agent and model is a value row like Where and Triggers (04 §4.10), not a chip inside a row.
        const agentRow = screen.findByTestId('workflow-editor-agent-row');
        expect(agentRow?.findAll((node) => node.props?.testID === 'workflow-editor-header-engine')).toHaveLength(0);
        await screen.unmount();
        // Pressed on a fresh page, it opens the settings where its field is, as Where does.
        const fresh = await renderBody(harness, { onRunNow: () => {}, onSave: () => {}, saveStatus: { kind: 'unsaved' } });
        await fresh.pressByTestIdAsync('workflow-editor-agent-row');
        expect(fresh.visibleModals()).toHaveLength(1);
    });

    it.each([
        { width: 390, hasHistory: false },
        { width: 390, hasHistory: true },
        { width: 1400, hasHistory: false },
    ])('keeps one visible Back in the hosted editor (width: $width, has history: $hasHistory)', async ({ width, hasHistory }) => {
        viewport.window = { width, height: 700 };
        paneState.detailsAvailable = width > 390;
        const harness = await loadHarness();
        const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
        const back = vi.fn();
        const replace = vi.fn();
        const wrapper = ({ children }: React.PropsWithChildren) => (
            <DestinationInstanceHost tabId="workflow-tab" ref={{ kind: 'workflows', params: { id: 'saved' } }}
                pathname="/workflows/saved" focused visible
                navigation={{ push: vi.fn(), back, replace, canGoBack: () => hasHistory }}>
                {children}
            </DestinationInstanceHost>
        );
        const screen = await renderBody(harness, { onRunNow: vi.fn() }, { wrapper });
        const header = screen.findHostByTestId('workflow-editor-header');
        await act(async () => { header?.props.onLayout?.({ nativeEvent: { layout: { width, height: 100, x: 0, y: 0 } } }); });
        const controls = screen.findAll((node) => typeof node.type === 'string' && node.props.testID === 'workflow-back');
        expect(controls).toHaveLength(1);
        const { StyleSheet } = await import('react-native');
        for (let node: typeof controls[number] | undefined = controls[0]; node; node = node.parent ?? undefined) {
            const style = StyleSheet.flatten(node.props.style);
            expect(style?.display).not.toBe('none');
            expect(style?.opacity).not.toBe(0);
        }
        const gutter = screen.findHostByTestId('workflow-editor-header-back-gutter');
        expect(gutter !== null).toBe(width === 1400);
        await screen.pressByTestIdAsync('workflow-back');
        expect(hasHistory ? back : replace).toHaveBeenCalledWith(...(hasHistory ? [] : ['/workflows']));
        expect(hasHistory ? replace : back).not.toHaveBeenCalled();
    });

    it('delegates the rendered Back to the host guard instead of the previous destination', async () => {
        const harness = await loadHarness();
        const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
        const onBack = vi.fn();
        const back = vi.fn();
        const replace = vi.fn();
        const wrapper = ({ children }: React.PropsWithChildren) => <DestinationInstanceHost
            tabId="workflow-tab" ref={{ kind: 'workflows', params: { id: 'new' } }} pathname="/workflows/new"
            focused visible navigation={{ push: vi.fn(), back, replace, canGoBack: () => true }}>
            {children}
        </DestinationInstanceHost>;
        const screen = await renderBody(harness, { onRunNow: vi.fn(), onBack }, { wrapper });
        await screen.pressByTestIdAsync('workflow-back');
        expect(onBack).toHaveBeenCalledOnce();
        expect(back).not.toHaveBeenCalled();
        expect(replace).not.toHaveBeenCalled();
    });
    it.each([false, true])('keeps generic phone chrome and exactly one Back (pushed: %s)', async hasHistory => {
        viewport.window = { width: 390, height: 844 };
        paneState.detailsAvailable = false;
        const harness = await loadHarness();
        const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
        const back = vi.fn(); const replace = vi.fn(); const onBack = vi.fn();
        // The editor names its own generic chrome ("Workflow"); nothing injects it (DESIGN-9 P12).
        const wrapper = ({ children }: React.PropsWithChildren) => <DestinationInstanceHost phone
            tabId="workflow-tab" ref={{ kind: 'workflow', params: { id: 'saved' } }} pathname="/workflows/saved"
            focused visible navigation={{ push: vi.fn(), back, replace, canGoBack: () => hasHistory }}>
            {children}
        </DestinationInstanceHost>;
        const screen = await renderBody(harness, { onRunNow: vi.fn(), onBack }, { wrapper });
        await act(async () => screen.findHostByTestId('workflow-editor-header')?.props.onLayout?.({ nativeEvent: { layout: { width: 390, height: 100, x: 0, y: 0 } } }));
        const chrome = screen.findHostByTestId('workspace-destination-header')!;
        expect(chrome).not.toBeNull();
        expect(chrome.findAll(node => typeof node.type === 'string' && node.children.includes('workflows.page.chromeTitle'))).not.toHaveLength(0);
        const backs = screen.findAll(node => typeof node.type === 'string' && node.props.accessibilityLabel === 'common.back');
        expect(backs).toHaveLength(1);
        // Pushed or deep-linked, Back lives in the bar, so the identity starts on the same edge.
        expect(chrome.findAll(node => node === backs[0])).toHaveLength(1);
        await act(async () => backs[0]!.props.onPress());
        expect(onBack).toHaveBeenCalledOnce();
        expect(back).not.toHaveBeenCalled();
        expect(replace).not.toHaveBeenCalled();
    });

    it('has no duplicate workflow Back when the navigation column already supplies its destination', async () => {
        const harness = await loadHarness();
        const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
        const { AppShellColumnContext } = await import('@/components/navigation/shell/appRail/appShellColumnContext');
        const wrapper = ({ children }: React.PropsWithChildren) => <AppShellColumnContext.Provider value={{ present: true, columnVisible: true }}>
            <DestinationInstanceHost tabId="workflow-tab" ref={{ kind: 'workflows', params: { id: 'saved' } }}
                pathname="/workflows/saved" focused visible navigation={{ push: vi.fn(), back: vi.fn(), replace: vi.fn() }}>
                {children}
            </DestinationInstanceHost>
        </AppShellColumnContext.Provider>;
        const screen = await renderBody(harness, { onRunNow: vi.fn() }, { wrapper });
        expect(screen.findHostByTestId('workflow-back')).toBeNull();
        expect(screen.findHostByTestId('workflow-editor-header-back-gutter')).toBeNull();
    });

    it.each([false, true])('only claims actions from its own navigation owner (hosted: %s)', async (hosted) => {
        const { NavigationRouteContext } = await import('@react-navigation/native');
        const { useStackHeaderActionsPublisher } = await import('@/components/navigation/stackHeaderActions');
        const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
        const { PageHeader } = await import('@/components/ui/layout/PageHeader');
        const retainedAction = vi.fn();
        const ownAction = vi.fn();
        const renderRetainedActions = () => React.createElement('Pressable', { testID: 'retained-route-back', onPress: retainedAction });
        function RetainedHeader() {
            useStackHeaderActionsPublisher('retained-expo-route', renderRetainedActions);
            return null;
        }
        const header = <PageHeader title="Workflow" actions={React.createElement('Pressable', { testID: 'workflow-own-action', onPress: ownAction })} />;
        const screen = await renderScreen(<NavigationRouteContext.Provider value={{ key: 'retained-expo-route', name: 'workflows/[id]' }}>
            <RetainedHeader />
            {hosted ? <DestinationInstanceHost tabId="workflow-tab" ref={{ kind: 'workflows', params: { id: 'saved' } }}
                pathname="/workflows/saved" focused visible
                navigation={{ push: vi.fn(), back: vi.fn(), replace: vi.fn(), canGoBack: () => true }}>{header}</DestinationInstanceHost> : header}
        </NavigationRouteContext.Provider>);
        expect(screen.findHostByTestId('retained-route-back') !== null).toBe(!hosted);
        await screen.pressByTestIdAsync('workflow-own-action');
        expect(ownAction).toHaveBeenCalledOnce();
        if (!hosted) {
            await screen.pressByTestIdAsync('retained-route-back');
            expect(retainedAction).toHaveBeenCalledOnce();
        }
    });

    it('lets a wrapper host keep one page scroll by composing the body without its own', async () => {
        const harness = await loadHarness();
        // The Automation wrappers own their scroll and offer no page commands.
        const screen = await renderBody(harness, { showNameField: false });

        expect(screen.findHostByTestId('workflow-editor-scroll')).toBeNull();
        expect(screen.findHostByTestId('workflow-editor-header')).toBeNull();
        expect(screen.findByTestId('workflow-editor-defaults')).not.toBeNull();
    });

    it('hides an effect the host cannot offer instead of rendering it inert', async () => {
        const harness = await loadHarness();
        const screen = await renderBody(harness, { onRunNow: vi.fn(), saveStatus: { kind: 'unsaved' } });
        expect(screen.findByTestId('workflow-editor-save')).toBeNull();
        expect(screen.findByTestId('workflow-editor-schedule')).toBeNull();
    });

    it('refuses Save without a name through the same gate and states the reason once', async () => {
        const harness = await loadHarness();
        const saved = vi.fn();
        const screen = await renderBody(harness, {
            draft: buildDraft(harness, { name: '  ' }),
            onSave: saved,
            saveStatus: { kind: 'unsaved' },
        });

        await screen.pressByTestIdAsync('workflow-editor-save');
        expect(saved).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(readAnnouncements()[0]).toContain('workflows.save.nameRequired'));
    });

    it('registers Save and Run through the canonical catalog and calls the visible-action owners', async () => {
        const harness = await loadHarness();
        const ran = vi.fn();
        const saved = vi.fn();
        await renderBody(harness, { onRunNow: ran, onSave: saved });
        await act(async () => { expect(executeWorkflowCommand('workflow.save')).toBe(true); });
        expect(saved).toHaveBeenCalledTimes(1);
        await act(async () => { expect(executeWorkflowCommand('workflow.run')).toBe(true); });
        expect(ran).toHaveBeenCalledTimes(1);
        expect(announcementWrites).not.toHaveBeenCalled();
    });

    it('ignores a shortcut repeat while its command is pending, without a second submission', async () => {
        const harness = await loadHarness();
        const ran = vi.fn();
        const saved = vi.fn();
        const screen = await renderBody(harness, { onRunNow: ran, onSave: saved, runPending: true, savePending: true });
        const runButton = screen.findHostByTestId('workflow-editor-run-now');
        const label = runButton?.findAll((node) => typeof node.type === 'string'
            && node.props.children === 'workflows.editor.runNow').at(0);
        // The native renderer has no paint tree. Follow the label's ancestors
        // to distinguish a readable label from the spinner's hidden label.
        const { StyleSheet } = await import('react-native');
        let readable = label !== undefined;
        for (let node: ReactTestInstance | undefined = label; node && node !== runButton; node = node.parent ?? undefined) {
            const style = StyleSheet.flatten(node.props.style);
            if (style?.opacity === 0 || style?.display === 'none') readable = false;
        }
        expect(readable).toBe(true);
        await act(async () => {
            executeWorkflowCommand('workflow.run');
            executeWorkflowCommand('workflow.save');
        });
        expect(ran).not.toHaveBeenCalled();
        expect(saved).not.toHaveBeenCalled();
        // A pending command is already acknowledged by its own label.
        expect(announcementWrites).not.toHaveBeenCalled();
    });

    it('keeps built-in Duplicate beside the primary in the phone bar, not under the value sheet', async () => {
        viewport.window = { width: 390, height: 700 };
        paneState.detailsAvailable = false;
        const harness = await loadHarness();
        const duplicate = vi.fn();
        const screen = await renderBody(harness, { documentPresentation: { editable: false }, onRunNow: vi.fn(), onDuplicate: duplicate });
        const bar = screen.findHostByTestId('workflow-editor-phone-bar');
        expect(bar?.findAll((node) => node.props.testID === 'workflow-editor-duplicate').length).toBeGreaterThan(0);
        await screen.pressByTestIdAsync('workflow-editor-duplicate');
        expect(duplicate).toHaveBeenCalledOnce();
        expect(screen.findByTestId('workflow-editor-save-status')).toBeNull();
    });

    it('keeps a built-in\'s source with the last word of its description, never alone on a line (DESIGN-9 M4)', async () => {
        const harness = await loadHarness();
        const screen = await renderBody(harness, {
            documentPresentation: { editable: false }, onRunNow: vi.fn(), onDuplicate: vi.fn(),
            description: 'Several agents plan side by side, then the plan waits for your review.',
            headerMeta: [{ key: 'catalog', text: 'Built-in' }],
        });
        const texts = screen.root.findAll((node) => typeof node.type === 'string' && typeof node.props.children === 'string')
            .map((node) => node.props.children as string);
        // No break opportunity around the separator: "review. · Built-in" wraps as one.
        expect(texts).toContain('Several agents plan side by side, then the plan waits for your review.\u00A0·\u00A0Built-in');
    });

    /**
     * A shortcut, press or host intent that cannot proceed is refused audibly
     * with the same reason the page shows beside the control, and focus lands
     * on the step that carries the cause. It never vanishes silently and never
     * reaches the effect owner.
     */
    it('refuses a blocked shortcut with the visible reason and focuses the offending step', async () => {
        const harness = await loadHarness();
        const ran = vi.fn();
        const onSelectBlock = vi.fn();
        await renderBody(harness, {
            draft: buildDraft(harness, { text: '' }),
            onRunNow: ran,
            onSelectBlock,
        });
        await act(async () => { expect(executeWorkflowCommand('workflow.run')).toBe(true); });

        expect(ran).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(readAnnouncements()).toHaveLength(1));
        expect(readAnnouncements()[0]).toContain('workflows.a11y.commandRefused');
        // The refusal names what to fix, in the step's own words (DESIGN-5 P3).
        expect(readAnnouncements()[0]).toContain('workflows.issue.emptyPrompt');
        expect(onSelectBlock).toHaveBeenCalledWith('analyze');
        expect(promptFocus).toHaveBeenCalledTimes(1);
    });

    it('routes a host intent through the same gate as the visible action', async () => {
        const harness = await loadHarness();
        const ran = vi.fn();
        const scheduled = vi.fn();
        const commandsRef = React.createRef<import('./WorkflowEditorBody').WorkflowEditorCommands | null>();
        const blocked = await renderBody(harness, {
            draft: buildDraft(harness, { text: '' }),
            onRunNow: ran,
            onSchedule: scheduled,
            projectTarget: { machineId: 'machine-1', directory: '/Users/me/project' },
            commandsRef,
        });
        await act(async () => {
            commandsRef.current!.runNow();
            commandsRef.current!.schedule();
        });
        expect(ran).not.toHaveBeenCalled();
        expect(scheduled).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(readAnnouncements().at(-1)).toContain('workflows.a11y.commandRefused'));
        await blocked.unmount();

        const eligible = await renderBody(harness, {
            onRunNow: ran,
            onSchedule: scheduled,
            authoringFacts: { agentTargets: [{ id: 'agent:happier.agent.claude/claude',
                label: 'Claude Code', target: AGENT_TARGET, agentId: 'claude' }] },
            projectTarget: { machineId: 'machine-1', directory: '/Users/me/project' },
            commandsRef,
        });
        await act(async () => {
            commandsRef.current!.runNow();
            commandsRef.current!.schedule();
        });
        expect(ran).toHaveBeenCalledTimes(1);
        // Schedule opens this page's trigger settings; it is not a second host effect.
        expect(scheduled).not.toHaveBeenCalled();
        await eligible.unmount();
    });

    /**
     * Local invalid text is never a private editor fact: it enters the draft as
     * an unresolved value, so the one canonical validation blocks Run, Save,
     * Schedule and Export together and each states the same cause.
     */
    it('blocks every command on an unresolved input default and states the cause on each', async () => {
        const harness = await loadHarness();
        const handlers = { onRunNow: vi.fn(), onSave: vi.fn(), onSchedule: vi.fn(), onExportJson: vi.fn() };
        let draft: WorkflowEditorDraft = {
            ...buildDraft(harness),
            inputs: [{ name: 'count', valueType: 'number', required: false }],
        };
        function Controlled(): React.ReactElement {
            const [current, setCurrent] = React.useState(draft);
            draft = current;
            return React.createElement(harness.WorkflowEditorBody, {
                draft: current,
                onChange: setCurrent,
                machineName: 'Mac Studio',
                composerScope: MACHINE_COMPOSER_SCOPE,
                selectedBlockId: null,
                onSelectBlock: () => {},
                onCustomizeBlock: () => {},
                view: 'steps',
                onChangeView: () => {},
                projectTarget: { machineId: 'machine-1', directory: '/Users/me/project' },
                ...handlers,
            } as never);
        }
        const screen = await renderScreen(React.createElement(Controlled));
        // Inputs are Workflow settings: open the pane that holds them.
        await screen.pressByTestIdAsync('workflow-editor-settings-toggle');
        await act(async () => { screen.changeTextByTestId('workflow-editor-input-0-default', 'many'); });

        expect(Number.isNaN(draft.inputs[0]?.default)).toBe(true);
        expect(screen.findByTestId('workflow-editor-input-0-default')?.props.value).toBe('many');
        // The repair is the field's own error, under it and announced (the canonical field owner).
        expect(screen.findByTestId('workflow-editor-input-0-default.error')?.props.accessibilityRole).toBe('alert');
        await act(async () => {
            executeWorkflowCommand('workflow.save');
            executeWorkflowCommand('workflow.run');
        });
        expect(handlers.onSave).not.toHaveBeenCalled();
        expect(handlers.onRunNow).not.toHaveBeenCalled();
        // Both refusals state the one canonical cause.
        await vi.waitFor(() => expect(readAnnouncements()
            .filter(message => message.includes('workflows.a11y.commandRefused'))).toHaveLength(2));
        for (const message of readAnnouncements()) {
            expect(message).toContain('workflows.issue.fieldInvalid');
        }

        await act(async () => { screen.changeTextByTestId('workflow-editor-input-0-default', '3'); });
        expect(draft.inputs[0]?.default).toBe(3);
        await act(async () => { executeWorkflowCommand('workflow.run'); });
        expect(handlers.onRunNow).toHaveBeenCalledTimes(1);
    });

    it('authors a step result-wait timeout through the inspector and omits it when cleared', async () => {
        const harness = await loadHarness();
        let draft: WorkflowEditorDraft = buildDraft(harness);
        function Controlled(): React.ReactElement {
            const [current, setCurrent] = React.useState(draft);
            draft = current;
            return React.createElement(harness.WorkflowEditorBody, {
                draft: current,
                onChange: setCurrent,
                machineName: 'Mac Studio',
                composerScope: MACHINE_COMPOSER_SCOPE,
                selectedBlockId: 'analyze',
                onSelectBlock: () => {},
                onCustomizeBlock: () => {},
                view: 'steps',
                onChangeView: () => {},
                inspectorGroupDisclosure: new Map([['block:analyze:advanced', true]]),
            } as never);
        }
        const screen = await renderScreen(React.createElement(Controlled));
        await screen.pressByTestIdAsync('workflow-editor-step-analyze-customize');
        // The step options popover, over the same draft owner; the deadline is under Advanced.
        const options = screen;
        await act(async () => { options.changeTextByTestId('workflow-editor-inspector-timeout', '5000'); });
        expect((draft.blocks[0] as { timeoutMs?: number }).timeoutMs).toBe(5000);
        expect(harness.validateWorkflowEditorDraft(draft).normalizedDefinition?.blocks[0]).toMatchObject({ timeoutMs: 5000 });
        await act(async () => { options.changeTextByTestId('workflow-editor-inspector-timeout', ''); });
        expect(draft.blocks[0]).not.toHaveProperty('timeoutMs');
    });

    /**
     * 04 §5.2 (block subject): each Step options row writes the step's own
     * property and its "Workflow default" or off state deletes it, so the step
     * inherits again. Result and Only run when push their editors into the same
     * popover, and the document's Step options chip reads what differs.
     */
    it('authors Runs in, Review before continuing, Result and Only run when as own step properties', async () => {
        const harness = await loadHarness();
        let draft: WorkflowEditorDraft = buildDraft(harness);
        function Controlled(): React.ReactElement {
            const [current, setCurrent] = React.useState(draft);
            draft = current;
            return React.createElement(harness.WorkflowEditorBody, {
                draft: current,
                onChange: setCurrent,
                machineName: 'Mac Studio',
                composerScope: MACHINE_COMPOSER_SCOPE,
                selectedBlockId: 'analyze',
                onSelectBlock: () => {},
                onCustomizeBlock: () => {},
                view: 'steps',
                onChangeView: () => {},
                executionTarget: 'session',
            } as never);
        }
        const screen = await renderScreen(React.createElement(Controlled));
        await screen.pressByTestIdAsync('workflow-editor-step-analyze-customize');

        await screen.pressByTestIdAsync('workflow-editor-inspector-runs-in:detached_run');
        expect(draft.blocks[0]).toMatchObject({ execution: { executionTarget: { kind: 'detached_run' } } });
        await screen.pressByTestIdAsync('workflow-editor-inspector-runs-in:default');
        expect(draft.blocks[0]).not.toHaveProperty('execution');

        await act(async () => { screen.findByTestId('workflow-editor-inspector-review-switch')?.props.onValueChange(true); });
        expect(draft.blocks[0]).toMatchObject({ pauseForReview: true });
        expect(screen.findByTestId('workflow-editor-step-analyze-inheritance')?.props.children)
            .toBe('workflows.page.inspector.reviewsBeforeContinuing');
        await act(async () => { screen.findByTestId('workflow-editor-inspector-review-switch')?.props.onValueChange(false); });
        expect(draft.blocks[0]).not.toHaveProperty('pauseForReview');

        await screen.pressByTestIdAsync('workflow-editor-inspector-result');
        await screen.pressByTestIdAsync('workflow-editor-inspector-result-kind:fields');
        expect(draft.blocks[0]).toMatchObject({ result: { kind: 'json', schema: {
            type: 'object', properties: { field: { type: 'string' } }, required: ['field'], additionalProperties: false,
        } } });
        await screen.pressByTestIdAsync('workflow-editor-inspector-back');

        await screen.pressByTestIdAsync('workflow-editor-inspector-only-when');
        await screen.pressByTestIdAsync('workflow-editor-inspector-condition-add-condition');
        expect(draft.blocks[0]).toHaveProperty('onlyWhen');
        // The document states the condition quietly; it is edited in Step options only.
        expect(screen.findByTestId('workflow-editor-step-analyze-only-when')).not.toBeNull();
        await screen.pressByTestIdAsync('workflow-editor-inspector-condition-remove');
        expect(draft.blocks[0]).not.toHaveProperty('onlyWhen');
    });

    it('offers Workflow default first in a step Conversation and deletes the step choice when it is picked', async () => {
        const harness = await loadHarness();
        const changed = vi.fn();
        const pinned = harness.setWorkflowStepExecutionField(buildDraft(harness), 'analyze', 'conversation', { kind: 'shared_run' });
        const screen = await renderBody(harness, { draft: pinned, onChange: changed });
        await screen.pressByTestIdAsync('workflow-editor-step-analyze-customize');

        const field = segmentedField(screen, 'workflow-editor-inspector-continuity-conversation');
        expect(field.props.options[0]).toMatchObject({ id: 'default' });
        // The option equal to the default is still offered, and it is what is pinned now (F24).
        expect(field.props.value).toBe('shared_run');
        await act(async () => { field.props.onChange('default'); });
        expect(changed.mock.calls.at(-1)?.[0].blocks[0]).not.toHaveProperty('execution');
    });

    it('opens Step options for a Wait for you and a Side by side group with their own rows', async () => {
        const harness = await loadHarness();
        const parallel = harness.createWorkflowBlock('parallel', new Set(['analyze']));
        const wait = harness.createWorkflowLeafBlock({ kind: 'wait' }, new Set(['analyze', parallel.id]));
        const draft = { ...buildDraft(harness), blocks: [...buildDraft(harness).blocks, parallel, wait] };
        const screen = await renderBody(harness, { draft });

        await screen.pressByTestIdAsync(`workflow-editor-wait-${wait.id}-options`);
        expect(screen.findByTestId('workflow-editor-inspector-result')).not.toBeNull();
        expect(screen.findByTestId('workflow-editor-inspector-only-when')).not.toBeNull();
        // A Wait has no agent turn: no Runs in, no Agent and model.
        expect(screen.findByTestId('workflow-editor-inspector-runs-in')).toBeNull();
        await screen.pressByTestIdAsync('workflow-editor-inspector-done');

        await screen.pressByTestIdAsync(`workflow-editor-parallel-${parallel.id}-summary`);
        expect(screen.findByTestId(`workflow-editor-inspector-parallel-${parallel.id}-failure-policy:fail_stop`)).not.toBeNull();
        expect(screen.findByTestId('workflow-editor-inspector-only-when')).not.toBeNull();
    });

    /**
     * 07 J19 / 04 §5.2 E17: dropping a Session onto an Agent step writes the
     * same `existing_session` binding as Conversation › A session…; a Session on
     * another machine than the workflow's Where is refused and writes nothing.
     */
    it('binds a Session dropped onto a step and refuses one from another machine', async () => {
        const harness = await loadHarness();
        const { useEntityDragDropRuntime } = await import('@/components/ui/treeDragDrop');
        const scope = await bindingHome();
        const changed = vi.fn();
        const ran = vi.fn();
        const saved = vi.fn();
        const initial = buildDraft(harness);
        let runtime: ReturnType<typeof useEntityDragDropRuntime> | undefined;
        function Realm() { runtime = useEntityDragDropRuntime(); return null; }
        const screen = await renderBody(harness, {
            draft: initial, sessionBindingScope: scope,
            onRunNow: ran, onSave: saved,
            onChange: changed,
            projectTarget: { machineId: 'machine-1', directory: '/Users/me/project' },
            projectMachines: [
                { id: 'machine-1', metadata: { displayName: 'Mac Studio', homeDir: '/Users/me' } },
                { id: 'machine-2', metadata: { displayName: 'Linux box', homeDir: '/home/me' } },
            ],
            sessionDropCandidates: [
                { sessionId: 'here', machineId: 'machine-1', label: 'Fix login' },
                { sessionId: 'there', machineId: 'machine-2', label: 'Elsewhere' },
            ],
        }, { wrapper: ({ children }) => <><Realm />{children}</>, createNodeMock: element => {
            // The renderer supplies a host descriptor, not a React element, at this OS geometry boundary.
            const props: unknown = element.props;
            return props !== null && typeof props === 'object' && 'testID' in props
                && props.testID === 'workflow-editor-step-analyze-session-drop'
                ? { getBoundingClientRect: () => ({ x: 10, y: 10, left: 10, top: 10, width: 500, height: 200 }) } : null;
        } });
        let sessionId = 'there';
        const retireSource = runtime!.registerSource({ id: 'workflow-source', scope, isCurrent: () => true,
            getItem: () => ({ kind: 'session', scope, address: { serverId: scope.serverId, sessionId } }) });
        const target = runtime!.getDestinations('workflow-source').find(destination => destination.label === 'workflows.editor.addStep')!;
        expect(target.admission).toMatchObject({ status: 'refused', reason: { code: 'workflow_where_machine_mismatch' } });
        const drop = async () => {
            let result: Awaited<ReturnType<NonNullable<typeof runtime>['perform']>> = null;
            await act(async () => {
                runtime!.begin('workflow-source'); runtime!.move({ x: 20, y: 20 });
                result = await runtime!.release();
            });
            return result;
        };

        const refused = await drop();
        // Never inserted as text into the composer, and nothing is bound.
        expect(refused).toMatchObject({ status: 'refused' });
        expect(changed).not.toHaveBeenCalled();

        sessionId = 'here';
        await act(async () => { runtime!.begin('workflow-source')!.choose(target.targetId); runtime!.cancel(); });
        expect(changed).not.toHaveBeenCalled();
        expect(await drop()).toMatchObject({ status: 'applied' });
        expect(changed).toHaveBeenCalledTimes(1);
        expect(changed.mock.calls[0]?.[0].blocks[0].execution.conversation)
            .toEqual({ kind: 'existing_session', sessionId: 'here', machineId: 'machine-1' });
        expect(changed.mock.calls[0]?.[0]).toEqual({ ...initial, blocks: [{ ...initial.blocks[0], execution: {
            conversation: { kind: 'existing_session', sessionId: 'here', machineId: 'machine-1' },
        } }] });
        expect(ran).not.toHaveBeenCalled();
        expect(saved).not.toHaveBeenCalled();
        await act(async () => { retireSource(); });
        await screen.unmount();
    });

    /**
     * WF-05 / plan 04 §3.2: a step can continue an arbitrary existing Session,
     * chosen through the canonical Session picker from the host's candidates,
     * and the choice records the exact Session and Machine the coordinator
     * requires. Without candidates the choice is stated unavailable, and a
     * recorded Session this host cannot list stays visible by its identity.
     */
    it('authors an existing Session continuation from the host-supplied candidates', async () => {
        const harness = await loadHarness();
        const scope = await bindingHome();
        const changed = vi.fn();
        const screen = await renderBody(harness, {
            sessionBindingScope: scope,
            onChange: changed,
            existingSessions: [
                { sessionId: 'session-1', machineId: 'machine-1', label: 'Fix login' },
                { sessionId: 'session-2', machineId: 'machine-1', label: 'Refactor sync' },
            ],
        });
        const field = segmentedField(screen, 'workflow-editor-defaults-continuity-conversation');
        const existing = field.props.options.find((option) => option.id === 'continue');
        expect(existing).toMatchObject({ label: 'workflows.page.inspector.conversationContinue' });
        expect(existing?.unavailableReason).toBeUndefined();
        expect(screen.findByTestId('workflow-editor-defaults-continuity-conversation-session-picker')).toBeNull();

        // "A session…" opens the canonical picker; nothing is authored until a Session is chosen.
        await act(async () => { field.props.onChange('continue'); });
        expect(changed).not.toHaveBeenCalled();
        expect(screen.findHostByTestId('workflow-editor-defaults-continuity-conversation-session-picker')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Fix login');
        expect(screen.getTextContent()).toContain('Refactor sync');
        await screen.pressByTestIdAsync('workflow-editor-defaults-continuity-conversation-session-session-2');

        expect(changed).toHaveBeenCalledTimes(1);
        const next = changed.mock.calls[0]?.[0];
        expect(next.defaults.conversation).toEqual({ kind: 'existing_session', sessionId: 'session-2', machineId: 'machine-1' });
        expect(harness.validateWorkflowEditorDraft(next).normalizedDefinition?.defaults.conversation)
            .toEqual({ kind: 'existing_session', sessionId: 'session-2', machineId: 'machine-1' });
    });

    it('retires mounted conversation binding before passive editor cleanup', async () => {
        const harness = await loadHarness();
        const scope = await bindingHome();
        const { invokeWorkflowAuthoringAction } = await import('@/sync/ops/actions/workflowAuthoringAction');
        const draft = buildDraft(harness);
        const changed = vi.fn();
        let result: ReturnType<typeof invokeWorkflowAuthoringAction> | undefined;
        function Host({ shown }: { shown: boolean }) {
            React.useLayoutEffect(() => {
                if (!shown) result = invokeWorkflowAuthoringAction({ actionId: 'workflow.authoring.conversation.bind',
                    input: { scope, draftId: draft.draftId, stepId: 'analyze', address: { serverId: scope.serverId, sessionId: 'session' } },
                    context: { serverId: scope.serverId, runtimeAccountId: scope.accountId },
                });
            }, [shown]);
            return shown ? <harness.WorkflowEditorBody draft={draft} onChange={changed} machineName="Mac Studio"
                composerScope={MACHINE_COMPOSER_SCOPE} sessionBindingScope={scope} selectedBlockId={null}
                onSelectBlock={() => {}} onCustomizeBlock={() => {}} view="steps" onChangeView={() => {}}
                sessionDropCandidates={[{ sessionId: 'session', machineId: 'machine-1', label: 'Review' }]} /> : null;
        }
        const screen = await renderScreen(<Host shown />);
        await screen.update(<Host shown={false} />);
        expect(await result).toEqual({ status: 'unavailable' });
        expect(changed).not.toHaveBeenCalled();
    });

    it('shows a recorded existing Session and offers none where it cannot be bound', async () => {
        const harness = await loadHarness();
        const scope = await bindingHome();
        const { createSessionFixture } = await import('@/dev/testkit');
        const session = createSessionFixture({ id: 'session-9', serverId: scope.serverId, metadata: {
            ...createSessionFixture().metadata!, name: 'Ship release', machineId: 'machine-1',
        } });
        getStorage().setState({ isDataReady: true, sessions: {},
            sessionListRowsByServerId: { [scope.serverId]: { [session.id]: session } } });
        const recorded = harness.setWorkflowDefaultField(
            buildDraft(harness),
            'conversation',
            { kind: 'existing_session', sessionId: 'session-9', machineId: 'machine-1' },
        );
        const listed = await renderBody(harness, {
            draft: recorded,
            sessionBindingScope: scope,
            existingSessions: [{ sessionId: 'session-9', machineId: 'machine-1', label: 'Ship release' }],
        });
        const field = segmentedField(listed, 'workflow-editor-defaults-continuity-conversation');
        expect(field.props.value).toBe('continue');
        // The consequence line names the recorded Session.
        await waitForHomeGovernance(() => expect(String(segmentedField(listed,
            'workflow-editor-defaults-continuity-conversation').props.subtitle)).toContain('Ship release'));
        await listed.unmount();

        await act(async () => { getStorage().setState(state => ({ sessionListRowsByServerId: {
            ...state.sessionListRowsByServerId, [scope.serverId]: {},
        } })); });
        const unlisted = await renderBody(harness, { draft: recorded, sessionBindingScope: scope });
        expect(unlisted.getTextContent()).toContain('session-9');
        expect(unlisted.getTextContent()).not.toContain('Ship release');
        await unlisted.unmount();

        const none = await renderBody(harness);
        // A host that cannot bind a Session offers no Session choice at all.
        const noneField = segmentedField(none, 'workflow-editor-defaults-continuity-conversation');
        expect(noneField.props.options.map((option) => option.id)).not.toContain('continue');
        await none.unmount();
    });

    it('keeps a pristine one-prompt draft free of invitations and validation text', async () => {
        const harness = await loadHarness();
        const empty = await renderBody(harness, {
            draft: buildDraft(harness, { text: '' }),
            onRunNow: () => {},
            onSave: () => {},
            saveStatus: { kind: 'notSaved' },
            projectTarget: null,
            machineName: null,
        });
        const text = empty.getTextContent();
        expect(text).not.toContain('workflows.editor.firstPromptTitle');
        expect(text).not.toContain('workflows.issue.');
        expect(text).not.toContain('workflows.page.issuesToFix');
        expect(text).toContain('workflows.page.saveStatus.notSaved');
    });

    it('keeps the machine control visibly unresolved rather than fabricating a default', async () => {
        const harness = await loadHarness();
        const screen = await renderBody(harness, { machineName: null });
        // It names the missing Machine and folder, not an unrelated Agent issue.
        expect(screen.getTextContent()).toContain('workflows.editor.targetRequired');
        expect(screen.getTextContent()).not.toContain('workflows.issue.target_unavailable');
    });

    it('switches to Flow and restores the exact prompt focus through the existing focus owner', async () => {
        const harness = await loadHarness();
        function ControlledBody() {
            const [view, setView] = React.useState<'steps' | 'flow'>('flow');
            const [selectedBlockId, setSelectedBlockId] = React.useState<string | null>('analyze');
            return React.createElement(harness.WorkflowEditorBody, {
                draft: buildDraft(harness),
                onChange: () => {},
                machineName: 'Mac Studio',
                composerScope: MACHINE_COMPOSER_SCOPE,
                selectedBlockId,
                onSelectBlock: setSelectedBlockId,
                onCustomizeBlock: setSelectedBlockId,
                view,
                onChangeView: setView,
                onRunNow: () => {},
            });
        }
        // The Steps | Flow switch is the phone's; wide layouts show Flow as a pane.
        paneState.detailsAvailable = false;
        const screen = await renderScreen(React.createElement(ControlledBody));

        expect(screen.findByTestId('workflow-editor-flow-node-analyze')).not.toBeNull();
        await screen.pressByTestIdAsync('workflow-editor-flow-edit-step');
        expect(screen.findByTestId('workflow-editor-step-analyze-prompt')).not.toBeNull();
        expect(promptFocus).toHaveBeenCalledTimes(1);
    });

    it('offers Each step runs in as one value choice and states an unavailable class instead of downgrading it', async () => {
        const harness = await loadHarness();
        const { resolveWorkflowRunAsTargets } = await import('../run/workflowRunAsTargets');
        const onChangeExecutionTarget = vi.fn();
        const screen = await renderBody(harness, {
            selectedBlockId: 'analyze',
            executionTarget: 'session',
            runAsTargets: resolveWorkflowRunAsTargets({ detachedExecutionRun: 'unsupported' }),
            onChangeExecutionTarget,
        });

        expect(screen.findHostByTestId('workflow-editor-run-as:session')?.props.accessibilityRole).toBe('radio');
        expect(screen.findHostByTestId('workflow-editor-run-as:session')?.props.accessibilityState)
            .toMatchObject({ checked: true });
        expect(screen.findByTestId('workflow-editor-run-as:attached_run')).toBeNull();
        expect(screen.findByTestId('workflow-editor-run-as:detached_run')).not.toBeNull();
        // The unavailable class keeps its reason on the row (SegmentedChoiceItem's own contract).
        expect(screen.getTextContent())
            .toContain('workflows.page.unavailable.machine_does_not_support_detached_runs');
        // It is the run default, never a step override.
        expect(screen.findByTestId('workflow-editor-inspector-run-as')).toBeNull();
    });

    it('keeps the active step composer mounted across Steps and Flow instead of remounting it', async () => {
        const harness = await loadHarness();
        function ControlledBody() {
            const [view, setView] = React.useState<'steps' | 'flow'>('steps');
            return React.createElement(harness.WorkflowEditorBody, {
                draft: buildDraft(harness),
                onChange: () => {},
                machineName: 'Mac Studio',
                composerScope: MACHINE_COMPOSER_SCOPE,
                selectedBlockId: 'analyze',
                onSelectBlock: () => {},
                onCustomizeBlock: () => {},
                view,
                onChangeView: setView,
                onRunNow: () => {},
            });
        }
        paneState.detailsAvailable = false;
        const screen = await renderScreen(React.createElement(ControlledBody));
        await activatePromptPreview(screen, 'workflow-editor-step-analyze-prompt');
        const originalComposer = stepComposer(screen, 'analyze');
        const originalRef = stepComposerRef(screen, 'analyze');

        await screen.pressByTestIdAsync('workflow-editor-view:flow');
        // The document stays mounted so caret, selection and any active IME or
        // dictation binding survive the reading-mode switch, but it must not be
        // reachable by pointer or assistive technology while Flow is showing.
        const hiddenSteps = screen.findByTestId('workflow-editor-steps-presentation');
        expect(hiddenSteps).not.toBeNull();
        expect(hiddenSteps?.props.accessibilityElementsHidden).toBe(true);
        expect(hiddenSteps?.props.importantForAccessibility).toBe('no-hide-descendants');
        expect(hiddenSteps?.props.pointerEvents).toBe('none');

        await screen.pressByTestIdAsync('workflow-editor-view:steps');
        expect(stepComposer(screen, 'analyze')).toBe(originalComposer);
        expect(stepComposerRef(screen, 'analyze')).toBe(originalRef);
    });

    /**
     * Moving a step into a group re-parents it, which React commits as a remount.
     * Everything the portable document deliberately drops — which of two equal
     * tokens a mention is bound to, staged attachment bytes, the caret — exists
     * only in the live composer, so the move must not rebuild it. The authored
     * final output names the moved step, and relocation is not deletion.
     */
    it('keeps the live prompt document, exact duplicate-token mention, caret and staged bytes when a step moves into a loop', async ({ onTestFinished }) => {
        vi.useFakeTimers();
        onTestFinished(() => { vi.useRealTimers(); });
        const harness = await loadHarness();
        const stagedContent = {
            kind: 'stagedMedia' as const,
            handle: {
                v: 1 as const,
                id: 'stage-42',
                executionTarget: { serverId: 'server-a', machineId: 'machine-1' },
                owner: { pluginId: 'acme.issues', localId: 'issue' },
                mediaKind: 'image' as const,
                mimeType: 'image/png',
                name: 'issue-42.png',
                sizeBytes: 12,
                sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            },
        };
        // Staged bytes only ever exist in the live composer, so the fixture seeds
        // them where they live. The first published document strips them back out,
        // which is exactly why custody — not the draft — has to retain them.
        const stagedAttachment = {
            v: 1 as const,
            instanceId: 'attachment-staged',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: 'issue-42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
            content: stagedContent,
        };
        const promptText = 'Compare @issue with @issue';
        const secondTokenStart = 'Compare @issue with '.length;
        let draft = harness.setWorkflowFinalOutput(
            harness.setWorkflowDefaultField(
                harness.createWorkflowEditorDraft({
                    draftId: 'draft-1',
                    name: 'Review',
                    blocks: [
                        {
                            kind: 'loop',
                            id: 'triage',
                            repetition: { kind: 'count', count: { kind: 'literal', value: 2 } },
                            body: [],
                        },
                        {
                            kind: 'step',
                            id: 'analyze',
                            document: {
                                text: promptText,
                                references: [],
                                attachments: [stagedAttachment],
                            },
                            input: [],
                            result: { kind: 'text' },
                        },
                    ] as never,
                }),
                'agentTarget',
                AGENT_TARGET,
            ),
            { kind: 'result', producer: { blockId: 'analyze', scope: { kind: 'current' } }, path: [] },
        );
        let renderDraft = (_next: WorkflowEditorDraft) => {};
        function ControlledBody() {
            const [current, setCurrent] = React.useState(draft);
            renderDraft = setCurrent as (next: WorkflowEditorDraft) => void;
            return React.createElement(harness.WorkflowEditorBody, {
                draft: current,
                onChange: (next: WorkflowEditorDraft) => {
                    draft = next as typeof draft;
                    setCurrent(next as typeof current);
                },
                machineName: 'Mac Studio',
                composerScope: MACHINE_COMPOSER_SCOPE,
                selectedBlockId: 'analyze',
                onSelectBlock: () => {},
                onCustomizeBlock: () => {},
                view: 'steps',
                onChangeView: () => {},
            });
        }
        const screen = await renderScreen(React.createElement(ControlledBody));

        expect(liveComposerCount(screen)).toBe(0);
        await activatePromptPreview(screen, 'workflow-editor-step-analyze-prompt');
        const composerRef = stepComposerRef(screen, 'analyze');
        expect(composerRef).toBeDefined();
        const initial = readComposerPresentationSnapshot(composerRef);
        if (!initial) throw new Error('Expected a mounted step composer');

        // A mention bound to the SECOND of two identical tokens: re-deriving it
        // from the portable form would silently move it to the first.
        await act(async () => {
            expect(applyComposerPresentationTransaction({
                ref: composerRef,
                transaction: {
                    expectedRevision: initial.revision,
                    operations: [{
                        kind: 'reference.insert',
                        reference: {
                            kind: 'partner.reference',
                            ref: 'partner:issue-42',
                            token: '@issue',
                            label: 'Issue #42',
                            start: secondTokenStart,
                            end: secondTokenStart + '@issue'.length,
                        },
                    }],
                },
            })).toEqual({ status: 'applied', revision: initial.revision + 1 });
        });
        const caret = { start: 8, end: 14 };
        const persistence = composerProps(screen, 'analyze').inputPersistence as Readonly<{
            onSelectionChangePersist: (selection: typeof caret, textLength: number) => void;
        }> | undefined;
        expect(persistence).toBeDefined();
        await act(async () => {
            persistence?.onSelectionChangePersist(caret, promptText.length);
        });

        await screen.pressByTestIdAsync('workflow-editor-step-analyze-actions');
        await act(async () => { await vi.runOnlyPendingTimersAsync(); });
        await screen.pressByTestIdAsync('workflow-editor-step-analyze-actions-moveIn');
        await act(async () => { await vi.runOnlyPendingTimersAsync(); });

        const loop = draft.blocks[0];
        expect(loop?.kind === 'loop' ? loop.body.map((block) => block.id) : []).toEqual(['analyze']);
        // One composer identity: the document was re-placed, not rebuilt.
        expect(stepComposerRef(screen, 'analyze')).toBe(composerRef);
        expect(readComposerPresentationSnapshot(composerRef)).toMatchObject({
            text: promptText,
            references: [{
                ref: 'partner:issue-42',
                start: secondTokenStart,
                end: secondTokenStart + '@issue'.length,
            }],
            attachments: [{ instanceId: 'attachment-staged', content: stagedContent }],
        });
        expect(composerProps(screen, 'analyze').inputPersistence).toMatchObject({
            initialSelection: caret,
        });
        // Relocation is not deletion: the authored final output still names it.
        expect(draft.finalOutput?.producer.blockId).toBe('analyze');
        expect(renderDraft).toBeTypeOf('function');
    });

    /**
     * A prompt composed in another composer — New Session, through the
     * Automation chip — arrives as a portable draft plus the exact live
     * document. The step composer must open on the exact one: the mention bound
     * to the second of two equal tokens, the staged bytes and the caret. Those
     * bytes cannot be saved, so the host hears the canonical refusal rather
     * than a Save that silently drops them.
     */
    it.each(['Compare @issue with @issue', ''])('opens a seeded step on the exact document and blocks staged bytes with prompt %j', async (text) => {
        const harness = await loadHarness();
        const secondTokenStart = 'Compare @issue with '.length;
        const selection = text.length === 0 ? { start: 0, end: 0 } : { start: 4, end: 9 };
        const portableAttachment = {
            v: 1 as const,
            instanceId: 'attachment-staged',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: 'issue-42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
        };
        const stagedContent = {
            kind: 'stagedMedia' as const,
            handle: {
                v: 1 as const,
                id: 'stage-42',
                executionTarget: { serverId: 'server-a', machineId: 'machine-1' },
                owner: { pluginId: 'acme.issues', localId: 'issue' },
                mediaKind: 'image' as const,
                mimeType: 'image/png',
                name: 'issue-42.png',
                sizeBytes: 12,
                sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            },
        };
        const draft = harness.setWorkflowDefaultField(
            harness.createWorkflowEditorDraft({
                draftId: text.length === 0 ? 'seeded-empty-prompt' : 'seeded-written-prompt',
                name: 'Review',
                blocks: [{
                    kind: 'step',
                    id: 'analyze',
                    // The portable projection a saved definition may hold.
                    document: {
                        text,
                        references: text.length === 0 ? [] : [{
                            kind: 'partner.reference',
                            ref: 'partner:issue-42',
                            token: '@issue',
                            label: 'Issue #42',
                        }],
                        attachments: [portableAttachment],
                    },
                    input: [],
                    result: { kind: 'text' },
                }] as never,
            }),
            'agentTarget',
            AGENT_TARGET,
        );
        const onChange = vi.fn();
        const onValidationChange = vi.fn();
        const onSave = vi.fn();
        const onRunNow = vi.fn();
        const screen = await renderScreen(React.createElement(harness.WorkflowEditorBody, {
            draft,
            onChange,
            machineName: 'Mac Studio',
            composerScope: MACHINE_COMPOSER_SCOPE,
            selectedBlockId: 'analyze',
            onSelectBlock: () => {},
            onCustomizeBlock: () => {},
            view: 'steps',
            onChangeView: () => {},
            composerSeeds: [{
                blockId: 'analyze',
                document: {
                    text,
                    structuredInputMentions: text.length === 0 ? [] : [{
                        kind: 'partner.reference',
                        ref: 'partner:issue-42',
                        label: 'Issue #42',
                        tokenText: '@issue',
                        start: secondTokenStart,
                        end: secondTokenStart + '@issue'.length,
                    }],
                    composerAttachments: [{ ...portableAttachment, content: stagedContent }],
                },
                selection,
            }] as never,
            onValidationChange,
            onSave,
            onRunNow,
            saveStatus: { kind: 'unsaved' },
            projectTarget: { machineId: 'machine-1', directory: '/Users/me/project' },
        }));

        expect(liveComposerCount(screen)).toBe(0);
        const composerRef = stepDocumentRef(screen, 'analyze');
        expect(readComposerPresentationSnapshot(composerRef)).toMatchObject({
            text,
            references: text.length === 0 ? [] : [{
                ref: 'partner:issue-42',
                start: secondTokenStart,
                end: secondTokenStart + '@issue'.length,
            }],
            attachments: [{ instanceId: 'attachment-staged', content: stagedContent }],
        });
        await activatePromptPreview(screen, 'workflow-editor-step-analyze-prompt');
        expect(composerProps(screen, 'analyze').inputPersistence).toMatchObject({
            initialSelection: selection,
        });
        // Opening on the exact document is not an authored edit.
        expect(onChange).not.toHaveBeenCalled();
        expect(onValidationChange.mock.lastCall?.[0]).toMatchObject({
            valid: false,
            issues: expect.arrayContaining([expect.objectContaining({
                code: 'unsupported_persisted_attachment',
                blockId: 'analyze',
            })]),
        });
        const validation = onValidationChange.mock.lastCall?.[0];
        const errors = validation.issues.filter((entry: { severity: string }) => entry.severity === 'error');
        expect(errors).toHaveLength(text.length === 0 ? 2 : 1);
        await act(async () => {
            executeWorkflowCommand('workflow.save');
            executeWorkflowCommand('workflow.run');
        });
        expect(screen.getTextContent()).toContain(`workflows.page.issuesToFix:${JSON.stringify({ count: errors.length })}`);
        expect(onSave).not.toHaveBeenCalled();
        expect(onRunNow).not.toHaveBeenCalled();
        if (text.length === 0) expect(validation.normalizedDefinition).toBeUndefined();
    });

    /**
     * Deleting the block is the one thing that ends its composer's custody, so a
     * restored block starts a fresh document rather than resurrecting bytes the
     * author threw away.
     */
    it('releases a step composer when the step is truly deleted', async () => {
        const harness = await loadHarness();
        let draft = harness.setWorkflowDefaultField(
            harness.createWorkflowEditorDraft({
                draftId: 'draft-1',
                name: 'Review',
                blocks: [
                    {
                        kind: 'step', id: 'analyze',
                        document: { text: 'Analyze the repository', references: [], attachments: [] },
                        input: [], result: { kind: 'text' },
                    },
                    {
                        kind: 'step', id: 'implement',
                        document: { text: 'Implement the plan', references: [], attachments: [] },
                        input: [], result: { kind: 'text' },
                    },
                ],
            }),
            'agentTarget',
            AGENT_TARGET,
        );
        function ControlledBody() {
            const [current, setCurrent] = React.useState(draft);
            const history = useWorkflowEditorHistory<WorkflowEditorDraft>('composer-custody', (snapshot) => {
                draft = snapshot;
                setCurrent(snapshot);
            });
            return React.createElement(harness.WorkflowEditorBody, {
                draft: current,
                history: history.controls,
                onCommitChange: history.commit,
                onChange: (next: WorkflowEditorDraft, label?: string, committed?: boolean) => {
                    history.record(current, next, label ?? 'Edit workflow', committed);
                    draft = next;
                    setCurrent(next);
                },
                machineName: 'Mac Studio',
                composerScope: MACHINE_COMPOSER_SCOPE,
                selectedBlockId: null,
                onSelectBlock: () => {},
                onCustomizeBlock: () => {},
                view: 'steps',
                onChangeView: () => {},
            });
        }
        const screen = await renderScreen(React.createElement(ControlledBody));
        await activatePromptPreview(screen, 'workflow-editor-step-analyze-prompt');
        const originalRef = stepComposerRef(screen, 'analyze');
        expect(originalRef?.instanceId).toBeDefined();

        await screen.pressByTestIdAsync('workflow-editor-step-analyze-actions');
        await vi.waitFor(() => expect(screen.findHostByTestId('workflow-editor-step-analyze-actions-remove')).not.toBeNull());
        await screen.pressByTestIdAsync('workflow-editor-step-analyze-actions-remove');
        await vi.waitFor(() => expect(draft.blocks.map(block => block.id)).toEqual(['implement']));
        expect(draft.blocks.map((block) => block.id)).toEqual(['implement']);

        await screen.pressByTestIdAsync('workflow-editor-undo');
        await act(async () => {});
        expect(draft.blocks.map((block) => block.id)).toEqual(['analyze', 'implement']);
        // Removal moved editing to the surviving step; the restored one is edited again by activating it.
        await activatePromptPreview(screen, 'workflow-editor-step-analyze-prompt');
        const restoredRef = stepComposerRef(screen, 'analyze');
        expect(restoredRef.instanceId).not.toBe(originalRef.instanceId);
    });

    it('says no final output is selected until one is authored', async ({ onTestFinished }) => {
        vi.useFakeTimers();
        onTestFinished(() => { vi.useRealTimers(); });
        const harness = await loadHarness();
        // Selection is the contract, not copy or the presence of a menu option.
        const none = await renderBody(harness);
        expect(none.root.findAllByType(DropdownMenu).find(node => node.props.testID === 'workflow-editor-final-output-select')?.props.selectedId)
            .toBe('none');
        expect(none.findByTestId('workflow-editor-final-output-path')).toBeNull();
        await none.unmount();

        const bound = await renderBody(harness, {
            draft: harness.setWorkflowFinalOutput(buildDraft(harness), {
                kind: 'result',
                producer: { blockId: 'analyze', scope: { kind: 'current' } },
                path: [],
            }),
        });
        expect(bound.root.findAllByType(DropdownMenu).find(node => node.props.testID === 'workflow-editor-final-output-select')?.props.selectedId)
            .toBe('result:analyze');
        // The producer uses the document vocabulary, never a clipped prompt or internal id.
        expect(bound.getTextContent()).toContain('workflows.editor.addStep');
        await bound.pressByTestIdAsync('workflow-editor-final-output-trigger');
        await act(async () => { await vi.runOnlyPendingTimersAsync(); });
        expect(bound.findByTestId('workflow-editor-final-output-path')).not.toBeNull();
    });

    it('authors and clears the deterministic final output through the shared draft owner', async ({ onTestFinished }) => {
        vi.useFakeTimers();
        onTestFinished(() => { vi.useRealTimers(); });
        const harness = await loadHarness();
        const changed = vi.fn();
        let current = buildDraft(harness);
        function ControlledBody() {
            const [draft, setDraft] = React.useState(current);
            return <harness.WorkflowEditorBody draft={draft} onChange={(next) => {
                current = next; changed(next); setDraft(next);
            }} machineName="Mac Studio" composerScope={MACHINE_COMPOSER_SCOPE}
                inspectorGroupDisclosure={OPEN_SETTINGS_GROUPS} selectedBlockId={null}
                onSelectBlock={() => {}} onCustomizeBlock={() => {}} view="steps" onChangeView={() => {}} />;
        }
        const screen = await renderScreen(<ControlledBody />);

        await screen.pressByTestIdAsync('workflow-editor-final-output-trigger');
        await act(async () => { await vi.runOnlyPendingTimersAsync(); });
        await screen.pressByTestIdAsync('workflow-editor-final-output-option-analyze');
        await act(async () => { await vi.runOnlyPendingTimersAsync(); });
        expect(changed.mock.calls[0]?.[0].finalOutput).toEqual({
            kind: 'result',
            producer: { blockId: 'analyze', scope: { kind: 'current' } },
            path: [],
        });
        await screen.pressByTestIdAsync('workflow-editor-final-output-trigger');
        await act(async () => { await vi.runOnlyPendingTimersAsync(); });
        await screen.pressByTestIdAsync('workflow-editor-final-output-clear');
        await act(async () => { await vi.runOnlyPendingTimersAsync(); });
        expect(current.finalOutput).toBeUndefined();
        expect(changed).toHaveBeenCalledTimes(2);
    });

    it('refuses Export through its gate on a draft the canonical codec cannot serialize', async () => {
        const harness = await loadHarness();
        const exportJson = vi.fn();
        const commandsRef = React.createRef<import('./WorkflowEditorBody').WorkflowEditorCommands | null>();
        await renderBody(harness, {
            draft: buildDraft(harness, { text: '' }),
            onExportJson: exportJson,
            commandsRef,
        });
        await act(async () => { commandsRef.current!.exportJson(); });
        expect(exportJson).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(readAnnouncements()).toHaveLength(1));
    });

    it('keeps every command live once the draft and its target are valid', async () => {
        const harness = await loadHarness();
        const runNow = vi.fn();
        const exportJson = vi.fn();
        const commandsRef = React.createRef<import('./WorkflowEditorBody').WorkflowEditorCommands | null>();
        const screen = await renderBody(harness, {
            onRunNow: runNow,
            onExportJson: exportJson,
            projectTarget: { machineId: 'machine-1', directory: '/Users/me/project' },
            commandsRef,
        });

        await screen.pressByTestIdAsync('workflow-editor-run-now');
        await act(async () => { commandsRef.current!.exportJson(); });
        expect(runNow).toHaveBeenCalledTimes(1);
        expect(exportJson).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('workflow-editor-validity')).toBeNull();
    });

    it('commits a name edit as one undoable draft transaction, with cancellation leaving no history', async () => {
        const harness = await loadHarness();
        let draft = buildDraft(harness);
        function ControlledBody() {
            const [current, setCurrent] = React.useState(draft);
            const history = useWorkflowEditorHistory<WorkflowEditorDraft>('step-name-history', (snapshot) => {
                draft = snapshot;
                setCurrent(snapshot);
            });
            return React.createElement(harness.WorkflowEditorBody, {
                draft: current, history: history.controls, onCommitChange: history.commit,
                onChange: (next: WorkflowEditorDraft, label?: string, committed?: boolean) => {
                    history.record(current, next, label ?? 'Edit workflow', committed);
                    draft = next;
                    setCurrent(next);
                },
                machineName: 'Mac Studio', composerScope: MACHINE_COMPOSER_SCOPE,
                selectedBlockId: null, onSelectBlock: () => {}, onCustomizeBlock: () => {},
                view: 'steps', onChangeView: () => {},
            });
        }
        const screen = await renderScreen(React.createElement(ControlledBody));
        const field = () => screen.findByTestId('workflow-editor-step-analyze-label')!;
        expect(field().props.value).toBe('');
        await act(async () => { field().props.onFocus(); field().props.onChangeText('Inspect '); });
        // The trailing space stays in the field while canonical draft values are normalized.
        expect(field().props.value).toBe('Inspect ');
        await act(async () => field().props.onChangeText('Inspect the change'));
        await act(async () => field().props.onBlur());
        expect(draft.blocks[0]?.name).toBe('Inspect the change');
        await screen.pressByTestIdAsync('workflow-editor-undo');
        expect(draft.blocks[0]?.name).toBeUndefined();
        await screen.pressByTestIdAsync('workflow-editor-redo');
        expect(draft.blocks[0]?.name).toBe('Inspect the change');
        await act(async () => { field().props.onFocus(); field().props.onChangeText('Cancelled edit'); });
        await act(async () => { field().props.onKeyPress({ nativeEvent: { key: 'Escape' }, preventDefault: () => {} }); field().props.onBlur(); });
        expect(draft.blocks[0]?.name).toBe('Inspect the change');
        await screen.pressByTestIdAsync('workflow-editor-undo');
        expect(draft.blocks[0]?.name).toBeUndefined();
    });

    it('offers labelled Undo/Redo from the host history and clears Redo after a new edit', async ({ onTestFinished }) => {
        vi.useFakeTimers();
        onTestFinished(() => { vi.useRealTimers(); });
        const harness = await loadHarness();
        let draft = harness.setWorkflowDefaultField(
            harness.createWorkflowEditorDraft({
                draftId: 'draft-1',
                name: 'Review',
                blocks: [
                    {
                        kind: 'step', id: 'analyze',
                        document: { text: 'Analyze the repository', references: [], attachments: [] },
                        input: [], result: { kind: 'text' },
                    },
                    {
                        kind: 'step', id: 'implement',
                        document: { text: 'Implement the plan', references: [], attachments: [] },
                        input: [], result: { kind: 'text' },
                    },
                ],
            }),
            'agentTarget',
            AGENT_TARGET,
        );
        let redoLabel: string | null = null;
        function ControlledBody() {
            const [current, setCurrent] = React.useState(draft);
            const history = useWorkflowEditorHistory<WorkflowEditorDraft>('removal-history', (snapshot) => {
                draft = snapshot;
                setCurrent(snapshot);
            });
            redoLabel = history.controls.redoLabel;
            return React.createElement(harness.WorkflowEditorBody, {
                draft: current,
                history: history.controls,
                onCommitChange: history.commit,
                onChange: (next: WorkflowEditorDraft, label?: string, committed?: boolean) => {
                    history.record(current, next, label ?? 'Edit workflow', committed);
                    draft = next;
                    setCurrent(next);
                },
                machineName: 'Mac Studio', composerScope: MACHINE_COMPOSER_SCOPE,
                inspectorGroupDisclosure: OPEN_SETTINGS_GROUPS,
                selectedBlockId: null, onSelectBlock: () => {}, onCustomizeBlock: () => {},
                view: 'steps', onChangeView: () => {},
            });
        }
        const screen = await renderScreen(React.createElement(ControlledBody));

        await screen.pressByTestIdAsync('workflow-editor-step-analyze-actions');
        await act(async () => { await vi.runOnlyPendingTimersAsync(); });
        await screen.pressByTestIdAsync('workflow-editor-step-analyze-actions-remove');
        await act(async () => { await vi.runOnlyPendingTimersAsync(); });
        expect(draft.blocks.map((block) => block.id)).toEqual(['implement']);

        expect(screen.getTextContent()).toContain('workflows.editor.removedBlock');
        await screen.pressByTestIdAsync('workflow-editor-undo');
        // Restored at its original position, not appended to the end.
        expect(draft.blocks.map((block) => block.id)).toEqual(['analyze', 'implement']);
        expect(redoLabel).toContain('workflows.editor.removedBlock');
        await screen.pressByTestIdAsync('workflow-editor-redo');
        expect(draft.blocks.map((block) => block.id)).toEqual(['implement']);
        await screen.pressByTestIdAsync('workflow-editor-undo');
        await screen.pressByTestIdAsync('workflow-editor-final-output-trigger');
        await act(async () => { await vi.runOnlyPendingTimersAsync(); });
        await screen.pressByTestIdAsync('workflow-editor-final-output-option-implement');
        await act(async () => { await vi.runOnlyPendingTimersAsync(); });
        expect(redoLabel).toBeNull();
        expect(draft.finalOutput).toMatchObject({ producer: { blockId: 'implement' } });
    });

    it('announces the first blocking validation issue exactly once', async () => {
        const harness = await loadHarness();
        const screen = await renderBody(harness);
        announcementWrites.mockClear();
        await screen.update(React.createElement(harness.WorkflowEditorBody, {
            draft: buildDraft(harness, { text: '' }),
            onChange: () => {},
            machineName: 'Mac Studio',
            composerScope: MACHINE_COMPOSER_SCOPE,
            selectedBlockId: null,
            onSelectBlock: () => {},
            onCustomizeBlock: () => {},
            view: 'steps',
            onChangeView: () => {},
        } as never));
        await vi.waitFor(() => expect(readAnnouncements()).toHaveLength(1));
    });
});

/**
 * A workflow mounts the live composer only for the prompt being edited (UI-EDITORROWS); every other
 * prompt is its static picture. Custody keeps each document's exact references and caret, so moving
 * the one live composer between rows, re-placing a row and undoing never re-derives a document.
 */
describe('workflow editor prompt pictures', () => {
    const promptText = 'Compare @issue with @issue';
    const secondTokenStart = 'Compare @issue with '.length;

    it('keeps eight portable external-plugin attachment documents addressable without live composers at rest', async () => {
        const harness = await loadHarness();
        const draft = harness.createWorkflowEditorDraft({ draftId: 'attachment-pictures', name: 'Review',
            blocks: Array.from({ length: 8 }, (_, index) => ({
                kind: 'step' as const, id: `attached-${index}`,
                document: { text: 'Review this issue', references: [], attachments: [{
                    v: 1 as const, instanceId: `issue-${index}`, attachment: { pluginId: 'partner.issues', localId: 'issue' },
                    key: `issue-${index}`, value: { issueId: index }, presentation: { label: `Issue ${index}`, typeLabel: 'Issue' },
                }] }, input: [], result: { kind: 'text' as const },
            })),
        });
        const screen = await renderBody(harness, { draft });
        expect(liveComposerCount(screen)).toBe(0);
        for (let index = 0; index < 8; index += 1) {
            const picture = await pictureOf(screen, `attached-${index}`);
            expect(picture?.props.attachmentRowItems).toMatchObject([{ label: `Issue ${index}` }]);
            // The tray is drawn by the shared attachment row, in the row's own place above the field.
            const prompt = screen.findHostByTestId(`workflow-editor-step-attached-${index}-prompt`)!;
            const tray = prompt.findAll(node => node.props.testID === 'agent-input-document-preview-attachments').at(0);
            expect(tray).toBeDefined();
            expect(tray!.findAll(node => typeof node.type === 'string' && node.children.includes(`Issue ${index}`))).not.toHaveLength(0);
        }
        expect(liveComposerCount(screen)).toBe(0);
        // The picture's tray is the live tray's size: neither the live row's tray section nor the
        // picture's frame bounds its height here (no host panel budget), so activation cannot resize it.
        const trayBounds = (node: ReactTestInstance | null) => {
            for (let current = node; current !== null; current = current.parent) {
                const style = [current.props.style].flat(4).filter(Boolean).reduce((all, entry) => ({ ...all, ...entry }), {});
                if (typeof style.maxHeight === 'number') return style.maxHeight;
            }
            return null;
        };
        const pictureTray = screen.findHostByTestId('workflow-editor-step-attached-0-prompt')!
            .findAll(node => node.props.testID === 'agent-input-document-preview-attachments').at(0)!;
        expect(trayBounds(pictureTray)).toBeNull();
        await activatePromptPreview(screen, 'workflow-editor-step-attached-0-prompt');
        expect(liveComposerCount(screen)).toBe(1);
        expect(trayBounds(screen.findHostByTestId('agent-input-attachment-drop-target'))).toBeNull();
        await screen.unmount();
    });

    async function renderTwoStepEditor() {
        const harness = await loadHarness();
        let draft = harness.setWorkflowDefaultField(harness.createWorkflowEditorDraft({
            draftId: 'pictures',
            name: 'Review',
            blocks: [
                { kind: 'loop', id: 'triage', repetition: { kind: 'count', count: { kind: 'literal', value: 2 } }, body: [] },
                { kind: 'step', id: 'analyze', document: { text: promptText, references: [], attachments: [] }, input: [], result: { kind: 'text' } },
                { kind: 'step', id: 'implement', document: { text: 'Implement the plan', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
            ] as never,
        }), 'agentTarget', AGENT_TARGET);
        let opened: string | null = null;
        function ControlledBody() {
            const [current, setCurrent] = React.useState(draft);
            const history = useWorkflowEditorHistory<WorkflowEditorDraft>('prompt-pictures', (snapshot) => {
                draft = snapshot;
                setCurrent(snapshot);
            });
            return React.createElement(harness.WorkflowEditorBody, {
                draft: current,
                history: history.controls,
                onCommitChange: history.commit,
                onChange: (next: WorkflowEditorDraft, label?: string, committed?: boolean) => {
                    history.record(current, next, label ?? 'Edit workflow', committed);
                    draft = next;
                    setCurrent(next);
                },
                machineName: 'Mac Studio',
                composerScope: MACHINE_COMPOSER_SCOPE,
                selectedBlockId: null,
                onSelectBlock: () => {},
                onCustomizeBlock: (blockId: string) => { opened = blockId; },
                view: 'steps',
                onChangeView: () => {},
            });
        }
        const screen = await renderScreen(React.createElement(ControlledBody));
        return { screen, readDraft: () => draft, readOpened: () => opened };
    }

    async function pictureOf(screen: Awaited<ReturnType<typeof renderScreen>>, blockId: string) {
        const prompt = screen.findHostByTestId(`workflow-editor-step-${blockId}-prompt`);
        return prompt?.findAll(node => typeof node.props.onActivate === 'function' && Array.isArray(node.props.references)).at(0) ?? null;
    }

    it('keeps external plugin and client Action read/apply/focus on the exact inactive document until deletion or Account retirement', async () => {
        const homes = await serveActionHomes({ homes: [{ key: 'editor', serverUrl: 'https://inactive-editor.test', accountId: 'editor-account' }],
            route: request => createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined });
        bindingBoundaries.push(() => homes.dispose());
        const scope = { serverId: homes.homes.editor!.id, accountId: 'editor-account' };
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const { screen, readDraft } = await renderTwoStepEditor();
        const first = stepDocumentRef(screen, 'analyze');
        const second = stepDocumentRef(screen, 'implement');
        const handlers = createComposerPresentationHostHandlers({ scope, owner: {
            identity: { pluginId: 'partner.editor-tools', localId: 'composer-tools' },
            occurrenceId: 'installed-tools-1', surfaceInstanceKey: 'tools-surface',
        } });
        const request = (method: PluginUiHostApiRequestEnvelopeV1['method'], payload: PluginUiHostApiRequestEnvelopeV1['payload']): PluginUiHostApiRequestEnvelopeV1 => ({
            version: 1, requestId: `editor:${method}`, method, payload,
            surface: { pluginId: 'partner.editor-tools', contributionId: 'composer-tools', surfaceId: 'tools-surface',
                placement: 'composerSurface', platform: 'web', channel: 'internal', resourceScope: [], diagnostics: [] },
        });
        expect(liveComposerCount(screen)).toBe(0);
        expect(handlers.readComposer!(request('readComposer', { ref: first }))).toMatchObject({ status: 'ready', snapshot: { text: promptText } });
        await activatePromptPreview(screen, 'workflow-editor-step-implement-prompt');
        const original = readMountedComposerPresentationSnapshot({ scope, ref: first })!;
        await act(async () => {
            expect(await handlers.applyComposer!(request('applyComposer', { ref: first, transaction: {
                expectedRevision: original.revision, operations: [{ kind: 'text.insert', position: { offset: promptText.length }, text: ' via plugin' }],
            } }))).toMatchObject({ status: 'applied' });
        });
        const pluginEdited = readMountedComposerPresentationSnapshot({ scope, ref: first })!;
        await act(async () => {
            expect(await executor.execute('composer.transaction.apply', { scope, ref: first, transaction: {
                expectedRevision: pluginEdited.revision, operations: [{ kind: 'text.insert', position: { offset: pluginEdited.text.length }, text: ' via Action' }],
            } }, { surface: 'ui', authority: 'present_user', serverId: scope.serverId, expectedAccountId: scope.accountId })).toMatchObject({ ok: true, result: { status: 'applied' } });
        });
        const actionEdited = readMountedComposerPresentationSnapshot({ scope, ref: first })!;
        await act(async () => {
            expect(await executor.execute('composer.transaction.apply', { scope, ref: first, transaction: {
                expectedRevision: actionEdited.revision, operations: [{ kind: 'text.insert', position: { offset: actionEdited.text.length }, text: ' via agent' }],
            } }, { surface: 'agent', authority: 'account_automation', serverId: scope.serverId, runtimeAccountId: scope.accountId })).toMatchObject({ ok: true, result: { status: 'applied' } });
        });
        const block = readDraft().blocks.find(block => block.id === 'analyze');
        expect(block?.kind === 'step' && block.document.text).toBe(`${promptText} via plugin via Action via agent`);
        promptFocus.mockClear();
        await act(async () => { expect(handlers.focusComposer!(request('focusComposer', { ref: first }))).toEqual({ status: 'focused' }); });
        await flushHookEffects();
        expect(stepComposerRef(screen, 'analyze')).toBe(first);
        expect(promptFocus).toHaveBeenCalled();
        await screen.pressByTestIdAsync('workflow-editor-step-analyze-actions');
        await screen.pressByTestIdAsync('workflow-editor-step-analyze-actions-remove');
        expect(handlers.readComposer!(request('readComposer', { ref: first }))).toEqual({ status: 'unavailable', reason: 'scopeClosed' });
        expect(readMountedComposerPresentationSnapshot({ scope, ref: first })).toBeNull();
        expect(handlers.focusComposer!(request('focusComposer', { ref: first }))).toEqual({ status: 'unavailable', reason: 'scopeClosed' });
        expect(await handlers.applyComposer!(request('applyComposer', { ref: first, transaction: {
            expectedRevision: 0, operations: [{ kind: 'text.insert', position: { offset: 0 }, text: 'stale' }],
        } }))).toMatchObject({ status: 'composerUnavailable' });
        expect(handlers.readComposer!(request('readComposer', { ref: second }))).toMatchObject({ status: 'ready' });
        await act(async () => { await homes.switchAccount('editor', 'replacement-account'); });
        expect(handlers.readComposer!(request('readComposer', { ref: second }))).toEqual({ status: 'unavailable', reason: 'scopeClosed' });
        expect(readMountedComposerPresentationSnapshot({ scope, ref: second })).toBeNull();
        expect(handlers.focusComposer!(request('focusComposer', { ref: second }))).toEqual({ status: 'unavailable', reason: 'scopeClosed' });
        expect(await executor.execute('composer.transaction.apply', { scope, ref: second, transaction: {
            expectedRevision: 0, operations: [{ kind: 'text.insert', position: { offset: 0 }, text: 'stale' }],
        } }, { surface: 'agent', authority: 'account_automation', serverId: scope.serverId, runtimeAccountId: scope.accountId })).toMatchObject({ ok: true, result: { status: 'composerUnavailable' } });
        // Re-placement remounts the adapter, but cannot admit retained bytes to
        // the replacement Account under the retired document's exact ref.
        await screen.pressByTestIdAsync('workflow-editor-step-implement-actions');
        await screen.pressByTestIdAsync('workflow-editor-step-implement-actions-moveIn');
        const moved = readDraft().blocks[0];
        expect(moved?.kind === 'loop' && moved.body.map(block => block.id)).toEqual(['implement']);
        expect(handlers.readComposer!(request('readComposer', { ref: second }))).toEqual({ status: 'unavailable', reason: 'scopeClosed' });
        handlers.dispose();
        await screen.unmount();
    });

    it('moves the one live composer between prompts and keeps the exact reference, caret and Composer address of a picture through a move and undo', async () => {
        const { screen, readDraft } = await renderTwoStepEditor();
        expect(liveComposerCount(screen)).toBe(0);
        expect(await pictureOf(screen, 'analyze')).not.toBeNull();

        // Keyboard entry: focusing the picture opens the live composer and lands in it.
        const field = screen.findHostByTestId('workflow-editor-step-analyze-prompt')!.findAll(node =>
            node.props.testID === 'agent-input-document-preview-field' && typeof node.props.onFocus === 'function').at(0)!;
        promptFocus.mockClear();
        await act(async () => field.props.onFocus());
        await flushHookEffects();
        expect(liveComposerCount(screen)).toBe(1);
        expect(promptFocus).toHaveBeenCalled();
        const composerRef = stepComposerRef(screen, 'analyze');
        const initial = readComposerPresentationSnapshot(composerRef)!;
        await act(async () => {
            expect(applyComposerPresentationTransaction({ ref: composerRef, transaction: {
                expectedRevision: initial.revision,
                operations: [{ kind: 'reference.insert', reference: {
                    kind: 'partner.reference', ref: 'partner:issue-42', token: '@issue', label: 'Issue #42',
                    start: secondTokenStart, end: secondTokenStart + '@issue'.length,
                } }],
            } })).toEqual({ status: 'applied', revision: initial.revision + 1 });
        });
        const caret = { start: 8, end: 14 };
        await act(async () => {
            (composerProps(screen, 'analyze').inputPersistence as { onSelectionChangePersist: (selection: typeof caret, length: number) => void })
                .onSelectionChangePersist(caret, promptText.length);
        });

        // Editing the next prompt: the first becomes its picture, bound to the second token exactly.
        await activatePromptPreview(screen, 'workflow-editor-step-implement-prompt');
        expect(liveComposerCount(screen)).toBe(1);
        expect(() => stepComposer(screen, 'analyze')).toThrow();
        // Presentation demand does not retire the exact document's command address.
        expect(readComposerPresentationSnapshot(composerRef)).toMatchObject({ text: promptText, ref: composerRef, selection: caret });
        const exactReference = [{ start: secondTokenStart, end: secondTokenStart + '@issue'.length, ref: 'partner:issue-42', label: 'Issue #42' }];
        expect((await pictureOf(screen, 'analyze'))?.props.references).toEqual(exactReference);

        // Re-placed while it is a picture, then the move is undone.
        await screen.pressByTestIdAsync('workflow-editor-step-analyze-actions');
        await vi.waitFor(() => expect(screen.findHostByTestId('workflow-editor-step-analyze-actions-moveIn')).not.toBeNull());
        await screen.pressByTestIdAsync('workflow-editor-step-analyze-actions-moveIn');
        await vi.waitFor(() => {
            const loop = readDraft().blocks[0];
            expect(loop?.kind === 'loop' ? loop.body.map(block => block.id) : []).toEqual(['analyze']);
        });
        expect((await pictureOf(screen, 'analyze'))?.props.references).toEqual(exactReference);
        await screen.pressByTestIdAsync('workflow-editor-undo');
        await act(async () => {});
        expect(readDraft().blocks.map(block => block.id)).toEqual(['triage', 'analyze', 'implement']);
        expect((await pictureOf(screen, 'analyze'))?.props.references).toEqual(exactReference);
        expect(liveComposerCount(screen)).toBe(1);

        // Back to the first prompt: the same Composer address, exact document and caret.
        await activatePromptPreview(screen, 'workflow-editor-step-analyze-prompt');
        expect(liveComposerCount(screen)).toBe(1);
        expect(stepComposerRef(screen, 'analyze')).toBe(composerRef);
        expect(readComposerPresentationSnapshot(composerRef)).toMatchObject({
            text: promptText,
            references: [{ ref: 'partner:issue-42', start: secondTokenStart, end: secondTokenStart + '@issue'.length }],
        });
        expect(composerProps(screen, 'analyze').inputPersistence).toMatchObject({ initialSelection: caret });
        const implement = readDraft().blocks.find(block => block.id === 'implement');
        expect(implement?.kind === 'step' && implement.document.text).toBe('Implement the plan');
        await screen.unmount();
    });

    it('opens the live composer with the caret where the author pointed in the picture', async () => {
        const { screen } = await renderTwoStepEditor();
        const picture = await pictureOf(screen, 'implement');
        promptSelection.mockClear();
        promptFocus.mockClear();
        await act(async () => picture!.props.onActivate({ start: 4, end: 4 }));
        await flushHookEffects();
        expect(liveComposerCount(screen)).toBe(1);
        expect(promptFocus).toHaveBeenCalled();
        // Focusing must not move the caret off the restored point.
        expect(promptSelection.mock.calls.at(-1)?.[0]).toEqual({ start: 4, end: 4 });
        await screen.unmount();
    });

    it('opens Step options from a picture without mounting a composer, and follows the saved composer placement', async () => {
        const { getWorkflowStepOptionsChipPlacement } = await import('@/components/workflows/workflowComposerControlPlacements');
        const placementId = getWorkflowStepOptionsChipPlacement().id;
        const pinned = await renderTwoStepEditor();
        expect(pinned.screen.findHostByTestId('workflow-editor-step-analyze-customize')).not.toBeNull();
        await pinned.screen.pressByTestIdAsync('workflow-editor-step-analyze-customize');
        expect(pinned.readOpened()).toBe('analyze');
        expect(pinned.screen.findHostByTestId('workflow-editor-inspector-options')).not.toBeNull();
        expect(liveComposerCount(pinned.screen)).toBe(0);
        // Pictured controls retain their advertised keyboard/accessibility entry.
        const library = pinned.screen.findHostByTestId('workflow-editor-step-analyze-prompt')!
            .findAll(node => node.props.testID === 'agent-input-document-preview-prompt-library').at(0)!;
        expect(library.props).toMatchObject({ accessibilityRole: 'button', accessible: true, focusable: true });
        await pinned.screen.unmount();

        getStorage().getState().applyLocalSettings({ navigationSurfacePlacementsV1: { composer: {
            orderedIds: [], placements: { [placementId]: 'overflow' },
        } } });
        const overflow = await renderTwoStepEditor();
        // The author moved Step options to the overflow: neither the picture nor the live row draws it.
        expect(overflow.screen.findHostByTestId('workflow-editor-step-analyze-customize')).toBeNull();
        await activatePromptPreview(overflow.screen, 'workflow-editor-step-analyze-prompt');
        expect(liveComposerCount(overflow.screen)).toBe(1);
        expect(overflow.screen.findHostByTestId('workflow-editor-step-analyze-customize')).toBeNull();
        await overflow.screen.unmount();
    });
});
