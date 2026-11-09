// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen as renderTestScreen } from '@/dev/testkit';
import type { TextEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import type { MarkdownEditModeState } from './useMarkdownEditMode';
import { storage } from '@/sync/domains/state/storageStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

// Project the real web eligibility owner, delaying only its third-party SDK.
vi.mock('@/components/ui/markdown/editor/core/eligibility/richEligibility', async () => import('./core/eligibility/richEligibility.web'));
const tiptap = vi.hoisted(() => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    return { gate, release };
});
vi.mock('@tiptap/core', async (importOriginal) => {
    await tiptap.gate;
    return importOriginal();
});
// Keep the raw/rich composition and native bridge real beneath the WebView boundary.
vi.mock('@/components/ui/code/editor/CodeEditor', async () => import('@/components/ui/code/editor/CodeEditor.native'));
const webViewBoundary = vi.hoisted(() => ({ doc: '', onMessage: null as null | ((event: { nativeEvent: { data: string } }) => void) }));
vi.mock('react-native-webview', async () => {
    const React = await import('react');
    return { WebView: React.forwardRef((props: { onMessage: typeof webViewBoundary.onMessage }, ref) => {
        webViewBoundary.onMessage = props.onMessage;
        React.useImperativeHandle(ref, () => ({
            postMessage(raw: string) {
                const message = JSON.parse(raw) as { type: string; payload?: { doc?: string; requestId?: string } };
                if ((message.type === 'init' || message.type === 'setDoc') && typeof message.payload?.doc === 'string') webViewBoundary.doc = message.payload.doc;
                if (message.type === 'requestDoc') webViewBoundary.onMessage?.({ nativeEvent: { data: JSON.stringify({
                    v: 1, type: 'docSnapshot', payload: { requestId: message.payload?.requestId, doc: webViewBoundary.doc },
                }) } });
            },
            requestFocus() {},
        }));
        return React.createElement('WebView');
    }) };
});

// Feature flag + settings are the gate inputs; expose mutable state so each test
// can flip them before mounting.
const settingsState = vi.hoisted(() => ({
    markdownRichEditor: true,
    markdownDefaultEditMode: 'rich' as 'raw' | 'rich',
    maxBytes: 1_000_000,
    htmlRoundTripMaxBytes: 200_000,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (id: string) =>
        id === 'files.markdownRichEditor' ? settingsState.markdownRichEditor : false,
}));

import { useMarkdownEditMode } from './useMarkdownEditMode';
import { Modal } from '@/modal';

type ProbeArgs = Readonly<{
    value: string;
    language: string | null;
    editorHandleRef: React.MutableRefObject<TextEditorHandle | null>;
    onValueChange: (next: string) => void;
    baseResetKey?: string;
    liveValue?: { get(): string; subscribe(listener: () => void): () => void };
    active?: boolean;
}>;

const captured = { state: null as MarkdownEditModeState | null };

function Probe(args: ProbeArgs) {
    captured.state = useMarkdownEditMode({
        value: args.value,
        language: args.language,
        baseResetKey: args.baseResetKey ?? 'base',
        editorHandleRef: args.editorHandleRef,
        onValueChange: args.onValueChange,
        liveValue: args.liveValue,
        active: args.active,
    });
    return null;
}

async function renderScreen(element: React.ReactElement) {
    storage.setState((state) => ({ settings: {
        ...state.settings,
        markdownDefaultEditMode: settingsState.markdownDefaultEditMode,
        filesMarkdownRichEditorMaxBytes: settingsState.maxBytes,
        filesMarkdownRichEditorHtmlRoundTripMaxBytes: settingsState.htmlRoundTripMaxBytes,
    } }));
    return renderTestScreen(element);
}

function makeRef(handle: TextEditorHandle | null = null): React.MutableRefObject<TextEditorHandle | null> {
    return { current: handle };
}

beforeEach(() => {
    settingsState.markdownRichEditor = true;
    settingsState.markdownDefaultEditMode = 'rich';
    settingsState.maxBytes = 1_000_000;
    settingsState.htmlRoundTripMaxBytes = 200_000;
    captured.state = null;
});

describe('useMarkdownEditMode', () => {
    it('keeps raw until an explicit rich request after an initially unsupported draft becomes eligible', async () => {
        let text = 'A note[^1]\n\n[^1]: unsupported\n';
        const listeners = new Set<() => void>();
        const liveValue = { get: () => text, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
        const ref = makeRef({ getValue: () => text, flushPendingChange: async () => {} });
        await renderScreen(<Probe value={text} language="markdown" editorHandleRef={ref} liveValue={liveValue} onValueChange={vi.fn()} />);
        expect(captured.state?.markdownEditMode).toBe('raw');
        text = '# Edited clean draft';
        await act(async () => { listeners.forEach((listener) => listener()); });
        expect(captured.state?.richEligible).toBe(true);
        expect(captured.state?.showRich).toBe(false);
        await act(async () => { await captured.state?.onToggle('rich'); });
        expect(captured.state?.showRich).toBe(true);
        expect(captured.state?.seedText).toBe(text);
    });

    it('preserves the admitted rich buffer when its live eligibility changes', async () => {
        let text = '# Clean';
        const listeners = new Set<() => void>();
        const liveValue = { get: () => text, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
        await renderScreen(<Probe value={text} language="markdown" editorHandleRef={makeRef()} liveValue={liveValue} onValueChange={vi.fn()} />);
        expect(captured.state?.showRich).toBe(true);
        text = 'A note[^1]\n\n[^1]: unsupported\n';
        await act(async () => { listeners.forEach((listener) => listener()); });
        expect(captured.state?.richEligible).toBe(false);
        expect(captured.state?.showRich).toBe(true);
    });

    it('regates a host reseed instead of admitting unsupported content into the previous rich surface', async () => {
        const ref = makeRef();
        const element = (value: string, baseResetKey: string) => <Probe value={value} baseResetKey={baseResetKey} language="markdown" editorHandleRef={ref} onValueChange={vi.fn()} />;
        const screen = await renderScreen(element('# Clean', 'one'));
        expect(captured.state?.showRich).toBe(true);
        const unsupported = 'A note[^1]\n\n[^1]: external version\n';
        await screen.update(element(unsupported, 'two'));
        expect(captured.state?.showRich).toBe(false);
        expect(captured.state?.seedText).toBe(unsupported);
    });

    it('flushes before reading and seeds the next surface even when the host value stays in a ref', async () => {
        let latest = '# Before flush';
        const onValueChange = vi.fn();
        const ref = makeRef({ getValue: () => latest, flushPendingChange: async () => { latest = '# Flushed'; } });
        await renderScreen(<Probe value="# Seed" language="markdown" editorHandleRef={ref} onValueChange={onValueChange} />);
        await act(async () => { await captured.state?.onToggle('raw'); });
        expect(captured.state?.seedText).toBe('# Flushed');
        expect(onValueChange).toHaveBeenLastCalledWith('# Flushed');
    });

    it('keeps the current rich surface and draft when the outgoing snapshot is unconfirmed', async () => {
        const alert = vi.spyOn(Modal, 'alert').mockResolvedValue(undefined);
        const onValueChange = vi.fn();
        const ref = makeRef({ getValue: () => '# Pending draft',
            flushPendingChange: async () => { throw new Error('snapshot_unavailable'); } });
        await renderScreen(<Probe value="# Seed" language="markdown" editorHandleRef={ref} onValueChange={onValueChange} />);
        const resetKey = captured.state?.resetKey;
        await act(async () => { await expect(captured.state?.onToggle('raw')).resolves.toBeUndefined(); });
        expect(captured.state?.showRich).toBe(true);
        expect(captured.state?.resetKey).toBe(resetKey);
        expect(onValueChange).not.toHaveBeenCalled();
        expect(alert).toHaveBeenCalled();
        alert.mockRestore();
    });

    it('ignores a double toggle during flush and lets a host reseed win over the old flush', async () => {
        let finish!: () => void;
        const flush = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
        const ref = makeRef({ getValue: () => '# Old draft', flushPendingChange: flush });
        const onValueChange = vi.fn();
        const element = (value: string, baseResetKey: string) => <Probe value={value} baseResetKey={baseResetKey} language="markdown" editorHandleRef={ref} onValueChange={onValueChange} />;
        const screen = await renderScreen(element('# Original', 'one'));
        let pending: Promise<void> | undefined;
        await act(async () => { pending = captured.state?.onToggle('raw'); });
        await act(async () => { await captured.state?.onToggle('raw'); });
        expect(flush).toHaveBeenCalledTimes(1);
        await screen.update(element('# Disk reseed', 'two'));
        await act(async () => { finish(); await pending; });
        expect(captured.state?.seedText).toBe('# Disk reseed');
        expect(onValueChange).not.toHaveBeenCalled();
    });

    it('seeds fallback synchronously and accepts a later host reseed', async () => {
        const ref = makeRef();
        const element = (value: string, baseResetKey: string) => <Probe value={value} baseResetKey={baseResetKey} language="markdown" editorHandleRef={ref} onValueChange={vi.fn()} />;
        const screen = await renderScreen(element('# Original', 'one'));
        await act(async () => { captured.state?.onUnavailable('# WebView latest'); });
        expect(captured.state?.seedText).toBe('# WebView latest');
        expect(captured.state?.markdownEditMode).toBe('raw');
        await screen.update(element('# Disk reseed', 'two'));
        expect(captured.state?.seedText).toBe('# Disk reseed');
    });

    it('keeps controlled hosts current after a switch without requiring a new reset key', async () => {
        const ref = makeRef({ getValue: () => '# Flushed', flushPendingChange: async () => {} });
        const element = (value: string) => <Probe value={value} language="markdown" editorHandleRef={ref} onValueChange={vi.fn()} />;
        const screen = await renderScreen(element('# Seed'));
        await act(async () => { await captured.state?.onToggle('raw'); });
        expect(captured.state?.seedText).toBe('# Flushed');
        await screen.update(element('# Continued typing'));
        expect(captured.state?.seedText).toBe('# Continued typing');
    });

    it('updates eligibility only on live-store publication without frame polling', async () => {
        settingsState.markdownDefaultEditMode = 'raw';
        let latest = '# Clean';
        const listeners = new Set<() => void>();
        const liveValue = { get: () => latest, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
        const frame = vi.fn();
        vi.stubGlobal('requestAnimationFrame', frame);
        try {
            await renderScreen(<Probe value="# Seed" language="markdown" editorHandleRef={makeRef()} liveValue={liveValue} onValueChange={vi.fn()} />);
            expect(captured.state?.richEligible).toBe(true);
            latest = 'A note[^1]\n\n[^1]: unsupported\n';
            expect(captured.state?.richEligible).toBe(true);
            await act(async () => { listeners.forEach((listener) => listener()); });
            expect(captured.state?.richEligible).toBe(false);
            expect(captured.state?.richDisabledReason).toBe('footnotes');
            expect(frame).not.toHaveBeenCalled();
        } finally { vi.unstubAllGlobals(); }
    });

    it('uses the live store when no surface handle exists and regates the incoming rich surface', async () => {
        settingsState.markdownDefaultEditMode = 'raw';
        const latest = 'A note[^1]\n\n[^1]: unsupported\n';
        const onValueChange = vi.fn();
        await renderScreen(<Probe value="# Seed" language="markdown" editorHandleRef={makeRef()} onValueChange={onValueChange}
            liveValue={{ get: () => latest, subscribe: () => () => {} }} />);
        await act(async () => { await captured.state?.onToggle('rich'); });
        expect(captured.state?.seedText).toBe(latest);
        expect(captured.state?.richEligible).toBe(false);
        expect(onValueChange).toHaveBeenCalledWith(latest);
    });

    it('unsubscribes a retained inactive editor and resumes current eligibility without resetting its draft', async () => {
        settingsState.markdownDefaultEditMode = 'raw';
        let latest = '# Clean';
        const listeners = new Set<() => void>();
        const liveValue = { get: () => latest, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
        const ref = makeRef();
        const element = (active: boolean) => <Probe value="# Seed" language="markdown" editorHandleRef={ref} liveValue={liveValue} active={active} onValueChange={vi.fn()} />;
        const screen = await renderScreen(element(true));
        const resetKey = captured.state?.resetKey;
        await screen.update(element(false));
        expect(listeners.size).toBe(0);
        latest = 'A note[^1]\n\n[^1]: unsupported\n';
        await screen.update(element(true));
        expect(captured.state?.richDisabledReason).toBe('footnotes');
        expect(captured.state?.resetKey).toBe(resetKey);
        expect(captured.state?.markdownEditMode).toBe('raw');
    });

    it('defaults the mode from the markdownDefaultEditMode setting (rich)', async () => {
        settingsState.markdownDefaultEditMode = 'rich';
        await renderScreen(<Probe value="# Doc" language="markdown" editorHandleRef={makeRef()} onValueChange={vi.fn()} />);
        expect(captured.state?.markdownEditMode).toBe('rich');
    });

    it('defaults the mode to raw when the setting is raw', async () => {
        settingsState.markdownDefaultEditMode = 'raw';
        await renderScreen(<Probe value="# Doc" language="markdown" editorHandleRef={makeRef()} onValueChange={vi.fn()} />);
        expect(captured.state?.markdownEditMode).toBe('raw');
    });

    it('hides the toggle and reports ineligible when the feature flag is off', async () => {
        settingsState.markdownRichEditor = false;
        await renderScreen(<Probe value="# Doc" language="markdown" editorHandleRef={makeRef()} onValueChange={vi.fn()} />);
        expect(captured.state?.showToggle).toBe(false);
        expect(captured.state?.richEligible).toBe(false);
    });

    it('shows the toggle and reports eligible for clean markdown', async () => {
        await renderScreen(<Probe value="# Heading\n\nbody" language="markdown" editorHandleRef={makeRef()} onValueChange={vi.fn()} />);
        expect(captured.state?.showToggle).toBe(true);
        expect(captured.state?.richEligible).toBe(true);
    });

    it('hides the toggle for non-markdown languages', async () => {
        await renderScreen(<Probe value="const x = 1" language="typescript" editorHandleRef={makeRef()} onValueChange={vi.fn()} />);
        expect(captured.state?.showToggle).toBe(false);
    });

    it('reports ineligible with the mdx reason for .mdx (non-markdown language) (R-A1)', async () => {
        await renderScreen(<Probe value="# Doc" language="mdx" editorHandleRef={makeRef()} onValueChange={vi.fn()} />);
        expect(captured.state?.richEligible).toBe(false);
        expect(captured.state?.richDisabledReason).toBe('mdx');
    });

    it('reports the ineligibility reason for content with footnotes', async () => {
        const withFootnote = 'Text with a note[^1]\n\n[^1]: the footnote\n';
        await renderScreen(<Probe value={withFootnote} language="markdown" editorHandleRef={makeRef()} onValueChange={vi.fn()} />);
        expect(captured.state?.richEligible).toBe(false);
        expect(captured.state?.richDisabledReason).toBe('footnotes');
    });

    it('composes the reset key from base, mode, and nonce', async () => {
        await renderScreen(<Probe value="# Doc" language="markdown" editorHandleRef={makeRef()} onValueChange={vi.fn()} />);
        expect(captured.state?.resetKey).toBe('base:rich:0');
    });

    it('flushes the outgoing surface and bumps the reset nonce on toggle (R-A6)', async () => {
        const flushPendingChange = vi.fn(async () => undefined);
        const ref = makeRef({ flushPendingChange, getValue: () => '# Doc' });
        await renderScreen(<Probe value="# Doc" language="markdown" editorHandleRef={ref} onValueChange={vi.fn()} />);

        expect(captured.state?.markdownEditMode).toBe('rich');
        await act(async () => {
            await captured.state?.onToggle('raw');
        });

        expect(flushPendingChange).toHaveBeenCalledTimes(1);
        expect(captured.state?.markdownEditMode).toBe('raw');
        expect(captured.state?.resetKey).toBe('base:raw:1');
    });

    it('does nothing when toggling to the already-active mode', async () => {
        const flushPendingChange = vi.fn(async () => undefined);
        const ref = makeRef({ flushPendingChange, getValue: () => '# Doc' });
        await renderScreen(<Probe value="# Doc" language="markdown" editorHandleRef={ref} onValueChange={vi.fn()} />);

        await act(async () => {
            await captured.state?.onToggle('rich');
        });
        expect(flushPendingChange).not.toHaveBeenCalled();
        expect(captured.state?.resetKey).toBe('base:rich:0');
    });

    it('forwards the latest markdown and drops to raw on onUnavailable (R-A17)', async () => {
        const onValueChange = vi.fn();
        await renderScreen(<Probe value="# Doc" language="markdown" editorHandleRef={makeRef()} onValueChange={onValueChange} />);

        await act(async () => {
            captured.state?.onUnavailable('# Latest body');
        });

        expect(onValueChange).toHaveBeenCalledWith('# Latest body');
        expect(captured.state?.markdownEditMode).toBe('raw');
    });

    it('blocks raw during initial HTML eligibility, then preserves an explicit raw edit when the worker becomes eligible', async () => {
        console.info('FX-EDITORSUITE stage import');
        const { MarkdownCodeEditorField } = await import('./MarkdownCodeEditorField');
        const { MarkdownEditModeMenu } = await import('../editorChrome/MarkdownEditModeMenu');
        const { CodeEditorWithFind } = await import('@/components/ui/code/editor/CodeEditorWithFind');
        const { RichMarkdownEditorPanel } = await import('./RichMarkdownEditorPanel');
        const { ActivitySpinner } = await import('@/components/ui/feedback/ActivitySpinner');
        let text = 'Before <span>kept</span> after';
        const listeners = new Set<() => void>();
        const liveValue = { get: () => text, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
        const onChange = (next: string) => { text = next; listeners.forEach((listener) => listener()); };
        const editorRef = makeRef();
        console.info('FX-EDITORSUITE stage mount');
        const screen = await renderScreen(<MarkdownCodeEditorField value={text} language="markdown" resetKey="pending-html"
            editorRef={editorRef} liveValue={liveValue} onChange={onChange} changeDebounceMs={0} />);
        try {
            console.info('FX-EDITORSUITE stage raw');
            expect(screen.findAllByType(ActivitySpinner)).toHaveLength(1);
            expect(screen.findAllByType(CodeEditorWithFind)).toHaveLength(0);
            expect(editorRef.current).toBeNull();
            await act(async () => { screen.findByType(MarkdownEditModeMenu).props.onChange('raw'); });
            console.info('FX-EDITORSUITE stage ready');
            const edited = 'Edited <span>kept</span> draft';
            await act(async () => {
                webViewBoundary.onMessage!({ nativeEvent: { data: JSON.stringify({ v: 1, type: 'ready', payload: { ok: true } }) } });
                webViewBoundary.doc = edited;
                webViewBoundary.onMessage!({ nativeEvent: { data: JSON.stringify({ v: 1, type: 'docChanged', payload: { doc: edited } }) } });
                await vi.waitFor(() => { expect(text).toBe(edited); });
            });
            expect(screen.findAllByType(CodeEditorWithFind)).toHaveLength(1);
            console.info('FX-EDITORSUITE stage release');
            tiptap.release();
            await act(async () => { await import('./markdownEditorEngine.web'); });
            const menu = screen.findByType(MarkdownEditModeMenu);
            expect(menu.props.richEligible).toBe(true);
            expect(menu.props.mode).toBe('raw');
            expect(screen.findAllByType(CodeEditorWithFind)).toHaveLength(1);
            expect(editorRef.current?.getValue()).toBe(edited);
            console.info('FX-EDITORSUITE stage rich');
            await act(async () => { menu.props.onChange('rich'); });
            console.info('FX-EDITORSUITE stage assertion');
            expect(screen.findByType(RichMarkdownEditorPanel).props.value).toBe(edited);
            expect(editorRef.current?.getValue()).toBe(edited);
        } finally { tiptap.release(); }
    });
});
