import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { SplitCanvasHost, type SplitCanvasRetainedLeafContent, type SplitCanvasRetainedLeafContentContext } from '@/components/appShell/splitCanvas/components/SplitCanvasHost';
import { collectSplitCanvasLeaves } from '@/components/appShell/splitCanvas/model/splitCanvasTree';
import { createEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropRuntime';
import { sessionCanvasTabId } from '@/sync/domains/session/sessionSplitCanvasPersistence';
import { findSessionLeafById, resolveSessionSplitCanvasState, runSessionSplitCanvasCommand, type SessionSplitCanvasState } from './sessionSplitCanvasState';
import { createSessionCanvasRetainedContents, SessionCanvasLeaf, SessionCanvasTabGroup } from './SessionCanvasLeaf';

vi.mock('@/text', () => createTextModuleMock());
vi.mock('react-native-unistyles', () => createUnistylesMock());
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ PanResponder: { create: () => ({ panHandlers: {} }) } });
});

const scope = { serverId: 'server-a', accountId: 'account-a' };
const runtime = createEntityDragDropRuntime();
type GroupProps = React.ComponentProps<typeof SessionCanvasTabGroup>;
function memberProps(member: SplitCanvasRetainedLeafContent, context: SplitCanvasRetainedLeafContentContext) {
    const child = member.render(context);
    if (!React.isValidElement<React.ComponentProps<typeof SessionCanvasLeaf>>(child)
        || child.type !== SessionCanvasLeaf) throw new Error('Expected a retained Session canvas member');
    return child.props;
}
function createGroupProps(): GroupProps {
    let state = resolveSessionSplitCanvasState({ sessionId: 'sess_a', scope });
    state = runSessionSplitCanvasCommand(state, { type: 'openSession', sessionId: 'sess_b', leafId: state.focusedLeafId! });
    const leaf = findSessionLeafById(state, state.focusedLeafId)!;
    return { leaf, focused: true, visible: true, routeProps: { sessionId: 'sess_a', routeServerId: scope.serverId,
        canvasKey: 'workspace-a', entityScope: scope, jumpToSeq: 42,
        routeHydrationState: { kind: 'available', sessionId: 'sess_a', serverId: scope.serverId } },
        runtime, isCurrent: () => true, requestTabAction: async () => ({ status: 'applied' }),
        executeDrop: async () => ({ status: 'applied' }),
        resolveDrop: () => ({ status: 'refused', reason: { code: 'not-tested', message: 'Unavailable' } }),
    };
}
function initialState(props: GroupProps) {
    return resolveSessionSplitCanvasState({ sessionId: 'sess_a', scope,
        persistedSnapshot: { version: 1, scope, root: props.leaf, focusedLeafId: props.leaf.id, maximizedLeafId: null } });
}
function members(state: SessionSplitCanvasState, props: GroupProps) {
    return createSessionCanvasRetainedContents({ leaves: collectSplitCanvasLeaves(state.root),
        routeProps: props.routeProps, requestTabAction: props.requestTabAction });
}
function canvas(state: SessionSplitCanvasState, props: GroupProps) {
    return <SplitCanvasHost state={state} dispatch={() => {}}
        renderLeafHeader={({ leaf, isFocused }) => <SessionCanvasTabGroup {...props} leaf={leaf} focused={isFocused}
            visible={!state.maximizedLeafId || state.maximizedLeafId === leaf.id} />}
        retainedLeafContents={members(state, props).map(member => ({ ...member,
            // Exercise the production descriptor and actual Host custody with a stateful
            // child. This is not a SessionView mock or evidence of loaded SessionView QA.
            render: context => <DraftProbe sessionId={memberProps(member, context).sessionId} />,
        }))} />;
}
async function measure(screen: Awaited<ReturnType<typeof renderScreen>>, state: SessionSplitCanvasState) {
    await act(async () => {
        invokeTestInstanceHandler(screen.findByTestId('split-canvas-host'), 'onLayout', {
            nativeEvent: { layout: { x: 0, y: 0, width: 1600, height: 900 } },
        });
    });
    await act(async () => {
        for (const leaf of collectSplitCanvasLeaves(state.root)) {
            invokeTestInstanceHandler(screen.findByTestId(`split-canvas-content-slot-${leaf.id}`), 'onLayout', {
                nativeEvent: { layout: { x: 0, y: 32, width: 760, height: 820 } },
            });
        }
    });
}

describe('Session canvas retained-tab composition', () => {
    afterEach(() => standardCleanup());

    it('gives route hydration and jump state only to the exact qualified route member', () => {
        const props = createGroupProps();
        const contents = members(initialState(props), props);
        expect(contents).toHaveLength(2);
        const rendered = contents.map(member => memberProps(member, { leafId: member.leafId, isFocused: true, isVisible: member.isActive }));
        expect(rendered[0]).toMatchObject({ sessionId: 'sess_a', routeServerId: 'server-a', routeAnchor: true,
            surfaceFocused: false, surfaceVisible: false, jumpToSeq: 42, routeHydrationState: props.routeProps.routeHydrationState });
        expect(rendered[1]).toMatchObject({ sessionId: 'sess_b', routeServerId: 'server-a', routeAnchor: false,
            surfaceFocused: true, surfaceVisible: true, jumpToSeq: null, routeHydrationState: null });
        for (const routeProps of [{ ...props.routeProps, sessionId: 'missing' }, { ...props.routeProps, routeServerId: 'server-b' }]) {
            const contents = members(initialState(props), { ...props, routeProps });
            expect(contents.map(member => memberProps(member, { leafId: member.leafId, isFocused: true, isVisible: true }).routeAnchor)).toEqual([false, false]);
        }
    });

    it('retains each visited member draft while the canonical tab group changes selection', async () => {
        const props = createGroupProps();
        const initial = initialState(props);
        const screen = await renderScreen(canvas(initial, props));
        await measure(screen, initial);
        const selected = runSessionSplitCanvasCommand(initial, { type: 'activateTab', tabId: sessionCanvasTabId(scope, 'sess_a') });
        await act(async () => { screen.tree.update(canvas(selected, props)); });
        await act(async () => { screen.findByTestId('draft-sess_a')?.props.onChange('still here'); });
        const other = runSessionSplitCanvasCommand(selected, { type: 'activateTab', tabId: sessionCanvasTabId(scope, 'sess_b') });
        await act(async () => { screen.tree.update(canvas(other, props)); });
        expect(screen.findByTestId('draft-sess_a')?.props.value).toBe('still here');
        const surface = screen.findHostByTestId(`split-canvas-retained-content-${sessionCanvasTabId(scope, 'sess_a')}`);
        expect(surface?.props.pointerEvents).toBe('none');
        await act(async () => { screen.tree.update(canvas(selected, props)); });
        expect(screen.findByTestId('draft-sess_a')?.props.value).toBe('still here');
    });

    it('pauses visibility and focus for every member of a hidden maximized sibling', () => {
        const props = createGroupProps();
        const hidden = members(initialState(props), props).map(member => memberProps(member, {
            leafId: member.leafId, isVisible: false, isFocused: true,
        }));
        expect(hidden.map(member => member.surfaceVisible)).toEqual([false, false]);
        expect(hidden.map(member => member.surfaceFocused)).toEqual([false, false]);
    });

    it('preserves a visited Session member mount and local edits when it moves between leaves', async () => {
        const props = createGroupProps();
        const initial = runSessionSplitCanvasCommand(initialState(props), { type: 'openSessionInSplit', sessionId: 'sess_c', direction: 'right',
            measurement: { availableSizePx: 2000, minimumExistingSizePx: 100 } });
        const source = collectSplitCanvasLeaves(initial.root).find(leaf => leaf.payload.group.tabIds.includes(sessionCanvasTabId(scope, 'sess_b')))!;
        const target = collectSplitCanvasLeaves(initial.root).find(leaf => leaf.id !== source.id)!;
        const screen = await renderScreen(canvas(initial, props));
        await measure(screen, initial);
        const original = screen.findByTestId('draft-sess_b')!;
        const originalMount = original.props.mount;
        await act(async () => { original.props.edit(); });
        const moved = runSessionSplitCanvasCommand(initial, { type: 'moveTab', tabId: sessionCanvasTabId(scope, 'sess_b'), targetLeafId: target.id });
        await act(async () => { screen.tree.update(canvas(moved, props)); });
        expect(screen.findByTestId('draft-sess_b')?.props).toMatchObject({ mount: originalMount, value: 'unsent draft', expanded: true });
    });
});

let mountSequence = 0;
function DraftProbe(props: Readonly<{ sessionId: string }>) {
    const [mount] = React.useState(() => ++mountSequence);
    const [draft, setDraft] = React.useState('');
    const [expanded, setExpanded] = React.useState(false);
    return React.createElement('DraftProbe', { testID: `draft-${props.sessionId}`, value: draft, onChange: setDraft, mount, expanded,
        edit: () => { setDraft('unsent draft'); setExpanded(true); },
    });
}
