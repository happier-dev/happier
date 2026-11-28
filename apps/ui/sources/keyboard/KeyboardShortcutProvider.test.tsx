import * as React from 'react';
import * as zustandTraditional from 'zustand/traditional';
import { JSDOM } from 'jsdom';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import { Modal } from '@/modal';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { KeyboardShortcutProvider, KeyboardShortcutContextBridge, useKeyboardShortcutContextSnapshot, type KeyboardShortcutContextSnapshot, useKeyboardShortcutHandlers, useFindSurfaceRegistration, useFindSurfaceRegistrationHost, useEmbeddedFindKeyboard, useEmbeddedEditorKeyboard, useNativeKeyboardInput, useKeyboardCommand } from './KeyboardShortcutProvider';
import { useKeyboardShortcutLabel } from './shortcutLabels';
import { useInboxItemNavigation } from '@/hooks/inbox/useInboxItemNavigation';
import type { InboxItem } from '@/components/inbox/inboxItems';
import type { FindController } from '@happier-dev/plugin-ui/presentation';
import { AppPaneProvider, useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import { buildDetailsWorkspaceStateView } from '@/components/appShell/panes/details/workspace/detailsWorkspaceSelectors';
import { SessionCockpitSurfaceNavigationProvider } from '@/components/workspaceCockpit/session/SessionCockpitSurfaceNavigation';
import { useReviewComposerHandoff } from '@/components/sessions/reviews/comments/useReviewComposerHandoff';
import { ESCAPE_LAYER_PRIORITIES, registerEscapeLayer } from './escape';
import type { NativeHardwareKeyboardEvent } from '@/components/sessions/agentInput/subscribeToIosHardwareShiftEnter';
import { useEditorChangeMarkers, type EditorChangeMarkersController } from '@/components/ui/code/editor/useEditorChangeMarkers';
import { buildEditorChangeMarkers } from '@/components/ui/code/editor/editorChangeMarkers';
import { createCodeMirrorDecorations } from '@/components/ui/code/editor/bridge/codeMirrorDecorations';
import type { CodeEditorHandle, TextEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import * as cmState from '@codemirror/state';
import * as cmView from '@codemirror/view';
import { ShortcutsSheet } from './shortcutsSheet/ShortcutsSheet';
import { useImageAnnotator } from '@/components/ui/media/annotation/useImageAnnotator';
import { useBrowserKeyboardShortcuts, type BrowserKeyboardShortcutLabels } from '@/components/browser/useBrowserKeyboardShortcuts';
import { selectBrowserToolbarModel } from '@/sync/domains/browser/shell';
import type { ImageAnnotator } from '@/components/ui/media/annotation/annotatorStore';

// ESM namespace exports cannot be reconfigured; Vitest supplies transparent spies.
vi.mock('zustand/traditional', { spy: true });

const testState = vi.hoisted(() => ({
    platformOS: 'web',
}));
const initialSettings = storage.getState().settings;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            get OS() {
                return testState.platformOS;
            },
            select: <T,>(options: { web?: T; ios?: T; android?: T; native?: T; default?: T }) =>
                testState.platformOS === 'web'
                    ? options.web ?? options.default ?? options.native
                    : testState.platformOS === 'ios'
                      ? options.ios ?? options.native ?? options.default
                      : options.android ?? options.native ?? options.default,
        },
    });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

const nativeKeyboardState = vi.hoisted(() => ({
    listeners: new Set<(event: NativeHardwareKeyboardEvent) => void>(),
    enabled: false,
    consumableSignatures: null as readonly string[] | null,
    signaturesAtSubscription: null as readonly string[] | null,
}));

// Only OS delivery is replaced; the real bridge owns subscription lifetime and configuration.
vi.mock('expo-modules-core', async (importOriginal) => ({
    ...await importOriginal<typeof import('expo-modules-core')>(),
    requireOptionalNativeModule: (name: string) => name === 'HappierHardwareKeyboardShortcuts' ? {
        addListener: (event: string, listener: (event: NativeHardwareKeyboardEvent) => void) => {
            if (event === 'hardwareKey') {
                nativeKeyboardState.listeners.add(listener);
                nativeKeyboardState.signaturesAtSubscription = nativeKeyboardState.consumableSignatures;
            }
            return { remove: () => nativeKeyboardState.listeners.delete(listener) };
        },
        setHardwareKeyEventsEnabled: (enabled: boolean) => { nativeKeyboardState.enabled = enabled; },
        setHardwareKeyConsumableEventSignatures: (signatures: readonly string[]) => {
            nativeKeyboardState.consumableSignatures = [...signatures];
        },
    } : null,
}));

describe('KeyboardShortcutProvider', () => {
    it('admits native mode keys only for composer focus while preserving explicit palette execution', async () => {
        testState.platformOS = 'ios';
        const modes: string[] = [];
        let execute: ReturnType<typeof useKeyboardCommand> = () => false;
        function Composer({ focused }: { focused: boolean }) {
            useKeyboardShortcutHandlers({ 'mode.cycle': () => { modes.push('plan'); } }, undefined, { isComposerTarget: focused });
            execute = useKeyboardCommand();
            return <Child />;
        }
        const content = (focused: boolean) => <KeyboardShortcutProvider handlers={{}}><Composer focused={focused} /></KeyboardShortcutProvider>;
        const screen = await renderScreen(content(true));
        const key = { key: 'Tab', code: 'Tab', modifiers: { shift: true, ctrl: false, meta: false, alt: false },
            repeat: false, target: 'reactNativeTextInput', isEditableTarget: true };
        await act(async () => { emitNativeKeyboardEvent(key); });
        expect(modes).toEqual(['plan']);
        await screen.update(content(false));
        await act(async () => { emitNativeKeyboardEvent(key); });
        expect(modes).toEqual(['plan']);
        await act(async () => { expect(execute('mode.cycle')).toBe(true); });
        expect(modes).toEqual(['plan', 'plan']);
    });
    it('exposes availability and invocation from the same mounted command registrations', async () => {
        let snapshot: KeyboardShortcutContextSnapshot;
        let opened = 0;
        function Probe({ active }: { active: boolean }) {
            useKeyboardShortcutHandlers(active ? { 'session.panel.files.open': () => { opened += 1; } } : {});
            snapshot = useKeyboardShortcutContextSnapshot();
            return null;
        }
        const content = (active: boolean) => <KeyboardShortcutProvider handlers={{}}><Probe active={active} /></KeyboardShortcutProvider>;
        const screen = await renderScreen(content(true));
        try {
            expect(snapshot!.registration?.isCommandAvailable('session.panel.files.open')).toBe(true);
            expect(snapshot!.registration?.executeCommand('session.panel.files.open')).toBe(true);
            expect(opened).toBe(1);
            await screen.update(content(false));
            expect(snapshot!.registration?.isCommandAvailable('session.panel.files.open')).toBe(false);
            expect(snapshot!.registration?.executeCommand('session.panel.files.open')).toBe(false);
        } finally { await screen.unmount(); }
    });
    it('keeps browser hints aligned with disabled, rebound and unavailable commands', async () => {
        testState.platformOS = 'web';
        vi.stubGlobal('navigator', { platform: 'Win32' });
        storage.setState({ settings: { ...initialSettings, keyboardShortcutsV2Enabled: false } });
        const back = vi.fn();
        let hints: BrowserKeyboardShortcutLabels = {};
        function Browser({ canGoBack }: { canGoBack: boolean }) {
            hints = useBrowserKeyboardShortcuts({
                model: { ...selectBrowserToolbarModel(null), canGoBack }, containsTarget: () => true,
                onBack: back, onForward: () => {}, onFocusAddress: () => {}, onReload: () => {}, onStop: () => {},
            });
            return null;
        }
        const element = (canGoBack: boolean) => <KeyboardShortcutProvider handlers={{}}><Browser canGoBack={canGoBack} /></KeyboardShortcutProvider>;
        const screen = await renderScreen(element(true));
        try {
            expect(hints['browser.back']).toBeUndefined();
            await act(async () => {
                window.dispatchEvent(createKeyboardEvent({ key: '[', code: 'BracketLeft', altKey: true }));
            });
            expect(back).not.toHaveBeenCalled();
            await act(async () => {
                storage.setState({ settings: { ...initialSettings, keyboardShortcutsV2Enabled: true,
                    keyboardShortcutOverridesV1: { 'browser.back': [{ binding: 'Alt+B' }] } } });
            });
            expect(hints['browser.back']).toBe('Alt+B');
            await act(async () => {
                window.dispatchEvent(createKeyboardEvent({ key: 'b', code: 'KeyB', altKey: true }));
            });
            expect(back).toHaveBeenCalledTimes(1);
            await screen.update(element(false));
            expect(hints['browser.back']).toBeUndefined();
        } finally {
            await screen.unmount();
        }
    });

    it.each([false, true])('dispatches and labels the mounted annotator at default preferences, then releases its keys on exit (modal bridge: %s)', async bridged => {
        testState.platformOS = 'web';
        vi.stubGlobal('navigator', { platform: 'MacIntel' });
        storage.setState({ settings: { ...initialSettings, keyboardShortcutsV2Enabled: false,
            keyboardSingleKeyShortcutsEnabled: false } });
        let annotator: ImageAnnotator | undefined;
        let arrowLabel: string | undefined;
        let snapshot: KeyboardShortcutContextSnapshot | undefined;
        const newSession = vi.fn();
        function Caller() {
            const current = useKeyboardShortcutContextSnapshot();
            // A modal captures the caller's context once, before its editor registers.
            snapshot ??= current;
            return null;
        }
        function Annotate() {
            annotator = useImageAnnotator({ source: { uri: 'blob:picture', width: 100, height: 100, scale: 1 } });
            arrowLabel = useKeyboardShortcutLabel('annotation.arrow');
            return null;
        }
        const element = (open: boolean) => <KeyboardShortcutProvider handlers={{ 'session.new': newSession }}>
            <Caller />
            {open && snapshot ? bridged
                ? <KeyboardShortcutContextBridge snapshot={snapshot}><Annotate /></KeyboardShortcutContextBridge>
                : <Annotate /> : null}
        </KeyboardShortcutProvider>;
        const screen = await renderScreen(element(false));
        try {
            await screen.update(element(true));
            const editor = annotator!;
            await act(async () => {
                editor.setCanvasFocused(true);
                editor.apply([{ kind: 'mark.add', mark: { id: 'selected', kind: 'step', at: { x: 10, y: 10 }, color: 'red', size: 's' } }], 'selected');
                window.dispatchEvent(createKeyboardEvent({ key: 'a', code: 'KeyA' }));
            });
            expect(editor.store.getState().tool).toBe('arrow');
            expect(arrowLabel).toBe('A');
            await act(async () => { window.dispatchEvent(createKeyboardEvent({ key: 'Delete', code: 'Delete' })); });
            expect(editor.store.getState().document.marks).toHaveLength(0);
            await act(async () => { window.dispatchEvent(createKeyboardEvent({ key: 'z', code: 'KeyZ', metaKey: true })); });
            expect(editor.store.getState().document.marks).toHaveLength(1);
            editor.setTool('blur');
            const input = new JSDOM('<input>').window.document.querySelector('input');
            await act(async () => { window.dispatchEvent(createKeyboardEvent({ key: 'a', code: 'KeyA', target: input })); });
            expect(editor.store.getState().tool).toBe('blur');
            await screen.update(element(false));
            editor.setTool('select');
            await act(async () => {
                window.dispatchEvent(createKeyboardEvent({ key: 'a', code: 'KeyA' }));
                window.dispatchEvent(createKeyboardEvent({ key: 'n', code: 'KeyN', metaKey: true }));
            });
            expect(editor.store.getState().tool).toBe('select');
            expect(newSession).not.toHaveBeenCalled();
        } finally {
            await screen.unmount();
        }
    });

    it('does not execute keyboard selectors for unrelated settings and updates labels for a keyboard preference', async () => {
        testState.platformOS = 'ios';
        storage.setState({ settings: { ...initialSettings, keyboardShortcutsV2Enabled: true } });
        const selected = vi.fn();
        const { useStoreWithEqualityFn: useStore } = await vi.importActual<typeof zustandTraditional>('zustand/traditional');
        // Transparent instrumentation: the actual store, routing, selector and equality all run.
        vi.mocked(zustandTraditional.useStoreWithEqualityFn).mockImplementation((api, selector, equality) =>
            useStore(api, selector ? state => { selected(); return selector(state); } : selector, equality));
        let label: string | undefined;
        function Labels() {
            useKeyboardShortcutHandlers({ 'settings.open': () => 'handled' });
            label = useKeyboardShortcutLabel('settings.open');
            return null;
        }
        const screen = await renderScreen(<KeyboardShortcutProvider handlers={{}}><Labels /></KeyboardShortcutProvider>);
        try {
            expect(label).toBeDefined();
            selected.mockClear();
            await act(async () => {
                for (let index = 0; index < 10; index += 1) storage.setState(state => ({
                    settings: { ...state.settings, transcriptMessageCopyActionEnabled: index % 2 === 0 },
                }));
            });
            expect(selected).not.toHaveBeenCalled();
            await act(async () => storage.setState(state => ({
                settings: { ...state.settings, keyboardShortcutsV2Enabled: false },
            })));
            expect(selected).toHaveBeenCalled();
            expect(label).toBeUndefined();
        } finally {
            await screen.unmount();
            vi.mocked(zustandTraditional.useStoreWithEqualityFn).mockRestore();
            vi.restoreAllMocks();
            storage.setState({ settings: initialSettings });
        }
    });

    it('publishes shortcut labels only when their content changes, not on every provider render', async () => {
        testState.platformOS = 'web';
        storage.setState({ settings: { ...initialSettings, keyboardShortcutsV2Enabled: true } });
        let snapshot: KeyboardShortcutContextSnapshot | undefined;
        let rerender: (() => void) | undefined;
        function Probe() {
            snapshot = useKeyboardShortcutContextSnapshot();
            return null;
        }
        function Parent() {
            const [, setTick] = React.useState(0);
            rerender = () => setTick(tick => tick + 1);
            // A fresh handlers object each render, as real parents pass.
            return <KeyboardShortcutProvider handlers={{}}><Probe /></KeyboardShortcutProvider>;
        }
        const screen = await renderScreen(<Parent />);
        try {
            const labels = snapshot!.registration!.labels;
            const published = vi.fn();
            const stop = labels.subscribe(published);
            const first = labels.getState();
            for (let index = 0; index < 5; index += 1) await act(async () => { rerender!(); });
            stop();
            expect(published).not.toHaveBeenCalled();
            expect(labels.getState()).toBe(first);
        } finally {
            await screen.unmount();
            storage.setState({ settings: initialSettings });
        }
    });

    it('keeps label consumers from re-rendering when the provider recomputes identical labels', async () => {
        testState.platformOS = 'web';
        storage.setState({ settings: { ...initialSettings, keyboardShortcutsV2Enabled: true } });
        let rerender: (() => void) | undefined;
        let consumerRenders = 0;
        const consumer = <Consumer />;
        function Consumer() {
            useKeyboardShortcutLabel('find.next');
            consumerRenders += 1;
            return null;
        }
        function Parent() {
            const [, setTick] = React.useState(0);
            rerender = () => setTick(tick => tick + 1);
            // A fresh handlers object each render recomputes the labels with the same content.
            return <KeyboardShortcutProvider handlers={{}}>{consumer}</KeyboardShortcutProvider>;
        }
        const screen = await renderScreen(<Parent />);
        try {
            const before = consumerRenders;
            for (let index = 0; index < 5; index += 1) await act(async () => { rerender!(); });
            expect(consumerRenders).toBe(before);
        } finally {
            await screen.unmount();
            storage.setState({ settings: initialSettings });
        }
    });

    it.each(['web', 'ios', 'android'])('keeps unchanged Find refreshes local on %s while publishing real availability and open changes', async platform => {
        testState.platformOS = platform;
        vi.stubGlobal('navigator', { platform: 'Linux' });
        const facts = { focused: true, available: true, open: false, inputFocused: false };
        let host: ReturnType<typeof useFindSurfaceRegistrationHost> | undefined;
        let embedded: ReturnType<typeof useEmbeddedEditorKeyboard> | undefined;
        let nextLabel: string | undefined;
        let labelRenders = 0;
        let embeddedRenders = 0;
        const controller: FindController = {
            query: '', options: { matchCase: false, regex: false }, status: { kind: 'idle' },
            capabilities: { regex: true, stop: false }, setQuery() {}, setOptions() {}, step() {}, stop() {},
            close() { facts.open = false; facts.inputFocused = false; host?.refresh(); },
        };
        function Surface() {
            host = useFindSurfaceRegistrationHost();
            useFindSurfaceRegistration({ surfaceId: 'editor', containsFocus: () => facts.focused,
                isAvailable: () => facts.available, isOpen: () => facts.open, isInputFocused: () => facts.inputFocused,
                open() { facts.open = true; facts.inputFocused = true; host?.refresh(); }, controller });
            return null;
        }
        function Labels() {
            useKeyboardShortcutLabel('files.editor.save');
            nextLabel = useKeyboardShortcutLabel('find.next');
            labelRenders += 1;
            return null;
        }
        function Embedded() {
            embedded = useEmbeddedEditorKeyboard();
            embeddedRenders += 1;
            return null;
        }
        await renderScreen(<KeyboardShortcutProvider handlers={{}}><Surface /><Labels /><Embedded /></KeyboardShortcutProvider>);
        const before = { labels: labelRenders, embedded: embeddedRenders };
        const refresh = host!.refresh;
        const focusListeners = vi.mocked(window.addEventListener).mock.calls
            .filter(([type]) => type === 'focusin' || type === 'focusout').map(([, listener]) => listener);
        for (let index = 0; index < 20; index += 1) {
            await act(async () => {
                // Web advertises the same Find commands before and after editor focus.
                if (platform === 'web') facts.focused = index % 2 === 1;
                refresh();
                for (const listener of focusListeners) {
                    if (typeof listener === 'function') listener(new Event('focusin'));
                }
            });
        }
        expect({ labels: labelRenders, embedded: embeddedRenders }).toEqual(before);
        const escape = 'Escape|shift=false|ctrl=false|meta=false|alt=false';
        expect(embedded?.signatures).not.toContain(escape);
        await act(async () => {
            expect(embedded?.dispatch({ key: 'f', code: 'KeyF', repeat: false,
                modifiers: { ctrl: platform !== 'ios', meta: platform === 'ios', shift: false, alt: false } })).toBe(true);
        });
        expect(facts.open).toBe(true);
        expect(embedded?.signatures).toContain(escape);
        expect(nextLabel).toBeDefined();
        if (platform !== 'web') expect(nativeKeyboardState.consumableSignatures).toEqual(expect.arrayContaining([
            escape, 'Enter|shift=false|ctrl=false|meta=false|alt=false',
        ]));
        const labelsBeforeInputBlur = labelRenders;
        await act(async () => { facts.inputFocused = false; refresh(); });
        expect(labelRenders).toBe(labelsBeforeInputBlur);
        if (platform !== 'web') expect(nativeKeyboardState.consumableSignatures).not.toContain('Enter|shift=false|ctrl=false|meta=false|alt=false');
        await act(async () => { expect(embedded?.dispatch({ key: 'Escape', code: 'Escape', repeat: false,
            modifiers: { ctrl: false, meta: false, shift: false, alt: false } })).toBe(true); });
        expect(facts.open).toBe(false);
        expect(embedded?.signatures).not.toContain(escape);
        await act(async () => { facts.available = false; refresh(); });
        expect(embedded?.dispatch({ key: 'f', code: 'KeyF', repeat: false,
            modifiers: { ctrl: platform !== 'ios', meta: platform === 'ios', shift: false, alt: false } })).toBe(false);
        if (platform !== 'web') {
            expect(nextLabel).toBeUndefined();
            expect(nativeKeyboardState.consumableSignatures).not.toContain(escape);
        }
    });
    it('invalidates an open change peek after an engine edit and refuses its stale draft revert', async () => {
        const markers = buildEditorChangeMarkers('f', null, '@@ -3 +3 @@\n-old\n+new\n');
        const runtime = createCodeMirrorDecorations({ ...cmState, ...cmView });
        let state = cmState.EditorState.create({ doc: 'first\nnew\nnew\nlast\n', extensions: runtime.extensions });
        let press: Parameters<CodeEditorHandle['onDecorationPress']>[0] | undefined;
        let controller: EditorChangeMarkersController | undefined;
        const editor: TextEditorHandle = {
            getValue: () => state.doc.toString(),
            flushPendingChange: async () => { controller?.onDocumentChange(state.doc.toString()); },
            setDecorations: (layer, items) => { state = state.update({ effects: runtime.set.of({ layer, items }) }).state; },
            removeDecoration: (layer, id) => { state = state.update({ effects: runtime.remove.of({ layer, id }) }).state; },
            onDecorationPress: (listener) => { press = listener; return () => { press = undefined; }; },
            runCommand: (command) => {
                if (typeof command === 'object' && 'replaceDocument' in command) state = state.update({ changes: { from: 0, to: state.doc.length, insert: command.replaceDocument } }).state;
            },
        };
        function Editor() {
            controller = useEditorChangeMarkers({ editor, active: true, seedKey: 'saved', markers });
            return <Child />;
        }
        await renderScreen(<KeyboardShortcutProvider handlers={{}}><Editor /></KeyboardShortcutProvider>);
        await act(async () => { press?.('change', runtime.items(state, 'change')[0]!); });
        const stale = controller!.selected!;
        state = state.update({ changes: { from: 0, insert: 'before\n' } }).state;
        const edited = state.doc.toString();
        await act(async () => { expect(await controller!.revertInDraft(stale)).toEqual({ ok: false, reason: 'moved_on' }); });
        expect(controller!.selected).toBeNull();
        expect(state.doc.toString()).toBe(edited);
        await act(async () => { press?.('change', runtime.items(state, 'change')[0]!); });
        await act(async () => { expect((await controller!.revertInDraft(controller!.selected!)).ok).toBe(true); });
        expect(state.doc.toString()).toBe('before\nfirst\nnew\nold\nlast\n');
    });
    it('routes focused editor change commands and keeps markers seeded until the saved version changes', async () => {
        const markers = buildEditorChangeMarkers('file.ts', null, '@@ -1 +1 @@\n-old\n+new\n');
        const firstCommand = vi.fn();
        const secondCommand = vi.fn();
        const firstSeed = vi.fn();
        const secondSeed = vi.fn();
        const makeEditor = (runCommand: typeof firstCommand, setDecorations: typeof firstSeed) => ({
            getValue: () => 'new\n', flushPendingChange: async () => {}, runCommand, setDecorations,
            onDecorationPress: () => () => {},
        });
        const first = makeEditor(firstCommand, firstSeed);
        const second = makeEditor(secondCommand, secondSeed);
        let execute: ReturnType<typeof useKeyboardCommand> | undefined;
        function Editors({ focused, version }: { focused: 1 | 2; version: string }) {
            useEditorChangeMarkers({ editor: first, active: focused === 1, seedKey: version, markers });
            useEditorChangeMarkers({ editor: second, active: focused === 2, seedKey: version, markers });
            execute = useKeyboardCommand();
            return <Child />;
        }
        const screen = await renderScreen(<KeyboardShortcutProvider handlers={{}}><Editors focused={1} version="saved-a" /></KeyboardShortcutProvider>);
        await act(async () => { expect(execute?.('files.editor.change.next')).toBe(true); });
        expect(firstCommand).toHaveBeenLastCalledWith('nextChange');
        expect(secondCommand).not.toHaveBeenCalled();
        firstSeed.mockClear(); secondSeed.mockClear();
        await screen.update(<KeyboardShortcutProvider handlers={{}}><Editors focused={2} version="saved-a" /></KeyboardShortcutProvider>);
        expect(firstSeed).not.toHaveBeenCalled();
        expect(secondSeed).not.toHaveBeenCalled();
        await act(async () => { expect(execute?.('files.editor.change.previous')).toBe(true); });
        expect(secondCommand).toHaveBeenLastCalledWith('prevChange');
        await screen.update(<KeyboardShortcutProvider handlers={{}}><Editors focused={2} version="saved-b" /></KeyboardShortcutProvider>);
        expect(secondSeed).toHaveBeenLastCalledWith('change', markers);
    });
    it('recovers registered review keys from a hidden focused textarea before its capture handler', async () => {
        const dom = new JSDOM('<section><textarea></textarea></section>');
        vi.stubGlobal('window', dom.window);
        vi.stubGlobal('document', dom.window.document);
        const textarea = dom.window.document.querySelector('textarea')!;
        const section = dom.window.document.querySelector('section')!;
        const captured = vi.fn();
        const next = vi.fn();
        textarea.addEventListener('keydown', captured, true);
        const screen = await renderScreen(<KeyboardShortcutProvider handlers={{ 'review.change.next': next }}><Child /></KeyboardShortcutProvider>);
        const press = () => {
            const event = new dom.window.KeyboardEvent('keydown', { key: 'j', code: 'KeyJ', bubbles: true, cancelable: true });
            textarea.dispatchEvent(event);
            return event;
        };
        try {
            await act(async () => { textarea.focus(); });
            expect(press().defaultPrevented).toBe(false);
            expect(next).not.toHaveBeenCalled();
            captured.mockClear();
            section.style.display = 'none';
            expect(press().defaultPrevented).toBe(true);
            expect(captured).not.toHaveBeenCalled();
            expect(next).toHaveBeenCalledOnce();
        } finally {
            await screen.unmount();
            // Store cleanup can read window.location; never leave a closed DOM installed.
            vi.unstubAllGlobals();
            dom.window.close();
        }
    });
    it('forwards configured Ask and Save chords from embedded editors only while their handlers are registered', async () => {
        testState.platformOS = 'ios';
        storage.setState({ settings: { ...storage.getState().settings, keyboardShortcutOverridesV1: {
            'editor.selection.ask': [{ binding: 'Mod+P' }], 'files.editor.save': [{ binding: 'Mod+Shift+S' }],
        } } });
        let editor: ReturnType<typeof useEmbeddedEditorKeyboard> | undefined;
        let terminal: ReturnType<typeof useEmbeddedFindKeyboard> | undefined;
        const ask = vi.fn();
        const save = vi.fn();
        function Embedded({ selected }: { selected: boolean }) {
            useKeyboardShortcutHandlers(selected ? { 'editor.selection.ask': ask, 'files.editor.save': save } : {});
            editor = useEmbeddedEditorKeyboard();
            terminal = useEmbeddedFindKeyboard();
            return <Child />;
        }
        const screen = await renderScreen(<KeyboardShortcutProvider handlers={{}}><Embedded selected /></KeyboardShortcutProvider>);
        expect(editor?.signatures).toContain('p|shift=false|ctrl=false|meta=true|alt=false');
        expect(terminal?.signatures).not.toContain('p|shift=false|ctrl=false|meta=true|alt=false');
        expect(editor?.signatures).toContain('s|shift=true|ctrl=false|meta=true|alt=false');
        expect(terminal?.signatures).not.toContain('s|shift=true|ctrl=false|meta=true|alt=false');
        const event = { key: 'p', code: 'KeyP', repeat: false, modifiers: { shift: false, ctrl: false, meta: true, alt: false } };
        await act(async () => { expect(editor?.dispatch(event)).toBe(true); });
        expect(ask).toHaveBeenCalledOnce();
        const saveEvent = { key: 's', code: 'KeyS', repeat: false, modifiers: { shift: true, ctrl: false, meta: true, alt: false } };
        await act(async () => { expect(editor?.dispatch(saveEvent)).toBe(true); });
        expect(save).toHaveBeenCalledOnce();
        await screen.update(<KeyboardShortcutProvider handlers={{}}><Embedded selected={false} /></KeyboardShortcutProvider>);
        expect(editor?.signatures).not.toContain('p|shift=false|ctrl=false|meta=true|alt=false');
        expect(editor?.dispatch(event)).toBe(false);
        expect(editor?.signatures).not.toContain('s|shift=true|ctrl=false|meta=true|alt=false');
        expect(editor?.dispatch(saveEvent)).toBe(false);
    });

    it('captures selection Ask before a web editor consumes its keydown', async () => {
        const ask = vi.fn();
        await renderScreen(<KeyboardShortcutProvider handlers={{ 'editor.selection.ask': ask }}><Child /></KeyboardShortcutProvider>);
        const event = createKeyboardEvent({ key: 'i', code: 'KeyI', altKey: true });
        window.dispatchEvent(event);
        expect(ask).toHaveBeenCalledOnce();
        expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
    });
    it('focuses the browser address before a pointed streamed page consumes its keys, preserving rebinding and guest typing', async () => {
        const dom = new JSDOM('<input id="address"><div id="page" tabindex="0"></div>', { url: 'https://happier.test/' });
        vi.stubGlobal('window', dom.window);
        vi.stubGlobal('document', dom.window.document);
        vi.stubGlobal('navigator', { platform: 'Win32' });
        const address = dom.window.document.querySelector<HTMLInputElement>('#address')!;
        const page = dom.window.document.querySelector<HTMLDivElement>('#page')!;
        const guestKeys: string[] = [];
        page.addEventListener('pointerdown', () => page.focus());
        page.addEventListener('keydown', event => {
            guestKeys.push(event.key);
            event.preventDefault();
            event.stopPropagation();
        });
        function Browser() {
            useBrowserKeyboardShortcuts({ model: { ...selectBrowserToolbarModel(null), canNavigate: true }, containsTarget: () => true,
                onFocusAddress: () => address.focus(), onBack() {}, onForward() {}, onReload() {}, onStop() {} });
            return null;
        }
        const screen = await renderScreen(<KeyboardShortcutProvider handlers={{}}><Browser /></KeyboardShortcutProvider>);
        const press = async (key: string) => {
            await act(async () => { page.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true })); });
            expect(dom.window.document.activeElement).toBe(page);
            await act(async () => { page.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
                key, code: `Key${key.toUpperCase()}`, altKey: true, bubbles: true, cancelable: true,
            })); });
        };
        try {
            await press('l');
            expect(dom.window.document.activeElement).toBe(address);
            expect(guestKeys).toEqual([]);
            await act(async () => { storage.setState({ settings: { ...storage.getState().settings,
                keyboardShortcutOverridesV1: { 'browser.address.focus': [{ binding: 'Alt+B' }] } } }); });
            await press('l');
            expect(dom.window.document.activeElement).toBe(page);
            expect(guestKeys).toEqual(['l']);
            await press('b');
            expect(dom.window.document.activeElement).toBe(address);
            await act(async () => { storage.setState({ settings: { ...storage.getState().settings,
                keyboardShortcutOverridesV1: {}, keyboardShortcutDisabledCommandIdsV1: ['browser.address.focus'] } }); });
            await press('l');
            expect(dom.window.document.activeElement).toBe(page);
            expect(guestKeys).toEqual(['l', 'l']);
        } finally {
            await screen.unmount();
            dom.window.close();
        }
    });
    it('opens the exact selected Inbox source anchor through its registered command without settling Needs you', async () => {
        const focus = { kind: 'session', serverId: 'home-a', id: 'source', jumpSeq: 18 } as const;
        const items: readonly InboxItem[] = [{ key: 'source', producer: 'live', type: 'decision', view: 'needs_you',
            title: 'Source', context: null, createdAt: 1, read: false, focus: { kind: 'session', serverId: 'home-a', id: 'source' },
            pageRoute: '/session/source?serverId=home-a', source: { kind: 'session', id: 'source', serverId: 'home-a' } }];
        const open = vi.fn();
        const markOpened = vi.fn(async () => {});
        let execute: ReturnType<typeof useKeyboardCommand> | undefined;
        function Inbox() {
            useInboxItemNavigation({ items, focus, view: 'needs_you', enabled: true,
                select: () => {}, close: () => {}, open, markOpened });
            execute = useKeyboardCommand();
            return <Child />;
        }
        await renderScreen(<KeyboardShortcutProvider handlers={{}}><Inbox /></KeyboardShortcutProvider>);
        await act(async () => { expect(execute?.('inbox.item.open')).toBe(true); });
        expect(open).toHaveBeenCalledWith('/session/source?serverId=home-a&jumpSeq=18');
        expect(markOpened).not.toHaveBeenCalled();
    });
    it('keeps advertising the keys that still run with general shortcuts off, and only those', async () => {
        storage.setState({ settings: { ...initialSettings, keyboardShortcutsV2Enabled: false } });
        let inboxNext: string | undefined;
        let settings: string | undefined;
        function Labels() {
            useKeyboardShortcutHandlers({ 'inbox.item.next': () => 'handled', 'settings.open': () => 'handled' });
            inboxNext = useKeyboardShortcutLabel('inbox.item.next');
            settings = useKeyboardShortcutLabel('settings.open');
            return <Child />;
        }
        try {
            await renderScreen(<KeyboardShortcutProvider handlers={{}}><Labels /></KeyboardShortcutProvider>);
            expect(inboxNext).toBeDefined();
            expect(settings).toBeUndefined();
        } finally {
            storage.setState({ settings: initialSettings });
        }
    });
    it('lets a modal own Escape before closing an open Find surface', async () => {
        let opened = true;
        const closeFind = vi.fn(() => { opened = false; });
        const controller: FindController = {
            query: '', options: { matchCase: false, regex: false }, status: { kind: 'idle' },
            capabilities: { regex: true, stop: false },
            setQuery() {}, setOptions() {}, step() {}, stop() {}, close: closeFind,
        };
        function Surface() {
            useFindSurfaceRegistration({
                surfaceId: 'file:leaf', containsFocus: () => true, open: () => { opened = true; },
                isOpen: () => opened, isInputFocused: () => true, controller,
            });
            return <Child />;
        }
        await renderScreen(<KeyboardShortcutProvider handlers={{}}><Surface /></KeyboardShortcutProvider>);
        const closeModal = vi.fn();
        const unregister = registerEscapeLayer({
            priority: ESCAPE_LAYER_PRIORITIES.modal, allowEditableTarget: true, onEscape: closeModal,
        });
        const pressEscape = () => {
            const event = createKeyboardEvent({ key: 'Escape', code: 'Escape' });
            event.preventDefault = () => { Object.defineProperty(event, 'defaultPrevented', { value: true }); };
            window.dispatchEvent(event);
        };
        try {
            await act(async () => { pressEscape(); });
            expect(closeModal).toHaveBeenCalledTimes(1);
            expect(closeFind).not.toHaveBeenCalled();
        } finally { unregister(); }
        await act(async () => { pressEscape(); });
        expect(closeFind).toHaveBeenCalledTimes(1);
    });

    it('routes native keys to the focused input before composer shortcuts and releases them on blur', async () => {
        testState.platformOS = 'ios';
        const insert = vi.fn();
        const send = vi.fn();
        const underlyingSend = vi.fn();
        function Input({ focused }: { focused: boolean }) {
            useNativeKeyboardInput(focused ? {
                bindings: ['Enter', 'Mod+Enter'],
                handleKey: (event) => {
                    if (event.key !== 'Enter') return false;
                    if (event.metaKey) send(); else insert();
                    return true;
                },
            } : null);
            return <Child />;
        }
        const element = (focused: boolean) => <KeyboardShortcutProvider handlers={{ 'composer.sendImmediate': underlyingSend }}><Input focused={focused} /></KeyboardShortcutProvider>;
        const screen = await renderScreen(element(true));
        expect(nativeKeyboardState.consumableSignatures).toContain('Enter|shift=false|ctrl=false|meta=false|alt=false');
        const event = { key: 'Enter', repeat: false, modifiers: { shift: false, ctrl: false, meta: true, alt: false } };
        await act(async () => emitNativeKeyboardEvent(event));
        expect(send).toHaveBeenCalledOnce();
        expect(underlyingSend).not.toHaveBeenCalled();
        await act(async () => emitNativeKeyboardEvent({ ...event, modifiers: { ...event.modifiers, meta: false } }));
        expect(insert).toHaveBeenCalledOnce();
        await screen.update(element(false));
        expect(nativeKeyboardState.consumableSignatures).not.toContain('Enter|shift=false|ctrl=false|meta=false|alt=false');
        await act(async () => emitNativeKeyboardEvent(event));
        expect(underlyingSend).toHaveBeenCalledOnce();
    });

    it('gives embedded renderers only configured Find chords and releases disabled bindings', async () => {
        testState.platformOS = 'ios';
        storage.setState({ settings: { ...storage.getState().settings, keyboardShortcutOverridesV1: { 'find.open': [{ binding: 'Mod+P' }] } } });
        let bridge: ReturnType<typeof useEmbeddedFindKeyboard> | undefined;
        const open = vi.fn();
        function Embedded() { bridge = useEmbeddedFindKeyboard(); return <Child />; }
        const screen = await renderScreen(<KeyboardShortcutProvider handlers={{ 'find.open': open, 'session.new': () => {} }}><Embedded /></KeyboardShortcutProvider>);
        expect(bridge?.signatures).toContain('p|shift=false|ctrl=false|meta=true|alt=false');
        expect(bridge?.signatures.some((signature) => signature.startsWith('g|'))).toBe(false);
        await act(async () => { bridge?.dispatch({ key: 'p', code: 'KeyP', repeat: false, modifiers: { shift: false, ctrl: false, meta: true, alt: false } }); });
        expect(open).toHaveBeenCalledOnce();
        await act(async () => storage.setState({ settings: { ...storage.getState().settings, keyboardShortcutDisabledCommandIdsV1: ['find.open'] } }));
        expect(bridge?.signatures).toEqual([]);
    });
    beforeEach(() => {
        vi.clearAllMocks();
        testState.platformOS = 'web';
        storage.setState({ settings: {
            ...initialSettings,
            commandPaletteEnabled: true,
            keyboardShortcutsV2Enabled: true,
            keyboardSingleKeyShortcutsEnabled: true,
            keyboardShortcutOverridesV1: {},
            keyboardShortcutDisabledCommandIdsV1: [],
        } });
        nativeKeyboardState.enabled = false;
        nativeKeyboardState.consumableSignatures = null;
        nativeKeyboardState.signaturesAtSubscription = null;
        installKeyboardWindowMock();
    });

    afterEach(() => {
        standardCleanup();
        expect(nativeKeyboardState.listeners.size).toBe(0);
        expect(nativeKeyboardState.enabled).toBe(false);
        storage.setState({ settings: initialSettings });
    });

    it('moves unhandled printable typing into the current composer on every web platform without cancelling the key', async () => {
        vi.stubGlobal('navigator', { platform: 'MacIntel' });
        storage.setState({ settings: { ...storage.getState().settings, keyboardShortcutsV2Enabled: false } });
        let focused = '';
        function Composer({ name }: { name: string }) {
            useKeyboardShortcutHandlers({ 'composer.focus': () => { focused = name; } });
            return <Child />;
        }
        const screen = await renderScreen(<KeyboardShortcutProvider handlers={{}}><Composer name="first" /></KeyboardShortcutProvider>);
        try {
            const firstKey = createKeyboardEvent({ key: 'H', shiftKey: true });
            window.dispatchEvent(firstKey);
            expect(focused).toBe('first');
            expect(firstKey.preventDefault).not.toHaveBeenCalled();
            expect(firstKey.stopPropagation).not.toHaveBeenCalled();

            await screen.update(<KeyboardShortcutProvider handlers={{}}><Composer name="second" /></KeyboardShortcutProvider>);
            focused = '';
            // AltGr reports Ctrl+Alt on Windows but still types a character such as "@".
            window.dispatchEvent(createKeyboardEvent({
                key: '@', ctrlKey: true, altKey: true,
                getModifierState: (modifier: string) => modifier === 'AltGraph',
            }));
            expect(focused).toBe('second');

            // macOS Option types characters such as "{" on a French layout.
            focused = '';
            window.dispatchEvent(createKeyboardEvent({ key: '{', altKey: true }));
            expect(focused).toBe('second');
        } finally {
            await screen.unmount();
        }
    });

    it('leaves typing alone in editors, open overlays, IME, shortcuts, Space scrolling and when turned off', async () => {
        vi.stubGlobal('navigator', { platform: 'Win32' });
        const focus = vi.fn();
        const initialLocalSettings = storage.getState().localSettings;
        const handlers = { 'composer.focus': focus };
        const screen = await renderScreen(<KeyboardShortcutProvider handlers={handlers}><Child /></KeyboardShortcutProvider>);
        const transcript = { tagName: 'DIV', closest: () => null } as unknown as EventTarget;
        try {
            for (const event of [
                { key: 'a', ctrlKey: true }, { key: 'a', metaKey: true }, { key: 'a', altKey: true },
                { key: 'a', isComposing: true }, { key: 'Dead' }, { key: 'Enter' }, { key: 'ArrowDown' },
                { key: ' ', target: transcript }, { key: ' ', shiftKey: true, target: transcript },
                { key: 'a', target: { tagName: 'INPUT' } },
                { key: 'a', target: { tagName: 'TEXTAREA' } },
                { key: 'a', target: { isContentEditable: true } },
                { key: 'a', target: { tagName: 'DIV', closest: (selector: string) => selector.includes('dialog') ? {} : null } },
                { key: 'a', defaultPrevented: true },
            ]) {
                window.dispatchEvent(createKeyboardEvent(event as Partial<KeyboardEvent>));
            }

            const closePopover = registerEscapeLayer({ priority: ESCAPE_LAYER_PRIORITIES.popover, onEscape: () => true });
            window.dispatchEvent(createKeyboardEvent({ key: 'a', target: transcript }));
            closePopover();

            await act(async () => storage.setState({ localSettings: { ...initialLocalSettings, composerTypeToFocusEnabled: false } }));
            window.dispatchEvent(createKeyboardEvent({ key: 'a', target: transcript }));
            expect(focus).not.toHaveBeenCalled();

            await act(async () => storage.setState({ localSettings: initialLocalSettings }));
            window.dispatchEvent(createKeyboardEvent({ key: 'a', target: transcript }));
            expect(focus).toHaveBeenCalledTimes(1);
        } finally {
            storage.setState({ localSettings: initialLocalSettings });
            await screen.unmount();
        }
    });

    it('captures handled Find before terminal input, passes the second Find and never steps during composition', async () => {
        vi.stubGlobal('navigator', { platform: 'MacIntel' });
        let opened = false;
        let focused = false;
        let steps = 0;
        const controller: FindController = { query: '', options: { matchCase: false, regex: false }, status: { kind: 'idle' }, capabilities: { regex: true, stop: false },
            setQuery() {}, setOptions() {}, step(direction) { steps += direction; }, stop() {}, close() { opened = false; focused = false; } };
        function Surface() {
            const [, refresh] = React.useReducer((value: number) => value + 1, 0);
            useFindSurfaceRegistration({ surfaceId: 'terminal:leaf', containsFocus: () => true, open: () => { opened = true; focused = true; refresh(); }, isOpen: () => opened, isInputFocused: () => focused, controller });
            return <Child />;
        }
        await renderScreen(<KeyboardShortcutProvider handlers={{}}><Surface /></KeyboardShortcutProvider>);
        expect(window.addEventListener).toHaveBeenCalledWith('keydown', expect.any(Function), true);
        const first = createKeyboardEvent({ key: 'f', code: 'KeyF', metaKey: true });
        await act(async () => { window.dispatchEvent(first); });
        expect(opened).toBe(true);
        expect(first.preventDefault).toHaveBeenCalledOnce();
        expect(first.stopImmediatePropagation).toHaveBeenCalledOnce();
        const second = createKeyboardEvent({ key: 'f', code: 'KeyF', metaKey: true });
        window.dispatchEvent(second);
        expect(second.preventDefault).not.toHaveBeenCalled();
        window.dispatchEvent(createKeyboardEvent({ key: 'Enter', code: 'Enter', isComposing: true }));
        expect(steps).toBe(0);
        window.dispatchEvent(createKeyboardEvent({ key: 'Enter', code: 'Enter' }));
        expect(steps).toBe(1);
        window.dispatchEvent(createKeyboardEvent({ key: 'Escape', code: 'Escape' }));
        expect(opened).toBe(false);
    });

    it.each(['browser', 'desktop'] as const)('routes Next from an editable field using the %s host chord', async (host) => {
        vi.stubGlobal('navigator', { platform: 'MacIntel' });
        if (host === 'desktop') vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async () => undefined });
        let navigations = 0;
        function ShellHost() {
            useKeyboardShortcutHandlers({ 'session.pending.next': () => { navigations += 1; } });
            return <Child />;
        }
        await renderScreen(<KeyboardShortcutProvider handlers={{}}><ShellHost /></KeyboardShortcutProvider>);
        const event = { key: 'j', code: 'KeyJ', shiftKey: true, target: { tagName: 'TEXTAREA' } as unknown as EventTarget };
        await act(async () => {
            window.dispatchEvent(createKeyboardEvent({ ...event, metaKey: host === 'desktop', altKey: host === 'browser' }));
        });
        expect(navigations).toBe(1);
        await act(async () => {
            window.dispatchEvent(createKeyboardEvent({ ...event, metaKey: host === 'browser', altKey: host === 'desktop' }));
            window.dispatchEvent(createKeyboardEvent({ ...event, metaKey: true, shiftKey: false }));
        });
        expect(navigations).toBe(1);
    });

    it('admits the rebound Voice command in an editor but ignores keys consumed by a modal and held-key repeats', async () => {
        storage.setState({ settings: {
            ...storage.getState().settings,
            keyboardShortcutOverridesV1: { 'voice.toggle': [{ binding: 'Ctrl+Alt+B' }] },
        } });
        let toggles = 0;
        function VoiceRuntime() {
            useKeyboardShortcutHandlers({ 'voice.toggle': () => { toggles += 1; } });
            return <Child />;
        }
        const screen = await renderScreen(<KeyboardShortcutProvider handlers={{}}><VoiceRuntime /></KeyboardShortcutProvider>);
        const event = { key: 'b', code: 'KeyB', ctrlKey: true, altKey: true, target: { tagName: 'TEXTAREA' } as unknown as EventTarget };
        await act(async () => {
            window.dispatchEvent(createKeyboardEvent({ ...event, defaultPrevented: true }));
            window.dispatchEvent(createKeyboardEvent({ ...event, repeat: true }));
        });
        expect(toggles).toBe(0);
        await act(async () => { window.dispatchEvent(createKeyboardEvent(event)); });
        expect(toggles).toBe(1);
        await act(async () => { screen.tree.update(<KeyboardShortcutProvider handlers={{}}><Child /></KeyboardShortcutProvider>); });
        await act(async () => { window.dispatchEvent(createKeyboardEvent(event)); });
        expect(toggles).toBe(1);
    });

    it('invokes the current scoped command from an explicit action even when shortcuts are disabled', async () => {
        storage.setState({ settings: { ...storage.getState().settings, keyboardShortcutsV2Enabled: false } });
        const { renderScreen } = await import('@/dev/testkit');
        const module = await import('./KeyboardShortcutProvider');
        let focused = '';
        let invoke: (command: 'composer.focus') => boolean = () => false;
        function Action() {
            invoke = module.useKeyboardCommand();
            return <Child />;
        }
        function Composer({ name }: { name: string }) {
            module.useKeyboardShortcutHandlers({ 'composer.focus': () => { focused = name; } });
            return <Child />;
        }
        const screen = await renderScreen(<module.KeyboardShortcutProvider handlers={{}}><Composer name="first" /><Action /></module.KeyboardShortcutProvider>);
        expect(invoke('composer.focus')).toBe(true);
        expect(focused).toBe('first');
        await act(async () => { screen.tree.update(<module.KeyboardShortcutProvider handlers={{}}><Composer name="second" /><Action /></module.KeyboardShortcutProvider>); });
        invoke('composer.focus');
        expect(focused).toBe('second');
        await act(async () => { screen.tree.update(<module.KeyboardShortcutProvider handlers={{}}><Action /></module.KeyboardShortcutProvider>); });
        expect(invoke('composer.focus')).toBe(false);
    });

    it('hands review back to mobile chat before focusing, preserving tabs without sending', async () => {
        testState.platformOS = 'ios';
        storage.setState({ settings: { ...storage.getState().settings, keyboardShortcutsV2Enabled: false } });
        const { renderScreen } = await import('@/dev/testkit');
        const { KeyboardShortcutProvider } = await import('./KeyboardShortcutProvider');
        type Surface = import('@/components/workspaceCockpit/session/sessionCockpitState').SessionMobileSurface;
        let surface: Surface = 'tabs';
        let focusedSurface: Surface | null = null;
        let sent = 0;
        let handoff = () => {};
        let paneState: ReturnType<typeof useAppPaneContext>['state'] | null = null;
        const frames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
        function Probe() {
            const context = useAppPaneContext();
            paneState = context.state;
            handoff = useReviewComposerHandoff('session:s1');
            React.useEffect(() => {
                context.dispatch({ type: 'activateScope', scopeId: 'session:s1' });
                context.dispatch({ type: 'openRight', scopeId: 'session:s1', tabId: 'git' });
                context.dispatch({ type: 'openDetailsTab', scopeId: 'session:s1', tab: { key: 'scmReview:working', kind: 'scmReview', title: 'Review', resource: {} }, openAs: 'pinned' });
                context.dispatch({ type: 'setDetailsTabState', scopeId: 'session:s1', tabKey: 'scmReview:working', nextState: { scrollTop: 120 } });
                context.dispatch({ type: 'setMainHidden', scopeId: 'session:s1', hidden: false });
            }, [context.dispatch]);
            return <Child />;
        }
        function Harness() {
            const [activeSurface, setSurface] = React.useState<Surface>('tabs');
            surface = activeSurface;
            return <KeyboardShortcutProvider handlers={{ 'composer.focus': () => { focusedSurface = activeSurface; }, 'composer.sendImmediate': () => { sent += 1; } }}>
                <SessionCockpitSurfaceNavigationProvider value={{ switchSurface: setSurface, returnToPreviousSurface: () => {} }}>
                    <AppPaneProvider><Probe /></AppPaneProvider>
                </SessionCockpitSurfaceNavigationProvider>
            </KeyboardShortcutProvider>;
        }
        try {
            await renderScreen(<Harness />);
            await act(async () => { handoff(); });
            expect(surface).toBe('chat');
            const state = paneState as ReturnType<typeof useAppPaneContext>['state'] | null;
            expect(state?.scopes['session:s1']?.mainHidden).toBe(false);
            expect(state?.scopes['session:s1']?.details.isOpen).toBe(false);
            expect(state?.scopes['session:s1']?.right.isOpen).toBe(false);
            const details = state?.scopes['session:s1']?.details;
            expect(details && buildDetailsWorkspaceStateView(details).tabs.map((tab) => tab.key)).toEqual(['scmReview:working']);
            expect(state?.scopes['session:s1']?.details.tabState['scmReview:working']).toEqual({ scrollTop: 120 });
            expect(focusedSurface).toBeNull();
            await act(async () => { for (const callback of frames) callback(0); });
            expect(focusedSurface).toBe('chat');
            expect(sent).toBe(0);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('opens the shared shortcut sheet through the registered help key', async () => {
        await renderScreen(
            <KeyboardShortcutProvider handlers={{}}>
                <Child />
            </KeyboardShortcutProvider>,
        );

        await act(async () => {
            window.dispatchEvent(createKeyboardEvent({
                key: '?',
                code: 'Slash',
                shiftKey: true,
            }));
        });

        expect(Modal.show).toHaveBeenCalledWith({ component: ShortcutsSheet,
            props: expect.objectContaining({ singleKeyShortcutsEnabled: true }) });
    });

    it('routes native hardware keyboard events through the central registry when the native hook is present', async () => {
        testState.platformOS = 'ios';
        const openCommandPalette = vi.fn();

        await renderScreen(
            <KeyboardShortcutProvider handlers={{ 'commandPalette.open': openCommandPalette }}>
                <Child />
            </KeyboardShortcutProvider>,
        );

        expect(nativeKeyboardState.enabled).toBe(true);
        expect(nativeKeyboardState.listeners.size).toBe(1);

        await act(async () => {
            emitNativeKeyboardEvent({
                key: 'k',
                code: 'KeyK',
                modifiers: { shift: false, ctrl: false, meta: true, alt: false },
                repeat: false,
                isEditableTarget: false,
            });
        });

        expect(openCommandPalette).toHaveBeenCalledTimes(1);
    });

    it('routes native Cmd+G and Shift+Cmd+G from the focused Find field using the registered commands', async () => {
        testState.platformOS = 'ios';
        const steps: number[] = [];
        const controller: FindController = {
            query: 'needle', options: { matchCase: false, regex: false }, status: { kind: 'idle' },
            capabilities: { regex: true, stop: false }, setQuery() {}, setOptions() {},
            step: (direction) => { steps.push(direction); }, stop() {}, close() {},
        };
        function Surface() {
            useFindSurfaceRegistration({ surfaceId: 'chat', containsFocus: () => true, open() {},
                isOpen: () => true, isInputFocused: () => true, controller });
            return <Child />;
        }
        await renderScreen(<KeyboardShortcutProvider handlers={{}}><Surface /></KeyboardShortcutProvider>);
        expect(nativeKeyboardState.enabled).toBe(true);
        expect(nativeKeyboardState.listeners.size).toBe(1);
        await act(async () => {
            for (const shift of [false, true]) emitNativeKeyboardEvent({ key: 'g', code: 'KeyG',
                modifiers: { shift, ctrl: false, meta: true, alt: false }, repeat: false,
                target: 'reactNativeTextInput', isEditableTarget: true });
        });
        expect(steps).toEqual([1, -1]);
        expect(nativeKeyboardState.consumableSignatures).toEqual(expect.arrayContaining([
            'g|shift=false|ctrl=false|meta=true|alt=false', 'g|shift=true|ctrl=false|meta=true|alt=false',
        ]));
    });

    it('opens the native palette from an editable target, including an older event without target metadata', async () => {
        testState.platformOS = 'ios';
        const openCommandPalette = vi.fn();

        await renderScreen(
            <KeyboardShortcutProvider handlers={{ 'commandPalette.open': openCommandPalette }}>
                <Child />
            </KeyboardShortcutProvider>,
        );

        expect(nativeKeyboardState.enabled).toBe(true);
        expect(nativeKeyboardState.listeners.size).toBe(1);

        await act(async () => {
            emitNativeKeyboardEvent({
                key: 'k',
                code: 'KeyK',
                modifiers: { shift: false, ctrl: false, meta: true, alt: false },
                repeat: false,
            });
            emitNativeKeyboardEvent({
                key: 'k',
                code: 'KeyK',
                modifiers: { shift: false, ctrl: false, meta: true, alt: false },
                repeat: false,
                isEditableTarget: true,
            });
        });

        expect(openCommandPalette).toHaveBeenCalledTimes(2);
    });

    it('configures native consumable signatures from active registry bindings before subscribing', async () => {
        testState.platformOS = 'ios';

        await renderScreen(
            <KeyboardShortcutProvider
                handlers={{
                    'composer.sendImmediate': vi.fn(),
                    'composer.abortConfirm': vi.fn(),
                    'commandPalette.open': vi.fn(),
                }}
            >
                <Child />
            </KeyboardShortcutProvider>,
        );

        const signatures = [
            'F6|shift=false|ctrl=false|meta=false|alt=false',
            'F6|shift=true|ctrl=false|meta=false|alt=false',
            'Escape|shift=true|ctrl=false|meta=false|alt=false',
            'Enter|shift=false|ctrl=false|meta=true|alt=false',
            'k|shift=false|ctrl=false|meta=true|alt=false',
        ];
        expect(nativeKeyboardState.enabled).toBe(true);
        expect(nativeKeyboardState.listeners.size).toBe(1);
        expect(nativeKeyboardState.consumableSignatures).toEqual(signatures);
        expect(nativeKeyboardState.signaturesAtSubscription).toEqual(signatures);
    });

    it('clears native consumable signatures during provider cleanup', async () => {
        testState.platformOS = 'ios';
        const screen = await renderScreen(
            <KeyboardShortcutProvider handlers={{ 'composer.sendImmediate': vi.fn() }}>
                <Child />
            </KeyboardShortcutProvider>,
        );

        expect(nativeKeyboardState.enabled).toBe(true);
        expect(nativeKeyboardState.listeners.size).toBe(1);
        expect(nativeKeyboardState.consumableSignatures).toEqual([
            'F6|shift=false|ctrl=false|meta=false|alt=false',
            'F6|shift=true|ctrl=false|meta=false|alt=false',
            'Enter|shift=false|ctrl=false|meta=true|alt=false',
        ]);
        await screen.unmount();

        expect(nativeKeyboardState.listeners.size).toBe(0);
        expect(nativeKeyboardState.enabled).toBe(false);
        expect(nativeKeyboardState.consumableSignatures).toEqual([]);
    });

    it('does not subscribe to native keyboard events when V2 is disabled and no compatibility handler can run', async () => {
        testState.platformOS = 'ios';
        storage.setState({ settings: {
            ...storage.getState().settings,
            keyboardShortcutsV2Enabled: false,
        } });

        await renderScreen(
            <KeyboardShortcutProvider handlers={{ 'session.new': vi.fn() }}>
                <Child />
            </KeyboardShortcutProvider>,
        );

        expect(nativeKeyboardState.listeners.size).toBe(0);
        expect(nativeKeyboardState.enabled).toBe(false);
        expect(nativeKeyboardState.consumableSignatures).toBeNull();
    });

    it('does not subscribe to native keyboard events when no effective handler can match', async () => {
        testState.platformOS = 'ios';
        storage.setState({ settings: {
            ...storage.getState().settings,
            keyboardSingleKeyShortcutsEnabled: false,
            keyboardShortcutDisabledCommandIdsV1: ['commandPalette.open', 'panes.region.next', 'panes.region.previous'],
        } });

        await renderScreen(
            <KeyboardShortcutProvider handlers={{ 'commandPalette.open': vi.fn() }}>
                <Child />
            </KeyboardShortcutProvider>,
        );

        expect(nativeKeyboardState.listeners.size).toBe(0);
        expect(nativeKeyboardState.enabled).toBe(false);
        expect(nativeKeyboardState.consumableSignatures).toBeNull();
    });

    it('dispatches descendant scoped handlers through the provider registry', async () => {
        testState.platformOS = 'web';
        vi.stubGlobal('navigator', { platform: 'MacIntel' });
        storage.setState({ settings: {
            ...storage.getState().settings,
            keyboardShortcutOverridesV1: {
                'session.new': [{ binding: 'Mod+P' }],
            },
        } });
        const newSession = vi.fn();

        function RegisteredChild() {
            useKeyboardShortcutHandlers(React.useMemo(() => ({
                'session.new': newSession,
            }), []));
            return <Child />;
        }

        await renderScreen(
            <KeyboardShortcutProvider handlers={{}}>
                <RegisteredChild />
            </KeyboardShortcutProvider>,
        );

        await act(async () => {
            window.dispatchEvent(createKeyboardEvent({
                key: 'p',
                code: 'KeyP',
                metaKey: true,
            }));
        });

        expect(newSession).toHaveBeenCalledTimes(1);
    });

    it('updates descendant scoped handler callbacks without re-registering unchanged command keys', async () => {
        testState.platformOS = 'ios';
        const calls: number[] = [];
        let rerenderRegisteredChild: (() => void) | null = null;

        function RegisteredChild() {
            const [version, setVersion] = React.useState(0);
            rerenderRegisteredChild = () => setVersion((current) => current + 1);
            useKeyboardShortcutHandlers(React.useMemo(() => ({
                'composer.sendImmediate': () => calls.push(version),
            }), [version]));
            return <Child />;
        }

        await renderScreen(
            <KeyboardShortcutProvider handlers={{}}>
                <RegisteredChild />
            </KeyboardShortcutProvider>,
        );

        const listener = currentNativeKeyboardListener();

        await act(async () => {
            rerenderRegisteredChild?.();
        });

        expect(currentNativeKeyboardListener()).toBe(listener);

        await act(async () => {
            emitNativeKeyboardEvent({
                key: 'Enter',
                code: 'Enter',
                modifiers: { shift: false, ctrl: false, meta: true, alt: false },
                repeat: false,
            });
        });

        expect(calls).toEqual([1]);
    });

    it('updates native root handlers without re-registering unchanged command keys', async () => {
        testState.platformOS = 'ios';
        const firstSendImmediate = vi.fn();
        const secondSendImmediate = vi.fn();

        const screen = await renderScreen(
            <KeyboardShortcutProvider handlers={{ 'composer.sendImmediate': firstSendImmediate }}>
                <Child />
            </KeyboardShortcutProvider>,
        );

        const listener = currentNativeKeyboardListener();

        await screen.update(
            <KeyboardShortcutProvider handlers={{ 'composer.sendImmediate': secondSendImmediate }}>
                <Child />
            </KeyboardShortcutProvider>,
        );

        expect(currentNativeKeyboardListener()).toBe(listener);

        await act(async () => {
            emitNativeKeyboardEvent({
                key: 'Enter',
                code: 'Enter',
                modifiers: { shift: false, ctrl: false, meta: true, alt: false },
                repeat: false,
            });
        });

        expect(firstSendImmediate).not.toHaveBeenCalled();
        expect(secondSendImmediate).toHaveBeenCalledTimes(1);
    });

    it('uses latest native root handlers before passive effects run', async () => {
        testState.platformOS = 'ios';
        const firstSendImmediate = vi.fn();
        const secondSendImmediate = vi.fn();
        function NativeDispatchOnLayout(props: Readonly<{ enabled: boolean }>) {
            React.useLayoutEffect(() => {
                if (!props.enabled) return;
                emitNativeKeyboardEvent({
                    key: 'Enter',
                    code: 'Enter',
                    modifiers: { shift: false, ctrl: false, meta: true, alt: false },
                    repeat: false,
                });
            }, [props.enabled]);
            return <Child />;
        }

        const screen = await renderScreen(
            <KeyboardShortcutProvider handlers={{ 'composer.sendImmediate': firstSendImmediate }}>
                <NativeDispatchOnLayout enabled={false} />
            </KeyboardShortcutProvider>,
        );

        const listener = currentNativeKeyboardListener();

        await screen.update(
            <KeyboardShortcutProvider handlers={{ 'composer.sendImmediate': secondSendImmediate }}>
                <NativeDispatchOnLayout enabled />
            </KeyboardShortcutProvider>,
        );

        expect(currentNativeKeyboardListener()).toBe(listener);
        expect(firstSendImmediate).not.toHaveBeenCalled();
        expect(secondSendImmediate).toHaveBeenCalledTimes(1);
    });
});

function Child() {
    return React.createElement('Child');
}

function currentNativeKeyboardListener() {
    expect(nativeKeyboardState.enabled).toBe(true);
    expect(nativeKeyboardState.listeners.size).toBe(1);
    return [...nativeKeyboardState.listeners][0];
}

function emitNativeKeyboardEvent(event: Omit<NativeHardwareKeyboardEvent, 'target'> & { target?: string }) {
    if (!nativeKeyboardState.enabled) return;
    for (const listener of nativeKeyboardState.listeners) {
        listener({ ...event, target: event.target ?? 'reactNativeTextInput' });
    }
}

function installKeyboardWindowMock() {
    const listeners = new Set<(event: KeyboardEvent) => void>();
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
            addEventListener: vi.fn((type: string, listener: (event: KeyboardEvent) => void) => {
                if (type === 'keydown') listeners.add(listener);
            }),
            removeEventListener: (type: string, listener: (event: KeyboardEvent) => void) => {
                if (type === 'keydown') listeners.delete(listener);
            },
            dispatchEvent: (event: KeyboardEvent) => {
                for (const listener of listeners) {
                    listener(event);
                }
                return true;
            },
        },
    });
}

function createKeyboardEvent(event: Partial<KeyboardEvent>): KeyboardEvent {
    return {
        key: '',
        code: '',
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        repeat: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        stopImmediatePropagation: vi.fn(),
        target: null,
        ...event,
    } as KeyboardEvent;
}
