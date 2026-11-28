import * as React from 'react';
import { JSDOM } from 'jsdom';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storage';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createTranscriptFindModel } from '@/components/sessions/transcript/find/useTranscriptFind';
import { KeyboardShortcutProvider, useFindSurfaceRegistration, useFindSurfaceRuntime, useKeyboardShortcutHandlers } from './KeyboardShortcutProvider';
import { CaptureWindowKeyboard } from '@/components/screenCapture/window/CaptureWindowKeyboard';

const boundary = vi.hoisted(() => ({ platformOS: 'web', subscribe: vi.fn(), configure: vi.fn() }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { get OS() { return boundary.platformOS; }, select: (options: Record<string, unknown>) => options[boundary.platformOS] ?? options.native ?? options.default } });
});
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@/components/sessions/agentInput/subscribeToIosHardwareShiftEnter', () => ({
    subscribeToNativeHardwareKeyboardEvents: boundary.subscribe,
    configureNativeHardwareKeyboardConsumableEventSignatures: boundary.configure,
}));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
let environment: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
// jsdom's repository declaration is untyped; narrow the external browser fixture.
let dom: { window: { close(): void; document: Document; KeyboardEvent: typeof KeyboardEvent } };
beforeEach(async () => {
    boundary.platformOS = 'web';
    boundary.subscribe.mockReset().mockReturnValue({ remove: vi.fn() });
    boundary.configure.mockReset();
    environment = await restoreServerAccountForTest({ serverUrl: 'http://find-keys.test' });
    getStorage().setState(state => ({ settings: { ...state.settings,
        keyboardSingleKeyShortcutsEnabled: false, keyboardShortcutDisabledCommandIdsV1: [], keyboardShortcutOverridesV1: {} } }));
    dom = new JSDOM('<!doctype html><textarea></textarea>', { url: 'http://find-keys.test' });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    // Keep the browser storage-lock boundary installed by Account restoration.
    vi.stubGlobal('navigator', { platform: 'Linux', locks: globalThis.navigator.locks });
});
afterEach(async () => {
    standardCleanup();
    await environment.dispose();
    dom.window.close();
    vi.unstubAllGlobals();
});

describe('Capture keys with single-key shortcuts disabled', () => {
    it('copies only with an active capture handler, leaving note and annotation text to their editor', async () => {
        const copy = vi.fn();
        let setActive: React.Dispatch<React.SetStateAction<boolean>> = () => {};
        function Capture() {
            const [active, updateActive] = React.useState(true);
            setActive = updateActive;
            useKeyboardShortcutHandlers(active ? { 'screenCapture.copy': copy } : {});
            return null;
        }
        await renderScreen(<CaptureWindowKeyboard><Capture /></CaptureWindowKeyboard>);
        const pressCopy = async () => {
            const event = new dom.window.KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true,
                bubbles: true, cancelable: true });
            await act(async () => { document.activeElement!.dispatchEvent(event); });
            return event.defaultPrevented;
        };
        expect(await pressCopy()).toBe(true);
        expect(copy).toHaveBeenCalledOnce();
        document.querySelector('textarea')!.focus();
        expect(await pressCopy()).toBe(false);
        const annotationText = document.createElement('div');
        annotationText.setAttribute('contenteditable', 'true');
        annotationText.tabIndex = 0;
        document.body.append(annotationText);
        annotationText.focus();
        expect(await pressCopy()).toBe(false);
        annotationText.blur();
        await act(async () => { setActive(false); });
        expect(await pressCopy()).toBe(false);
        expect(copy).toHaveBeenCalledOnce();
    });
});

describe('Find keys with single-key shortcuts disabled', () => {
    it('finds the last interacted surface when transcript text leaves BODY focused, and yields outside or on a second Find', async () => {
        const root = document.createElement('section');
        const transcript = document.createElement('span');
        transcript.textContent = 'Harbour tide summary';
        const input = document.createElement('input');
        root.append(transcript, input);
        const pane = document.createElement('section');
        pane.tabIndex = -1;
        pane.append(root);
        document.body.append(pane);
        const outside = document.querySelector('textarea')!;
        const model = createTranscriptFindModel({ readCorpus: () => ({ messages: [],
            history: { isLoaded: true, hasOlder: false, isLoadingOlder: false } }), loadPage: null,
            jumpToTarget: async target => ({ status: 'scrolled', target }), reveal: async () => {} });
        let surfaceRenders = 0;
        function Surface() {
            surfaceRenders += 1;
            const registration = {
                surfaceId: 'chat:harbour', controller: model,
                containsFocus: () => root.contains(document.activeElement),
                containsTarget: (target: unknown) => target !== null && typeof target === 'object' && 'nodeType' in target
                    && root.contains(target as Node),
                isOpen: () => model.getSnapshot().open,
                isInputFocused: () => document.activeElement === input,
                open: () => { model.open(); input.focus(); },
            };
            useFindSurfaceRegistration(registration);
            return null;
        }
        await renderScreen(<KeyboardShortcutProvider handlers={{}}><Surface /></KeyboardShortcutProvider>);
        const interact = (element: Element, kind = 'pointerdown') => {
            const event = document.createEvent('Event');
            event.initEvent(kind, true, true);
            element.dispatchEvent(event);
        };
        const find = async () => {
            const event = new dom.window.KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true,
                bubbles: true, cancelable: true });
            await act(async () => { document.activeElement!.dispatchEvent(event); });
            return event.defaultPrevented;
        };
        expect(document.activeElement).toBe(document.body);
        await act(async () => { interact(transcript); });
        const settledRenders = surfaceRenders;
        await act(async () => {
            for (let index = 0; index < 20; index += 1) {
                interact(transcript);
                interact(transcript, 'click');
            }
        });
        expect(surfaceRenders).toBe(settledRenders);
        expect(await find()).toBe(true);
        expect(model.getSnapshot().open).toBe(true);
        expect(document.activeElement).toBe(input);
        expect(await find()).toBe(false);
        await act(async () => {
            model.close();
            outside.focus();
            interact(transcript);
            // Real browsers focus a tabindex=-1 pane ancestor between pointerdown
            // and click when its non-focusable transcript text is clicked.
            pane.focus();
            interact(transcript, 'click');
        });
        expect(document.activeElement).toBe(pane);
        expect(await find()).toBe(true);
        expect(model.getSnapshot().open).toBe(true);
        await act(async () => { model.close(); outside.focus(); interact(outside); });
        expect(await find()).toBe(false);
        expect(model.getSnapshot().open).toBe(false);
    });

    it.each(['web', 'ios', 'android'])('opens in the composer and steps the real model on %s without stealing browser Find or blurred input keys', async platform => {
        boundary.platformOS = platform;
        const model = createTranscriptFindModel({ readCorpus: () => ({ messages: [
            { kind: 'user-text', id: 'm1', localId: null, seq: 1, createdAt: 1, text: 'needle needle needle' },
        ], history: { isLoaded: true, hasOlder: false, isLoadingOlder: false } }), loadPage: null,
            jumpToTarget: async target => ({ status: 'scrolled', target }), reveal: async () => {} });
        model.setQuery('needle');
        await model.settled();
        model.close();
        let focused = true;
        let blur = () => {};
        let submit: (() => void) | undefined;
        function Surface() {
            const opened = React.useSyncExternalStore(model.subscribe, () => model.getSnapshot().open, () => false);
            const [inputFocused, setInputFocused] = React.useState(false);
            blur = () => setInputFocused(false);
            useFindSurfaceRegistration({ surfaceId: 'chat:s1', containsFocus: () => focused,
                isOpen: () => opened, isInputFocused: () => inputFocused,
                open: () => { model.open(); setInputFocused(true); }, controller: model });
            submit = useFindSurfaceRuntime().keyboardHandlers?.onSubmitEditing;
            return null;
        }
        const screen = await renderScreen(<KeyboardShortcutProvider handlers={{}}><Surface /></KeyboardShortcutProvider>);
        const textarea: HTMLTextAreaElement = dom.window.document.querySelector('textarea')!;
        const dispatch = async (key: string, modifiers: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {}) => {
            const event: KeyboardEvent = new dom.window.KeyboardEvent('keydown', { key, code: key === 'f' ? 'KeyF' : key,
                bubbles: true, cancelable: true, ctrlKey: modifiers.ctrl ?? false, metaKey: modifiers.meta ?? false, shiftKey: modifiers.shift ?? false });
            await act(async () => {
                if (platform === 'web') textarea.dispatchEvent(event);
                else boundary.subscribe.mock.calls.at(-1)?.[0]({ key: event.key, code: event.code, repeat: false,
                    modifiers: { ctrl: event.ctrlKey, shift: event.shiftKey, meta: event.metaKey, alt: false } });
                await model.settled();
            });
            return event;
        };
        const mod = platform === 'ios' ? { meta: true } : { ctrl: true };
        const first = await dispatch('f', mod);
        expect(model.getSnapshot().open).toBe(true);
        if (platform === 'web') expect(first.defaultPrevented).toBe(true);
        await dispatch('Enter');
        expect(model.status).toMatchObject({ current: 2, total: 3 });
        await dispatch('Enter', { shift: true });
        expect(model.status).toMatchObject({ current: 1 });
        if (platform !== 'web') {
            await act(async () => { submit?.(); await model.settled(); });
            expect(model.status).toMatchObject({ current: 2 });
        }
        const second = await dispatch('f', mod);
        if (platform === 'web') expect(second.defaultPrevented).toBe(false);
        await act(async () => { blur(); });
        const current = model.status;
        await dispatch('Enter');
        expect(model.status).toEqual(current);
        focused = false;
        await act(async () => { model.close(); });
        await dispatch('f', mod);
        expect(model.getSnapshot().open).toBe(false);
        await screen.unmount();
        model.dispose();
    });
});
