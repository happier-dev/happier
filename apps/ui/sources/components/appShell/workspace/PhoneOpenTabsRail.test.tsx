// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { Platform } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { useEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropHooks';
import { EntityDragItemV1Schema, EntityDropAdmissionV1Schema } from '@happier-dev/protocol/plugins/ui';
import { WorkflowConversationBindInputV1Schema } from '@happier-dev/protocol/actions/workflowAuthoringAction';
import { createWorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { useWorkflowSessionBinding } from '@/components/workflows/editor/useWorkflowSessionBinding';
import { WorkflowStepSessionDropZone } from '@/components/workflows/editor/WorkflowStepSessionDropZone';
import { resolveCompactAppDestinations } from '../destinations/compactAppDestinationCatalog';
import { createWorkspaceState, reduceWorkspaceState } from './workspaceState';
import { WorkspaceNavigationProvider, type WorkspaceNavigationContextValue } from './WorkspaceNavigationContext';
import { PhoneOpenTabsRail } from './PhoneOpenTabsRail';
import type { TestGestureChain } from '@/dev/testkit/mocks/gestureHandler';
import { ENTITY_DRAG_ACTIVATION_DISTANCE_PX } from '@/components/ui/treeDragDrop/entityDragGestureAdapter';
import { DocumentTabStrip, type DocumentTabItem } from '@/components/ui/navigation/DocumentTabStrip';

const platformBoundary = vi.hoisted(() => ({ os: 'web' }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    View: 'View', ScrollView: 'ScrollView', Pressable: 'Pressable',
    Platform: { get OS() { return platformBoundary.os; }, select: (choices: Record<string, unknown>) => choices[platformBoundary.os] ?? choices.default },
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('react-native-gesture-handler', async () => (await import('@/dev/testkit/mocks/gestureHandler')).createGestureHandlerMock());
// Session list surfaces demand content from the sync singleton; the fixture settles that demand without a Home.
vi.mock('@/sync/sync', async () => ({ sync: (await import('@/dev/testkit/mocks/sync')).createSessionListHydrationSyncBoundary() }));
// Recipient-envelope HTTP is outside this deterministic mounted carry/admission corridor.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unavailable = () => { throw new Error('Unexpected recipient-envelope API'); };
    return { createSessionDataKeyEnvelopeClient: unavailable, readSessionDataKeyEnvelopeCollectionPage: unavailable,
        prepareSessionDataKeyEnvelopesForScope: unavailable, prepareSessionDataKeyEnvelopesDetached: unavailable };
});

const scope = { serverId: 'home', accountId: 'account' };
const runtime = useEntityDragDropRuntime();
const previousScope = storage.getState().profileScope;
const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: true, workflows: true, friends: false } });
const draft = createWorkflowEditorDraft({ draftId: 'draft', name: 'Review', blocks: [{ kind: 'step', id: 'review',
    document: { text: 'Review the change', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] });
function Target() {
    const sessionDrop = useWorkflowSessionBinding({ context: { scope, draft, editable: true, whereMachineId: 'machine',
        candidates: [{ sessionId: 'session', machineId: 'machine', label: 'Atlas review' }] },
    onChange: () => { throw new Error('Cancelled carry must not write'); }, whereName: 'Development', machineName: id => id });
    return <WorkflowStepSessionDropZone stepId="review" label="Review" sessionDrop={sessionDrop} testID="workflow-target"><React.Fragment /></WorkflowStepSessionDropZone>;
}
function harness(pair = false) {
    let state = createWorkspaceState({ id: 'session-tab', target: { kind: 'session', params: { id: 'session', ...scope } }, pinned: false, preview: false });
    state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: { id: 'inbox-tab', target: { kind: 'inbox', params: {} }, pinned: false, preview: false } });
    if (pair) {
        state = reduceWorkspaceState(state, { type: 'reorderTab', groupId: 'group:1', tabId: 'inbox-tab', index: 0 });
        state = reduceWorkspaceState(state, { type: 'splitTab', tabId: 'session-tab', sourceGroupId: 'group:1', targetGroupId: 'group:1',
            newGroupId: 'group:2', axis: 'row', placement: 'after', availableSizePx: 1400, minimumFirstSizePx: 320, minimumSecondSizePx: 320 });
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: { id: 'settings-tab', target: { kind: 'settings', params: {} }, pinned: false, preview: false } });
        state = reduceWorkspaceState(state, { type: 'activateTab', groupId: 'group:2', tabId: 'session-tab' });
    }
    const activated: string[] = [];
    const closed: string[] = [];
    const workspace: WorkspaceNavigationContextValue = { active: false, get state() { return state; }, catalog,
        phone: { catalog, onTab: true, activateTab: id => activated.push(id), closeTab: id => closed.push(id), openHref: () => true },
        canGoBack: false, canGoForward: false, openHref: () => false, activateTab: () => {}, closeTab: () => {}, closeTabs: () => {},
        dispatch: action => { state = reduceWorkspaceState(state, action); }, navigationForTab: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
        registerBackStep: () => () => {}, back: () => {}, forward: () => {},
    };
    return { workspace, activated, closed };
}
afterEach(async () => { act(() => { runtime.cancel(); storage.setState({ profileScope: previousScope }); }); platformBoundary.os = 'web'; await standardCleanup(); });

describe('phone production tab carry', () => {
    it('names navigation tabs without claiming nonexistent panel ownership', async () => {
        storage.setState({ profileScope: scope });
        const h = harness();
        const screen = await renderScreen(<WorkspaceNavigationProvider value={h.workspace}><PhoneOpenTabsRail /></WorkspaceNavigationProvider>);
        const tabs = screen.root.findAll(node => typeof node.type === 'string' && node.props.accessibilityRole === 'tab');
        expect(tabs.length).toBeGreaterThan(0);
        for (const tab of tabs) {
            expect(tab.props.accessibilityLabel).toBeTruthy();
            expect(tab.props['aria-controls']).toBeUndefined();
        }
    });
    it('changes only one lightweight strip descriptor for one of 120 restored fallback titles and none for selection', async () => {
        storage.setState({ profileScope: scope });
        const h = harness();
        const ids = ['session-tab', 'inbox-tab', ...Array.from({ length: 118 }, (_, index) => `restored-${index + 2}`)];
        for (const [index, id] of ids.entries()) {
            const target = { kind: 'unavailable-restored-document', params: { id } };
            h.workspace.dispatch(index < 2 ? { type: 'setTarget', tabId: id, target }
                : { type: 'openTab', groupId: 'group:1', tab: { id, target, pinned: false, preview: false } });
            h.workspace.dispatch({ type: 'setFallbackTitle', tabId: id, title: `Restored document ${index}` });
        }
        const frame = () => <WorkspaceNavigationProvider value={{ ...h.workspace, state: h.workspace.state }}><PhoneOpenTabsRail /></WorkspaceNavigationProvider>;
        const screen = await renderScreen(frame());
        const readTabs = (): readonly DocumentTabItem[] => screen.root.findByType(DocumentTabStrip).props.tabs;
        const before = readTabs();
        expect(before).toHaveLength(120);
        expect(before.find(tab => tab.key === 'restored-60')?.title).toBe('Restored document 60');
        await act(async () => {
            h.workspace.dispatch({ type: 'setFallbackTitle', tabId: 'restored-60', title: 'Renamed document' });
            await screen.update(frame());
        });
        const renamed = readTabs();
        expect(renamed.find(tab => tab.key === 'restored-60')?.title).toBe('Renamed document');
        expect(renamed.filter((tab, index) => tab !== before[index]).map(tab => tab.key)).toEqual(['restored-60']);
        await act(async () => {
            h.workspace.dispatch({ type: 'activateTab', groupId: 'group:1', tabId: 'restored-61' });
            await screen.update(frame());
        });
        expect(readTabs()).toBe(renamed);
        expect(screen.root.findByType(DocumentTabStrip).props.activeTabKey).toBe('restored-61');
        await screen.unmount();
    });
    it('reveals the active wrapped tab from its rail position rather than its local source position', async () => {
        storage.setState({ profileScope: scope });
        const h = harness();
        const offsets: number[] = [];
        const screen = await renderScreen(<WorkspaceNavigationProvider value={h.workspace}><PhoneOpenTabsRail /></WorkspaceNavigationProvider>, {
            createNodeMock: element => String(element.type) === 'ScrollView' ? { scrollTo: (options: { x: number }) => offsets.push(options.x) } : null,
        });
        const scroll = screen.root.find(node => String(node.type) === 'ScrollView' && node.props.accessibilityRole === 'tablist');
        await act(async () => { scroll.props.onLayout({ nativeEvent: { layout: { width: 100 } } }); });
        const item = scroll.children.find(child => typeof child === 'object' && child.findAll(node => node.props.testID === 'phone-rail-tab-inbox-tab').length > 0);
        if (!item || typeof item !== 'object') throw new Error('Expected the active rail item');
        const outer = String(item.type) === 'View' ? item : item.find(node => String(node.type) === 'View');
        await act(async () => { outer.props.onLayout({ nativeEvent: { layout: { x: 300, width: 80 } } }); });
        expect(offsets.some(x => x > 0)).toBe(true);
        await screen.unmount();
    });
    it.each(['ios', 'android'] as const)('uses the shared native carry adapter on %s and preserves scroll/tap cancellation', async platform => {
        platformBoundary.os = platform;
        expect(Platform.OS).toBe(platform);
        storage.setState({ profileScope: scope });
        const h = harness();
        try {
            const screen = await renderScreen(<WorkspaceNavigationProvider value={h.workspace}><PhoneOpenTabsRail /><Target /></WorkspaceNavigationProvider>, {
                createNodeMock: element => element.type === 'View' ? { measureInWindow: (read: (x: number, y: number, width: number, height: number) => void) => read(0, element.props.testID === 'workflow-target' ? 100 : 0, 390, 40) } : null,
            });
            const detectors = screen.root.findAll(node => node.props?.gesture?.__handlers !== undefined);
            expect(detectors, 'The actual phone tab must have the native source adapter').not.toHaveLength(0);
            const gesture = detectors[0].props.gesture as TestGestureChain;
            expect(gesture.__config.enabled).toBe(true);
            expect(gesture.__config.activeOffsetY).toEqual([-ENTITY_DRAG_ACTIVATION_DISTANCE_PX, ENTITY_DRAG_ACTIVATION_DISTANCE_PX]);
            expect(gesture.__config.failOffsetX).toEqual([-ENTITY_DRAG_ACTIVATION_DISTANCE_PX, ENTITY_DRAG_ACTIVATION_DISTANCE_PX]);
            await act(async () => { gesture.__handlers.onFinalize(); screen.pressByTestId('phone-rail-tab-session-tab'); });
            expect(runtime.getSnapshot().phase).toBe('idle');
            expect(h.activated).toEqual(['session-tab']);
            await act(async () => { gesture.__handlers.onStart({ absoluteX: 30, absoluteY: 120 }); await runtime.refreshMeasurements(); runtime.move({ x: 30, y: 120 }); });
            expect(runtime.getSnapshot().admission).toMatchObject({ status: 'allowed', effect: { actionId: 'workflow.authoring.conversation.bind' } });
            await act(async () => { gesture.__handlers.onEnd({ absoluteX: 30, absoluteY: 120 }, false); gesture.__handlers.onFinalize(); });
            expect(runtime.getSnapshot().phase).toBe('idle');
            await act(async () => { gesture.__handlers.onStart({ absoluteX: 30, absoluteY: 120 }); gesture.__handlers.onFinalize(); });
            expect(runtime.getSnapshot().phase).toBe('idle');
            await screen.unmount();
        } finally { platformBoundary.os = 'web'; }
    });
    it('keeps ordinary tab activation and horizontal scroll outside the carry lifecycle', async () => {
        storage.setState({ profileScope: scope });
        const h = harness();
        const screen = await renderScreen(<WorkspaceNavigationProvider value={h.workspace}><PhoneOpenTabsRail /></WorkspaceNavigationProvider>);
        await act(async () => { screen.pressByTestId('phone-rail-tab-session-tab'); });
        expect(h.activated).toEqual(['session-tab']);
        for (const scroll of screen.root.findAll(node => String(node.type) === 'ScrollView' && typeof node.props.onScroll === 'function')) {
            await act(async () => { scroll.props.onScroll({ nativeEvent: { contentOffset: { x: 200, y: 0 } } }); });
        }
        expect(runtime.getSnapshot().phase).toBe('idle');
        await screen.unmount();
    });
    it('leads a Bot\'s session tab with its face, not an Agent glyph (Living Bots lab)', async () => {
        const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const { SessionBotFace } = await import('@/components/sessions/bots/face/SessionBotFace');
        const { SessionAgentCatalogIdentityIcon } = await import('@/components/sessions/presentation/SessionAgentCatalogIdentityIcon');
        vi.stubGlobal('ImageData', class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} });
        storage.setState({ profileScope: scope });
        storage.getState().applySessions([createSessionFixture({ id: 'session', serverId: scope.serverId,
            metadata: { path: '/repo', host: 'host', machineId: 'machine', flavor: 'codex', bot: { kind: 'bot' } } })]);
        const screen = await renderScreen(<WorkspaceNavigationProvider value={harness().workspace}><PhoneOpenTabsRail /></WorkspaceNavigationProvider>,
            { createNodeMock: node => node.type === 'canvas' ? { getContext: () => ({ putImageData() {} }) } : null });
        expect(screen.findByType(SessionBotFace).props.facts).toMatchObject({ seed: 'session' });
        expect(screen.findAllByType(SessionAgentCatalogIdentityIcon)).toHaveLength(0);
        vi.unstubAllGlobals();
    });
    it('carries a qualified Session from the actual narrow strip into the mounted Workflow target and cancels without writing', async () => {
        storage.setState({ profileScope: scope });
        const h = harness(true);
        const hosts: HTMLElement[] = [];
        const screen = await renderScreen(<WorkspaceNavigationProvider value={h.workspace}><PhoneOpenTabsRail /><Target /></WorkspaceNavigationProvider>, {
            createNodeMock: element => {
                if (element.type !== 'View') return null;
                const node = document.createElement('div');
                node.getBoundingClientRect = () => new DOMRect(0, element.props.testID === 'workflow-target' ? 100 : 0, 390, 40);
                hosts.push(node);
                return node;
            },
        });
        const source = hosts.find(node => node.getAttribute('draggable') === 'true');
        expect(source, 'The real phone rail must bind a drag source').toBeDefined();
        const primary = document.createElement('button');
        primary.setAttribute('role', 'tab');
        const close = document.createElement('button');
        source!.append(primary, close);
        const closeDrag = new MouseEvent('dragstart', { bubbles: true, cancelable: true });
        await act(async () => { close.dispatchEvent(closeDrag); });
        expect(closeDrag.defaultPrevented).toBe(true);
        expect(runtime.getSnapshot().phase).toBe('idle');
        await act(async () => { source!.dispatchEvent(new MouseEvent('dragstart', { bubbles: true, cancelable: true, clientX: 30, clientY: 20 })); });
        expect(runtime.getSnapshot().item).toEqual({ kind: 'session', scope, address: { serverId: scope.serverId, sessionId: 'session' } });
        expect(EntityDragItemV1Schema.safeParse(runtime.getSnapshot().item).success).toBe(true);
        await act(async () => { runtime.move({ x: 30, y: 120 }); });
        expect(runtime.getSnapshot().admission).toMatchObject({ status: 'allowed', effect: { actionId: 'workflow.authoring.conversation.bind' } });
        expect(EntityDropAdmissionV1Schema.safeParse(runtime.getSnapshot().admission).success).toBe(true);
        const admission = runtime.getSnapshot().admission;
        expect(WorkflowConversationBindInputV1Schema.safeParse(admission?.status === 'allowed' ? admission.effect.input : null).success).toBe(true);
        await act(async () => { source!.dispatchEvent(new Event('dragend')); });
        expect(runtime.getSnapshot().phase).toBe('idle');
        expect(h.activated).toEqual([]);
        expect(h.closed).toEqual([]);
        await screen.unmount();
    });
});
