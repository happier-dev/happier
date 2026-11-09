import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSignedOutAuthForTest } from '@/dev/testkit/fixtures/signedOutAuth';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const postMessageSpy = vi.fn();
const openURLSpy = vi.hoisted(() => vi.fn(() => Promise.resolve()));
let lastWebViewProps: any = null;
const unistylesState = vi.hoisted(() => ({
    themeOverride: {
        dark: true,
        colors: {
            text: { primary: '#abcdef' },
        },
    },
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'ios' },
        View: 'View',
        PixelRatio: {
            getFontScale: () => 1,
        },
        Linking: {
            openURL: openURLSpy,
        },
    });
});

vi.mock('react-native-webview', () => ({
    WebView: React.forwardRef((props: any, ref: any) => {
        lastWebViewProps = props;
        if (ref) {
            ref.current = {
                postMessage: postMessageSpy,
            };
        }
        return React.createElement('WebView', props, props.children);
    }),
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    const { createThemeFixture } = await import('@/dev/testkit/fixtures/themeFixtures');
    const base = await createUnistylesMock();
    const baseRt = base.useUnistyles().rt;
    return {
        ...base,
        useUnistyles: () => ({
            theme: createThemeFixture(unistylesState.themeOverride),
            rt: baseRt,
        }),
    };
});

vi.mock('@/sync/store/hooks', () => ({
    useLocalSetting: () => 1,
}));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { storage } = await import('@/sync/domains/state/storage');
const { TiptapWebViewSurface } = await import('./TiptapWebViewSurface.native');
const { requestOpenExternalUrl } = await import('@/utils/url/requestOpenExternalUrl');
const initialStorage = storage.getState();
afterEach(async () => { storage.setState(initialStorage, true); await homes.reset(); });
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import type { MarkdownEditorSurfaceRef } from './TiptapWebViewSurface.native';
import { createEditorDocumentHistory } from '@/components/ui/code/editor/editorDocumentHistory';

function emitEnvelope(envelope: any) {
    if (!lastWebViewProps?.onMessage) throw new Error('WebView onMessage missing');
    lastWebViewProps.onMessage({ nativeEvent: { data: JSON.stringify(envelope) } });
}

function findPostedEnvelope(type: string, callStartIndex = 0): any {
    for (const call of postMessageSpy.mock.calls.slice(callStartIndex)) {
        const raw = call?.[0];
        if (typeof raw !== 'string') continue;
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && parsed.type === type) {
                return parsed;
            }
        } catch {
            // ignore
        }
    }
    return null;
}

function readRequestDocRequestId(callStartIndex: number): string {
    const env = findPostedEnvelope('requestDoc', callStartIndex);
    const requestId = env?.payload?.requestId;
    if (typeof requestId !== 'string' || !requestId) {
        throw new Error('requestDoc envelope not found in posted messages');
    }
    return requestId;
}

describe('TiptapWebViewSurface (native)', () => {
    it('applies HTTP Action policy at the real native bridge while retaining local tel links', async () => {
        const restoreAuth = installSignedOutAuthForTest();
        openURLSpy.mockClear();
        try {
            await renderScreen(<TiptapWebViewSurface resetKey="links" value="Open" onChange={vi.fn()} />);
            storage.setState(state => ({ settings: { ...state.settings,
                actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: { 'links.openExternal': { enabled: false } } }),
            } }));
            // Settle the lazy real executor before driving fire-and-forget bridge callbacks.
            expect(await requestOpenExternalUrl('https://example.test/guide')).toBe(false);
            await act(async () => {
                emitEnvelope({ v: 1, type: 'openLink', payload: { href: 'https://example.test/guide' } });
                await flushHookEffects();
            });
            expect(openURLSpy).not.toHaveBeenCalled();
            emitEnvelope({ v: 1, type: 'openLink', payload: { href: 'tel:+123456789' } });
            expect(openURLSpy).toHaveBeenCalledExactlyOnceWith('tel:+123456789');
            openURLSpy.mockClear();
            storage.setState(state => ({ settings: { ...state.settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1 }) } }));
            await act(async () => {
                emitEnvelope({ v: 1, type: 'openLink', payload: { href: 'https://example.test/guide' } });
                await flushHookEffects();
            });
            await vi.waitFor(() => expect(openURLSpy).toHaveBeenCalledExactlyOnceWith('https://example.test/guide'));
        } finally { restoreAuth(); }
    });
    it('rejects a flush the WebView never confirms and leaves pending history untouched', async () => {
        vi.useFakeTimers();
        try {
            const history = createEditorDocumentHistory();
            history.record('before', 'after');
            const ref = React.createRef<MarkdownEditorSurfaceRef>();
            await renderScreen(<TiptapWebViewSurface ref={ref} resetKey="unconfirmed" value="after" onChange={vi.fn()} history={history} />);
            emitEnvelope({ v: 1, type: 'ready', payload: {} });
            const failed = ref.current!.flushPendingChange().then(() => false, () => true);
            await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
            expect(await failed).toBe(true);
            expect(ref.current!.getValue()).toBe('after');
            expect(history.getSnapshot()).toEqual({ canUndo: true, canRedo: false });
            const beforeApply = vi.fn();
            await act(async () => { ref.current!.runTextCommand!({ replaceDocument: 'replacement' }, beforeApply); });
            await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
            expect(await ref.current!.flushPendingChange().then(() => false, () => true)).toBe(true);
            expect(beforeApply).not.toHaveBeenCalled();
            expect(ref.current!.getValue()).toBe('after');
            const retryStart = postMessageSpy.mock.calls.length;
            await act(async () => { ref.current!.runTextCommand!('undo'); });
            const retryId = readRequestDocRequestId(retryStart);
            await act(async () => { emitEnvelope({ v: 1, type: 'docSnapshot', payload: { requestId: retryId, doc: 'after' } }); });
            expect(ref.current!.getValue()).toBe('before');
        } finally { vi.useRealTimers(); }
    });
    it('flushes pending rich typing before an explicit replacement so each keeps its own undo step', async () => {
        postMessageSpy.mockClear();
        const history = createEditorDocumentHistory();
        let text = 'seed';
        const onChange = (next: string) => { history.record(text, next); text = next; };
        const ref = React.createRef<MarkdownEditorSurfaceRef>();
        await renderScreen(<TiptapWebViewSurface ref={ref} resetKey="replace-history" value={text} onChange={onChange} history={history} />);
        emitEnvelope({ v: 1, type: 'ready', payload: {} });
        const start = postMessageSpy.mock.calls.length;
        await act(async () => { ref.current!.runTextCommand!({ replaceDocument: 'replacement' }); });
        const requestId = readRequestDocRequestId(start);
        const flush = ref.current!.flushPendingChange().then(() => true, () => false);
        expect(postMessageSpy.mock.calls.slice(start).map(([raw]) => JSON.parse(String(raw))).filter(message => message.type === 'requestDoc')).toHaveLength(1);
        const afterStart = postMessageSpy.mock.calls.length;
        await act(async () => { emitEnvelope({ v: 1, type: 'docSnapshot', payload: { requestId, doc: 'pending typing' } }); });
        const afterId = readRequestDocRequestId(afterStart);
        await act(async () => { emitEnvelope({ v: 1, type: 'docSnapshot', payload: { requestId: afterId, doc: 'replacement' } }); });
        expect(await flush).toBe(true);
        expect(text).toBe('replacement');
        expect(history.undo(text)).toBe('pending typing');
        expect(history.undo('pending typing')).toBe('seed');
    });
    it('reinitializes a cancelled rich draft from the original seed even when only resetKey changes', async () => {
        postMessageSpy.mockClear();
        const ref = React.createRef<MarkdownEditorSurfaceRef>();
        const onChange = vi.fn();
        const screen = await renderScreen(<TiptapWebViewSurface ref={ref} resetKey="edit" value="original" onChange={onChange} />);
        emitEnvelope({ v: 1, type: 'ready', payload: {} });
        emitEnvelope({ v: 1, type: 'docChanged', payload: { doc: 'cancelled rich draft' } });
        const pendingStart = postMessageSpy.mock.calls.length;
        const cancelledFlush = ref.current!.flushPendingChange().then(() => null, error => error);
        const cancelledRequestId = readRequestDocRequestId(pendingStart);
        await screen.update(<TiptapWebViewSurface ref={ref} resetKey="cancelled" value="original" onChange={onChange} />);
        expect(await cancelledFlush).toBeInstanceOf(Error);
        emitEnvelope({ v: 1, type: 'docSnapshot', payload: { requestId: cancelledRequestId, doc: 'cancelled rich draft' } });
        expect(ref.current!.getValue()).toBe('original');
        const start = postMessageSpy.mock.calls.length;
        emitEnvelope({ v: 1, type: 'ready', payload: {} });
        expect(findPostedEnvelope('init', start)?.payload.doc).toBe('original');
    });
    it('routes the native keyboard Undo through shared history after flushing pending Markdown', async () => {
        postMessageSpy.mockClear();
        const history = createEditorDocumentHistory();
        let text = 'before';
        const onChange = vi.fn((next: string, change?: { history: 'undo' | 'redo' }) => {
            if (!change) history.record(text, next);
            text = next;
        });
        const ref = React.createRef<MarkdownEditorSurfaceRef>();
        await renderScreen(<TiptapWebViewSurface ref={ref} resetKey="shared-history" value={text} onChange={onChange} history={history} />);
        emitEnvelope({ v: 1, type: 'ready', payload: {} });
        const start = postMessageSpy.mock.calls.length;
        await act(async () => { emitEnvelope({ v: 1, type: 'history.command', payload: { command: 'undo' } }); });
        const requestId = readRequestDocRequestId(start);
        await act(async () => { emitEnvelope({ v: 1, type: 'docSnapshot', payload: { requestId, doc: 'after pending edit' } }); });
        expect(text).toBe('before');
        expect(ref.current!.getValue()).toBe('before');
        expect(onChange).toHaveBeenLastCalledWith('before', { history: 'undo' });
        expect(findPostedEnvelope('text.command', start)?.payload.command).toEqual({ replaceDocument: 'before', history: 'undo' });
        expect(history.getSnapshot()).toEqual({ canUndo: false, canRedo: true });
    });
    it('keeps Find requested before readiness and accepts only matching, valid runtime results', async () => {
        postMessageSpy.mockClear();
        const ref = React.createRef<MarkdownEditorSurfaceRef>();
        await renderScreen(<TiptapWebViewSurface ref={ref} resetKey="find" value="Retry now" onChange={vi.fn()} />);
        const find = ref.current!.find!;
        const options = { matchCase: false, regex: false };
        find.seed('Retry', options);
        expect(findPostedEnvelope('find.set')).toBeNull();
        emitEnvelope({ v: 1, type: 'ready', payload: {} });
        expect(findPostedEnvelope('find.set')?.payload).toEqual({ query: 'Retry', options });
        const status = { kind: 'results', total: 1, current: 1, coverage: 'complete' } as const;
        emitEnvelope({ v: 1, type: 'find.status', payload: { query: 'old', options, status } });
        expect(find.getSnapshot().status.kind).toBe('searching');
        emitEnvelope({ v: 1, type: 'find.status', payload: { query: 'Retry', options, status: { ...status, current: 2 } } });
        expect(find.getSnapshot().status.kind).toBe('searching');
        emitEnvelope({ v: 1, type: 'find.status', payload: { query: 'Retry', options, status } });
        expect(find.getSnapshot().status).toEqual(status);
        find.close();
        expect(findPostedEnvelope('find.close')).not.toBeNull();
    });

    beforeEach(() => {
        openURLSpy.mockClear();
        unistylesState.themeOverride = {
            dark: true,
            colors: {
                text: { primary: '#abcdef' },
            },
        };
    });

    it('seeds the editor with init only after the editor reports ready', async () => {
        postMessageSpy.mockClear();
        lastWebViewProps = null;
        const onReady = vi.fn();

        await renderScreen(React.createElement(TiptapWebViewSurface, {
            resetKey: '1',
            value: 'hello world',
            onChange: vi.fn(),
            changeDebounceMs: 10,
            onReady,
        }));

        // No init posted before ready.
        expect(findPostedEnvelope('init')).toBeNull();
        expect(onReady).not.toHaveBeenCalled();

        emitEnvelope({ v: 1, type: 'ready', payload: { ok: true } });
        expect(onReady).toHaveBeenCalledOnce();

        const init = findPostedEnvelope('init');
        expect(init).toEqual(expect.objectContaining({
            type: 'init',
            payload: expect.objectContaining({ doc: 'hello world' }),
        }));
    });

    it('forwards docChanged to onChange and updates the getValue mirror, but never on the initial seed', async () => {
        postMessageSpy.mockClear();
        lastWebViewProps = null;

        const onChange = vi.fn();
        const ref = React.createRef<any>();

        await renderScreen(React.createElement(TiptapWebViewSurface, {
            ref,
            resetKey: '1',
            value: 'seed',
            onChange,
            changeDebounceMs: 10,
        }));

        emitEnvelope({ v: 1, type: 'ready', payload: { ok: true } });

        // The init seed must NOT echo back as an onChange (R-A7). The host only
        // ever calls onChange in response to a `docChanged` envelope, so seeding
        // alone leaves onChange untouched and getValue at the seed.
        expect(onChange).not.toHaveBeenCalled();
        expect(ref.current.getValue()).toBe('seed');

        emitEnvelope({ v: 1, type: 'docChanged', payload: { doc: 'edited' } });
        expect(onChange).toHaveBeenCalledWith('edited');
        expect(ref.current.getValue()).toBe('edited');
    });

    it('resolves flushPendingChange via requestDoc/docSnapshot', async () => {
        postMessageSpy.mockClear();
        lastWebViewProps = null;

        const onChange = vi.fn();
        const ref = React.createRef<any>();

        await renderScreen(React.createElement(TiptapWebViewSurface, {
            ref,
            resetKey: '1',
            value: 'hello',
            onChange,
            changeDebounceMs: 10,
        }));

        expect(typeof ref.current.getValue).toBe('function');
        expect(typeof ref.current.flushPendingChange).toBe('function');

        emitEnvelope({ v: 1, type: 'ready', payload: { ok: true } });

        const callCountBeforeFlush = postMessageSpy.mock.calls.length;
        const flushPromise = ref.current.flushPendingChange();

        const requestId = readRequestDocRequestId(callCountBeforeFlush);
        emitEnvelope({ v: 1, type: 'docSnapshot', payload: { requestId, doc: 'final' } });

        await flushPromise;
        expect(ref.current.getValue()).toBe('final');
        expect(onChange).toHaveBeenCalledWith('final');
    });

    it('posts a command envelope when the controller runs a command', async () => {
        postMessageSpy.mockClear();
        lastWebViewProps = null;

        const ref = React.createRef<any>();

        await renderScreen(React.createElement(TiptapWebViewSurface, {
            ref,
            resetKey: '1',
            value: 'hello',
            onChange: vi.fn(),
        }));

        emitEnvelope({ v: 1, type: 'ready', payload: { ok: true } });
        const callCount = postMessageSpy.mock.calls.length;

        ref.current.runCommand({ kind: 'toggleBold' });

        const command = findPostedEnvelope('command', callCount);
        expect(command).toEqual(expect.objectContaining({
            type: 'command',
            payload: expect.objectContaining({ name: 'toggleBold' }),
        }));
    });

    it('delivers selectionState envelopes to controller subscribers', async () => {
        postMessageSpy.mockClear();
        lastWebViewProps = null;

        const ref = React.createRef<any>();

        await renderScreen(React.createElement(TiptapWebViewSurface, {
            ref,
            resetKey: '1',
            value: 'hello',
            onChange: vi.fn(),
        }));

        emitEnvelope({ v: 1, type: 'ready', payload: { ok: true } });

        const received: any[] = [];
        const unsubscribe = ref.current.subscribeSelection((state: any) => {
            received.push(state);
        });

        const selectionState = {
            marks: { bold: true, italic: false, strike: false, code: false },
            blockType: 'heading2',
            isLinkActive: false,
            canUndo: true,
            canRedo: false,
        };
        emitEnvelope({ v: 1, type: 'selectionState', payload: selectionState });

        expect(received).toContainEqual(selectionState);

        unsubscribe();
        emitEnvelope({
            v: 1,
            type: 'selectionState',
            payload: { ...selectionState, marks: { ...selectionState.marks, bold: false } },
        });
        // No further deliveries after unsubscribe.
        expect(received).toHaveLength(1);
    });

    it('delivers menuTriggerKeyDown envelopes to controller subscribers', async () => {
        postMessageSpy.mockClear();
        lastWebViewProps = null;

        const ref = React.createRef<any>();

        await renderScreen(React.createElement(TiptapWebViewSurface, {
            ref,
            resetKey: '1',
            value: 'hello',
            onChange: vi.fn(),
        }));

        emitEnvelope({ v: 1, type: 'ready', payload: { ok: true } });

        const received: any[] = [];
        const unsubscribe = ref.current.subscribeMenuKeyDown((event: any) => {
            received.push(event);
            return true;
        });

        const trigger = {
            kind: 'slash',
            query: 'heading',
            from: 1,
            to: 9,
            caretRect: { left: 10, top: 20, height: 16 },
        };
        emitEnvelope({ v: 1, type: 'menuTriggerKeyDown', payload: { key: 'ArrowDown', trigger } });

        expect(received).toEqual([{ key: 'ArrowDown', trigger }]);

        unsubscribe();
        emitEnvelope({ v: 1, type: 'menuTriggerKeyDown', payload: { key: 'ArrowUp', trigger } });
        expect(received).toHaveLength(1);
    });

    it('does not replay stale selection to new subscribers after resetKey remount until the replacement WebView reports selection', async () => {
        postMessageSpy.mockClear();
        lastWebViewProps = null;

        const ref = React.createRef<any>();
        const onChange = vi.fn();
        const screen = await renderScreen(React.createElement(TiptapWebViewSurface, {
            ref,
            resetKey: '1',
            value: 'hello',
            onChange,
        }));

        emitEnvelope({ v: 1, type: 'ready', payload: { ok: true } });

        const staleSelectionState = {
            marks: { bold: true, italic: false, strike: false, code: false },
            blockType: 'heading2',
            isLinkActive: false,
            canUndo: true,
            canRedo: false,
        };
        emitEnvelope({ v: 1, type: 'selectionState', payload: staleSelectionState });

        await act(async () => {
            await screen.update(
                React.createElement(TiptapWebViewSurface, {
                    ref,
                    resetKey: '2',
                    value: 'hello',
                    onChange,
                }),
            );
        });

        const replacementSelectionUpdates: any[] = [];
        const unsubscribeReplacement = ref.current.subscribeSelection((state: any) => {
            replacementSelectionUpdates.push(state);
        });

        expect(replacementSelectionUpdates).toEqual([]);

        emitEnvelope({ v: 1, type: 'ready', payload: { ok: true } });

        const replacementSelectionState = {
            marks: { bold: false, italic: true, strike: false, code: false },
            blockType: 'paragraph',
            isLinkActive: false,
            canUndo: false,
            canRedo: true,
        };
        emitEnvelope({ v: 1, type: 'selectionState', payload: replacementSelectionState });

        expect(replacementSelectionUpdates).toEqual([replacementSelectionState]);

        unsubscribeReplacement();
    });

    it('notifies mounted selection subscribers with neutral state on resetKey remount', async () => {
        postMessageSpy.mockClear();
        lastWebViewProps = null;

        const ref = React.createRef<any>();
        const onChange = vi.fn();
        const screen = await renderScreen(React.createElement(TiptapWebViewSurface, {
            ref,
            resetKey: '1',
            value: 'hello',
            onChange,
        }));

        emitEnvelope({ v: 1, type: 'ready', payload: { ok: true } });

        const selectionUpdates: any[] = [];
        const unsubscribe = ref.current.subscribeSelection((state: any) => {
            selectionUpdates.push(state);
        });

        const staleSelectionState = {
            marks: { bold: true, italic: false, strike: false, code: false },
            blockType: 'heading2',
            isLinkActive: true,
            canUndo: true,
            canRedo: false,
        };
        emitEnvelope({ v: 1, type: 'selectionState', payload: staleSelectionState });

        await act(async () => {
            await screen.update(
                React.createElement(TiptapWebViewSurface, {
                    ref,
                    resetKey: '2',
                    value: 'hello',
                    onChange,
                }),
            );
        });

        const neutralSelectionState = {
            marks: { bold: false, italic: false, strike: false, code: false },
            blockType: 'paragraph',
            isLinkActive: false,
            canUndo: false,
            canRedo: false,
        };
        expect(selectionUpdates).toEqual([staleSelectionState, neutralSelectionState]);

        const replacementSelectionState = {
            marks: { bold: false, italic: true, strike: false, code: false },
            blockType: 'paragraph',
            isLinkActive: false,
            canUndo: false,
            canRedo: true,
        };
        emitEnvelope({ v: 1, type: 'selectionState', payload: replacementSelectionState });

        expect(selectionUpdates).toEqual([
            staleSelectionState,
            neutralSelectionState,
            replacementSelectionState,
        ]);

        unsubscribe();
    });

    it('rebuilds the WebView HTML when the theme changes', async () => {
        postMessageSpy.mockClear();
        lastWebViewProps = null;

        const screen = await renderScreen(React.createElement(TiptapWebViewSurface, {
            resetKey: '1',
            value: 'hello',
            onChange: vi.fn(),
        }));

        const firstHtml = lastWebViewProps?.source?.html;
        expect(firstHtml).toContain('#abcdef');

        unistylesState.themeOverride = {
            dark: true,
            colors: {
                text: { primary: '#00ffaa' },
            },
        };

        await act(async () => {
            await screen.update(
                React.createElement(TiptapWebViewSurface, {
                    resetKey: '1',
                    value: 'hello',
                    onChange: vi.fn(),
                }),
            );
        });

        expect(lastWebViewProps?.source?.html).toContain('#00ffaa');
        expect(lastWebViewProps?.source?.html).not.toBe(firstHtml);
    });

    it('rejects an unconfirmed flush after reset and confirms a retry once the replacement WebView is ready', async () => {
        postMessageSpy.mockClear();
        lastWebViewProps = null;

        const ref = React.createRef<MarkdownEditorSurfaceRef>();
        const screen = await renderScreen(React.createElement(TiptapWebViewSurface, {
            ref,
            resetKey: '1',
            value: 'seed markdown',
            onChange: vi.fn(),
        }));

        emitEnvelope({ v: 1, type: 'ready', payload: { ok: true } });
        const callCountBeforeReset = postMessageSpy.mock.calls.length;

        await act(async () => {
            await screen.update(
                React.createElement(TiptapWebViewSurface, {
                    ref,
                    resetKey: '2',
                    value: 'replacement markdown',
                    onChange: vi.fn(),
                }),
            );
        });

        await expect(ref.current!.flushPendingChange()).rejects.toThrow();

        expect(findPostedEnvelope('setDoc', callCountBeforeReset)).toBeNull();
        expect(findPostedEnvelope('requestDoc', callCountBeforeReset)).toBeNull();
        expect(findPostedEnvelope('init', callCountBeforeReset)).toBeNull();

        emitEnvelope({ v: 1, type: 'ready', payload: { ok: true } });

        expect(findPostedEnvelope('init', callCountBeforeReset)).toEqual(expect.objectContaining({
            type: 'init',
            payload: expect.objectContaining({ doc: 'replacement markdown' }),
        }));
        const retryStart = postMessageSpy.mock.calls.length;
        const confirmed = ref.current!.flushPendingChange();
        const requestId = readRequestDocRequestId(retryStart);
        emitEnvelope({ v: 1, type: 'docSnapshot', payload: { requestId, doc: 'replacement markdown' } });
        await confirmed;
        expect(ref.current!.getValue()).toBe('replacement markdown');
    });

    it('fails closed to raw via onUnavailable carrying the latest markdown on an error envelope', async () => {
        postMessageSpy.mockClear();
        lastWebViewProps = null;

        const onUnavailable = vi.fn();
        const ref = React.createRef<any>();

        await renderScreen(React.createElement(TiptapWebViewSurface, {
            ref,
            resetKey: '1',
            value: 'original markdown',
            onChange: vi.fn(),
            onUnavailable,
            changeDebounceMs: 10,
        }));

        emitEnvelope({ v: 1, type: 'ready', payload: { ok: true } });
        // The user edits before the bundle fails.
        emitEnvelope({ v: 1, type: 'docChanged', payload: { doc: 'edited markdown' } });
        expect(ref.current.getValue()).toBe('edited markdown');

        // The WebView bundle reports an error (e.g. missing/invalid bundle).
        emitEnvelope({ v: 1, type: 'error', payload: { message: 'TipTap bundle missing' } });

        // onUnavailable fires synchronously with the FRESHEST markdown so the
        // parent can seed raw without losing the edit (R-A17/D9).
        expect(onUnavailable).toHaveBeenCalledWith('edited markdown');
    });

    it('falls back via onUnavailable with the seed when an error arrives before any edit', async () => {
        postMessageSpy.mockClear();
        lastWebViewProps = null;

        const onUnavailable = vi.fn();

        await renderScreen(React.createElement(TiptapWebViewSurface, {
            resetKey: '1',
            value: 'pristine',
            onChange: vi.fn(),
            onUnavailable,
        }));

        emitEnvelope({ v: 1, type: 'error', payload: { message: 'boot failed' } });

        expect(onUnavailable).toHaveBeenCalledWith('pristine');
    });

    it('opens native tel links that TipTap already considers valid', async () => {
        postMessageSpy.mockClear();
        lastWebViewProps = null;

        await renderScreen(React.createElement(TiptapWebViewSurface, {
            resetKey: '1',
            value: 'Call me',
            onChange: vi.fn(),
        }));

        emitEnvelope({ v: 1, type: 'openLink', payload: { href: 'tel:+123456789' } });

        expect(openURLSpy).toHaveBeenCalledWith('tel:+123456789');
    });
});
