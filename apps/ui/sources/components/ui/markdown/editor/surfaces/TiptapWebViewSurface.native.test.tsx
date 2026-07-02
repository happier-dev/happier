import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { TiptapWebViewSurface } from './TiptapWebViewSurface.native';
import { renderScreen } from '@/dev/testkit';

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

        await renderScreen(React.createElement(TiptapWebViewSurface, {
            resetKey: '1',
            value: 'hello world',
            onChange: vi.fn(),
            changeDebounceMs: 10,
        }));

        // No init posted before ready.
        expect(findPostedEnvelope('init')).toBeNull();

        emitEnvelope({ v: 1, type: 'ready', payload: { ok: true } });

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
        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(TiptapWebViewSurface, {
            ref,
            resetKey: '1',
            value: 'hello',
            onChange,
        }))).tree;

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
            tree!.update(
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
        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(TiptapWebViewSurface, {
            ref,
            resetKey: '1',
            value: 'hello',
            onChange,
        }))).tree;

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
            tree!.update(
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

        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(TiptapWebViewSurface, {
            resetKey: '1',
            value: 'hello',
            onChange: vi.fn(),
        }))).tree;

        const firstHtml = lastWebViewProps?.source?.html;
        expect(firstHtml).toContain('#abcdef');

        unistylesState.themeOverride = {
            dark: true,
            colors: {
                text: { primary: '#00ffaa' },
            },
        };

        await act(async () => {
            tree!.update(
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

    it('resets bridge readiness on resetKey remount so sync requests wait for the replacement WebView', async () => {
        postMessageSpy.mockClear();
        lastWebViewProps = null;

        const ref = React.createRef<any>();
        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(TiptapWebViewSurface, {
            ref,
            resetKey: '1',
            value: 'seed markdown',
            onChange: vi.fn(),
        }))).tree;

        emitEnvelope({ v: 1, type: 'ready', payload: { ok: true } });
        const callCountBeforeReset = postMessageSpy.mock.calls.length;

        await act(async () => {
            tree!.update(
                React.createElement(TiptapWebViewSurface, {
                    ref,
                    resetKey: '2',
                    value: 'replacement markdown',
                    onChange: vi.fn(),
                }),
            );
        });

        await ref.current.flushPendingChange();

        expect(findPostedEnvelope('setDoc', callCountBeforeReset)).toBeNull();
        expect(findPostedEnvelope('requestDoc', callCountBeforeReset)).toBeNull();
        expect(findPostedEnvelope('init', callCountBeforeReset)).toBeNull();

        emitEnvelope({ v: 1, type: 'ready', payload: { ok: true } });

        expect(findPostedEnvelope('init', callCountBeforeReset)).toEqual(expect.objectContaining({
            type: 'init',
            payload: expect.objectContaining({ doc: 'replacement markdown' }),
        }));
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
