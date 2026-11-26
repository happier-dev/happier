import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from '@/components/sessions/agentInput/agentInputTestHelpers';

const windowSize = vi.hoisted(() => ({ width: 1200 }));
const focusObservation = vi.hoisted(() => ({
    readMainHidden: (): boolean | undefined => undefined,
    focusedWhileHidden: [] as (boolean | undefined)[],
}));
installAgentInputCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' }, {
            useWindowDimensions: () => ({ width: windowSize.width, height: 900, scale: 1, fontScale: 1 }),
        });
    },
});
// Configure the native OS boundary before the real runtime imports React Native.
const { installSessionPaneRuntimeTestHarness } = await import('@/components/sessions/panes/sessionPaneRuntimeTestHarness');
const runtime = installSessionPaneRuntimeTestHarness();

const { useAppPaneContext } = await import('@/components/appShell/panes/AppPaneProvider');
const { AppPaneScopeHost } = await import('@/components/appShell/panes/AppPaneScopeHost');
const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
const { usePaneMainColumn } = await import('@/components/appShell/panes/mainColumn/usePaneMainColumn');
const { KeyboardShortcutProvider, useKeyboardCommand } = await import('@/keyboard/KeyboardShortcutProvider');
const { AgentInput } = await import('@/components/sessions/agentInput/AgentInput');
const { storage } = await import('@/sync/domains/state/storage');
const { useOptionalAppPaneScopeLayout } = await import('@/components/appShell/panes/hooks/useAppPaneScopeLayout');
const { useReviewComposerHandoff } = await import('./useReviewComposerHandoff');

afterEach(() => { vi.unstubAllGlobals(); focusObservation.focusedWhileHidden = []; windowSize.width = 1200; });

/** Opens a reading in Details beside a visible Session, then asks from it. */
async function askFromReading(scopeId: string) {
    storage.setState({ localSettings: { ...storage.getState().localSettings,
        paneArrangement: 'session', uiMultiPanePanelsEnabled: true } });
    const refs: {
        pane: ReturnType<typeof useAppPaneScope> | null;
        layout: ReturnType<typeof useOptionalAppPaneScopeLayout>;
        handoff: (() => void) | null;
    } = { pane: null, layout: null, handoff: null };
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
    focusObservation.readMainHidden = () => refs.layout?.mainHidden;
    function Session() {
        const { dispatch } = useAppPaneContext();
        refs.pane = useAppPaneScope(scopeId);
        refs.layout = useOptionalAppPaneScopeLayout();
        refs.handoff = useReviewComposerHandoff(scopeId);
        React.useEffect(() => {
            dispatch({ type: 'openDetailsTab', scopeId, tab: {
                key: 'scmReview:working', kind: 'scmReview', title: 'Walkthrough', resource: { view: 'walkthrough' },
            }, openAs: 'pinned' });
        }, [dispatch]);
        return <AgentInput value="" onChangeText={() => {}} onSend={() => {}}
            placeholder="Message" autocompleteKinds={[]} autocompleteSuggestions={async () => []} />;
    }
    await renderScreen(<KeyboardShortcutProvider handlers={{}}><AppPaneScopeHost scopeId={scopeId} arrangement="honour"
        mainColumn={{ hideLabel: 'Hide session', showLabel: 'Show session', identity: { name: 'Session' } }}
        main={<Session />} emptyEditorPane={<div />} />
    </KeyboardShortcutProvider>, { wrapper: runtime.Wrapper,
        createNodeMock: element => element.type === 'HappierComposerInput' ? {
            focus: () => { focusObservation.focusedWhileHidden.push(focusObservation.readMainHidden()); },
            blur: () => {}, setSelection: () => {}, setTextAndSelection: () => {},
            offsetAtPoint: async () => null, setDropCaret: () => {}, measureInWindow: () => {},
        } : null,
    });
    const presentation = refs.layout?.layout.details;
    await act(async () => {
        refs.handoff?.();
        await new Promise(resolve => setTimeout(resolve, 0));
    });
    await act(async () => { for (const callback of frames.splice(0)) callback(0); });
    return { refs, presentation };
}

describe('review composer handoff', () => {
    it('shows the retained session before focusing in Editor-first while keeping review state', async () => {
        const scopeId = 'session:review-handoff';
        storage.setState({ localSettings: { ...storage.getState().localSettings,
            paneArrangement: 'editor', uiMultiPanePanelsEnabled: true } });
        const refs: {
            pane: ReturnType<typeof useAppPaneScope> | null;
            main: ReturnType<typeof usePaneMainColumn>;
            handoff: (() => void) | null;
            requestFocus: (() => void) | null;
            command: ReturnType<typeof useKeyboardCommand> | null;
            setPresented: React.Dispatch<React.SetStateAction<boolean>> | null;
        } = { pane: null, main: null, handoff: null, requestFocus: null, command: null, setPresented: null };
        const frames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
        focusObservation.readMainHidden = () => refs.main?.hidden;
        let sent = false;
        function Session() {
            const [presented, setPresented] = React.useState(true);
            const surfacePresentation = React.useMemo(() => ({ get: () => presented, subscribe: () => () => {} }), [presented]);
            const { dispatch } = useAppPaneContext();
            refs.pane = useAppPaneScope(scopeId);
            refs.main = usePaneMainColumn();
            refs.handoff = useReviewComposerHandoff(scopeId);
            refs.command = useKeyboardCommand();
            refs.setPresented = setPresented;
            React.useEffect(() => {
                dispatch({ type: 'openDetailsTab', scopeId, tab: {
                    key: 'scmReview:working', kind: 'scmReview', title: 'Review', resource: {},
                }, openAs: 'pinned' });
                dispatch({ type: 'setDetailsTabState', scopeId, tabKey: 'scmReview:working', nextState: { scrollTop: 120 } });
                dispatch({ type: 'openRight', scopeId, tabId: 'git' });
            }, [dispatch]);
            return <AgentInput value="Keep this draft" onChangeText={() => {}} onSend={() => { sent = true; }}
                placeholder="Message" autocompleteKinds={[]} autocompleteSuggestions={async () => []}
                surfacePresentation={surfacePresentation} onComposerFocusRequestChange={request => { refs.requestFocus = request; }} />;
        }
        const screen = await renderScreen(<KeyboardShortcutProvider handlers={{}}><AppPaneScopeHost scopeId={scopeId} arrangement="honour"
            mainColumn={{ hideLabel: 'Hide session', showLabel: 'Show session', identity: { name: 'Session' } }}
            main={<Session />} emptyEditorPane={<div />} />
        </KeyboardShortcutProvider>, { wrapper: runtime.Wrapper,
            // The native composer view owns its imperative focus handle.
            createNodeMock: element => element.type === 'HappierComposerInput' ? {
                focus: () => { focusObservation.focusedWhileHidden.push(focusObservation.readMainHidden()); },
                blur: () => {}, setSelection: () => {}, setTextAndSelection: () => {},
                offsetAtPoint: async () => null, setDropCaret: () => {}, measureInWindow: () => {},
            } : null,
        });
        const retainedInput = screen.root.findByType(AgentInput);
        await act(async () => { refs.main?.setHidden(true); });
        expect(refs.main?.hidden).toBe(true);
        focusObservation.focusedWhileHidden = [];
        let commandHandled = false;
        await act(async () => { commandHandled = refs.command?.('composer.focus') ?? false; });
        expect(commandHandled).toBe(true);
        expect(refs.main?.hidden).toBe(false);
        expect(focusObservation.focusedWhileHidden.length).toBeGreaterThan(0);
        expect(focusObservation.focusedWhileHidden.every(hidden => hidden === false)).toBe(true);
        focusObservation.focusedWhileHidden = [];
        await act(async () => { refs.main?.setHidden(true); });
        await act(async () => {
            refs.handoff?.();
            await new Promise(resolve => setTimeout(resolve, 0));
        });
        expect(refs.pane?.scopeState?.details.isOpen).toBe(false);
        expect(refs.pane?.scopeState?.right.isOpen).toBe(false);
        const details = refs.pane?.scopeState?.details;
        expect(details?.tabs.map(tab => tab.key)).toEqual(['scmReview:working']);
        expect(details?.tabState['scmReview:working']).toEqual({ scrollTop: 120 });
        expect(focusObservation.focusedWhileHidden).toEqual([]);
        await act(async () => { for (const callback of frames.splice(0)) callback(0); });
        expect(refs.main?.hidden).toBe(false);
        expect(refs.pane?.scopeState?.mainHidden).toBe(false);
        expect(focusObservation.focusedWhileHidden.length).toBeGreaterThan(0);
        expect(focusObservation.focusedWhileHidden.every(hidden => hidden === false)).toBe(true);
        expect(screen.root.findByType(AgentInput)).toBe(retainedInput);
        await act(async () => { refs.main?.setHidden(true); });
        expect(refs.requestFocus).toBeTypeOf('function');
        const beforeImperativeFocusCount = focusObservation.focusedWhileHidden.length;
        await act(async () => { refs.requestFocus?.(); });
        expect(refs.main?.hidden).toBe(false);
        expect(focusObservation.focusedWhileHidden.length).toBeGreaterThan(beforeImperativeFocusCount);
        expect(focusObservation.focusedWhileHidden.every(hidden => hidden === false)).toBe(true);
        const focusCount = focusObservation.focusedWhileHidden.length;
        await act(async () => { refs.setPresented?.(false); refs.main?.setHidden(true); });
        await act(async () => { refs.requestFocus?.(); refs.command?.('composer.focus'); });
        expect(refs.main?.hidden).toBe(true);
        expect(focusObservation.focusedWhileHidden.length).toBe(focusCount);
        await act(async () => { refs.setPresented?.(true); });
        await act(async () => { refs.requestFocus?.(); refs.setPresented?.(false); });
        expect(focusObservation.focusedWhileHidden.length).toBe(focusCount);
        await act(async () => { refs.setPresented?.(true); });
        expect(focusObservation.focusedWhileHidden.length).toBe(focusCount);
        expect(sent).toBe(false);
    });

    it('keeps a reading docked beside the visible Session open and only focuses the composer', async () => {
        const { refs, presentation } = await askFromReading('session:ask-docked');
        expect(presentation).toBe('docked');
        expect(refs.pane?.scopeState?.details.isOpen).toBe(true);
        expect(refs.pane?.scopeState?.details.tabs.map(tab => tab.key)).toEqual(['scmReview:working']);
        expect(focusObservation.focusedWhileHidden.length).toBeGreaterThan(0);
    });

    it('closes a reading that overlays the Session before focusing the composer', async () => {
        windowSize.width = 600;
        const { refs, presentation } = await askFromReading('session:ask-overlay');
        expect(presentation).toBe('overlay');
        expect(refs.pane?.scopeState?.details.isOpen).toBe(false);
        expect(refs.pane?.scopeState?.details.tabs.map(tab => tab.key)).toEqual(['scmReview:working']);
        expect(focusObservation.focusedWhileHidden.length).toBeGreaterThan(0);
    });
});
