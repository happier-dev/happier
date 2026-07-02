import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { MarkdownEditorHandle } from '@/components/ui/markdown/editor/markdownEditorTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

// Feature flag + settings the hook reads internally (R-A19). Controlled per-test
// via the hoisted mutable state below.
const featureState = vi.hoisted(() => ({ markdownRichEditor: true }));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => {
        if (featureId === 'files.markdownRichEditor') return featureState.markdownRichEditor;
        return true;
    },
}));

const settingState = vi.hoisted(() => ({
    markdownDefaultEditMode: 'rich' as 'raw' | 'rich',
    filesMarkdownRichEditorMaxBytes: 256_000,
    filesMarkdownRichEditorHtmlRoundTripMaxBytes: 50_000,
}));
vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: keyof typeof settingState) => settingState[key],
}));

type Harness = {
    markdownEditMode: 'raw' | 'rich';
    richEligible: boolean;
    richDisabledReason?: string;
    seedText: string;
    resetKey: string;
    onToggle: (next: 'raw' | 'rich') => Promise<void> | void;
    onUnavailable: (latestDoc: string) => void;
};

function createHandle(initial: string) {
    const ref = { value: initial };
    const handle: MarkdownEditorHandle & { setValue: (v: string) => void } = {
        getValue: () => ref.value,
        flushPendingChange: vi.fn(async () => undefined),
        setValue: (v: string) => {
            ref.value = v;
        },
    };
    return handle;
}

type RunOptions = Readonly<{
    filePath?: string;
    editorSeedText?: string;
    editorResetKey?: number;
    handle?: MarkdownEditorHandle | null;
    onEditorChange?: (value: string) => void;
    getEditorText?: () => string;
}>;

async function mountHook(initial: RunOptions) {
    const { useMarkdownFileEditMode } = await import('./useMarkdownFileEditMode');

    let latest: Harness | null = null;
    let liveText = initial.editorSeedText ?? '# Title\n\nbody';
    const forwardedOnEditorChange = initial.onEditorChange ?? vi.fn();
    const props: Required<Omit<RunOptions, 'handle' | 'onEditorChange' | 'getEditorText'>> & {
        handle: MarkdownEditorHandle | null;
        onEditorChange: (value: string) => void;
        getEditorText: () => string;
    } = {
        filePath: initial.filePath ?? 'notes/readme.md',
        editorSeedText: liveText,
        editorResetKey: initial.editorResetKey ?? 0,
        handle: initial.handle ?? null,
        onEditorChange: (value: string) => {
            liveText = value;
            forwardedOnEditorChange(value);
        },
        getEditorText: initial.getEditorText ?? (() => liveText),
    };

    function Wrapper(p: typeof props) {
        const handleRef = React.useRef<MarkdownEditorHandle | null>(p.handle);
        handleRef.current = p.handle;
        latest = useMarkdownFileEditMode({
            filePath: p.filePath,
            editorSeedText: p.editorSeedText,
            editorResetKey: p.editorResetKey,
            editorHandleRef: handleRef,
            onEditorChange: p.onEditorChange,
            getEditorText: p.getEditorText,
        });
        return null;
    }

    const screen = await renderScreen(<Wrapper {...props} />);
    const get = () => {
        if (!latest) throw new Error('hook state not captured');
        return latest;
    };
    const rerender = async (next: Partial<typeof props>) => {
        Object.assign(props, next);
        await act(async () => {
            screen.tree.update(<Wrapper {...props} />);
        });
    };
    return { get, rerender, props };
}

beforeEach(() => {
    vi.useRealTimers();
    featureState.markdownRichEditor = true;
    settingState.markdownDefaultEditMode = 'rich';
    settingState.filesMarkdownRichEditorMaxBytes = 256_000;
    settingState.filesMarkdownRichEditorHtmlRoundTripMaxBytes = 50_000;
});

describe('useMarkdownFileEditMode', () => {
    it('defaults to rich and reports eligibility for a clean .md file', async () => {
        const { get } = await mountHook({ filePath: 'docs/clean.md', editorSeedText: '# Hello\n\nworld' });
        expect(get().markdownEditMode).toBe('rich');
        expect(get().richEligible).toBe(true);
        expect(get().richDisabledReason).toBeUndefined();
    });

    it('is not eligible when the feature flag is off', async () => {
        featureState.markdownRichEditor = false;
        const { get } = await mountHook({ filePath: 'docs/clean.md', editorSeedText: '# Hello' });
        expect(get().richEligible).toBe(false);
    });

    it('is not eligible for non-markdown / .mdx files and maps the reason (R-A1)', async () => {
        const { get } = await mountHook({ filePath: 'docs/page.mdx', editorSeedText: '# Hello' });
        expect(get().richEligible).toBe(false);
        expect(get().richDisabledReason).toBe('mdx');
    });

    it('maps the reference-links reason for files with reference-style links', async () => {
        const { get } = await mountHook({
            filePath: 'docs/refs.md',
            editorSeedText: 'See [the docs][1].\n\n[1]: https://example.com\n',
        });
        expect(get().richEligible).toBe(false);
        expect(get().richDisabledReason).toBe('reference-links');
    });

    it('composes the resetKey from editorResetKey, mode, and nonce', async () => {
        const { get } = await mountHook({ editorResetKey: 7 });
        expect(get().resetKey.startsWith('7:rich:')).toBe(true);
    });

    it('seeds from editorSeedText initially', async () => {
        const { get } = await mountHook({ editorSeedText: '# Seed' });
        expect(get().seedText).toBe('# Seed');
    });

    it('onToggle flushes the outgoing surface and reseeds the incoming with the latest value (R-A6)', async () => {
        const handle = createHandle('# Edited later\n\nunsaved');
        const onEditorChange = vi.fn();
        const { get } = await mountHook({
            editorSeedText: '# Original',
            handle,
            onEditorChange,
        });

        const seedBefore = get().seedText;
        const nonceKeyBefore = get().resetKey;

        await act(async () => {
            await get().onToggle('raw');
        });

        // The latest in-surface value must be preserved (no char loss).
        expect(handle.flushPendingChange).toHaveBeenCalledTimes(1);
        expect(onEditorChange).toHaveBeenCalledWith('# Edited later\n\nunsaved');
        expect(get().seedText).toBe('# Edited later\n\nunsaved');
        expect(get().markdownEditMode).toBe('raw');
        expect(get().seedText).not.toBe(seedBefore);
        expect(get().resetKey).not.toBe(nonceKeyBefore);
    });

    it('falls back to getEditorText when the handle is missing on toggle', async () => {
        const onEditorChange = vi.fn();
        const { get } = await mountHook({
            editorSeedText: '# Original',
            handle: null,
            getEditorText: () => '# From getter',
            onEditorChange,
        });

        await act(async () => {
            await get().onToggle('raw');
        });

        expect(onEditorChange).toHaveBeenCalledWith('# From getter');
        expect(get().seedText).toBe('# From getter');
    });

    it('blocks a re-entrant toggle while a flush is in flight (modeSwitching guard)', async () => {
        let resolveFlush: (() => void) | null = null;
        const handle: MarkdownEditorHandle = {
            getValue: () => '# Latest',
            flushPendingChange: vi.fn(
                () =>
                    new Promise<void>((resolve) => {
                        resolveFlush = resolve;
                    }),
            ),
        };
        const { get } = await mountHook({ editorSeedText: '# Original', handle });

        let firstToggle: Promise<void> | void;
        await act(async () => {
            firstToggle = get().onToggle('raw');
        });
        // Second tap while the first flush has not resolved must be ignored.
        await act(async () => {
            await get().onToggle('rich');
        });

        expect(handle.flushPendingChange).toHaveBeenCalledTimes(1);

        await act(async () => {
            resolveFlush?.();
            await firstToggle;
        });

        expect(get().markdownEditMode).toBe('raw');
    });

    it('onUnavailable seeds raw with the latest doc synchronously (R-A17)', async () => {
        const onEditorChange = vi.fn();
        const { get } = await mountHook({ editorSeedText: '# Original', onEditorChange });

        await act(async () => {
            get().onUnavailable('# Latest from webview');
        });

        expect(onEditorChange).toHaveBeenCalledWith('# Latest from webview');
        expect(get().seedText).toBe('# Latest from webview');
        expect(get().markdownEditMode).toBe('raw');
    });

    it('reseeds and bumps the nonce when editorResetKey changes (external refresh/cancel/save)', async () => {
        const { get, rerender } = await mountHook({ editorSeedText: '# Original', editorResetKey: 1 });
        const resetKeyBefore = get().resetKey;

        await rerender({ editorSeedText: '# Refreshed from disk', editorResetKey: 2 });

        expect(get().seedText).toBe('# Refreshed from disk');
        expect(get().resetKey).not.toBe(resetKeyBefore);
        expect(get().resetKey.startsWith('2:')).toBe(true);
    });

    // N1 — a raw edit that introduces a rich blocker (e.g. a footnote) must
    // re-gate eligibility on the FLUSHED latest text when the user tries to
    // switch to Rich, so the integration view keeps showing Raw with the reason
    // (rich requires both `markdownEditMode === 'rich'` AND `richEligible`).
    it('re-gates on the flushed text when toggling to rich after a blocker is introduced (N1)', async () => {
        // Start in raw so the user is editing raw text, then introduce a footnote.
        settingState.markdownDefaultEditMode = 'raw';
        const blockerText = 'See the note.[^1]\n\n[^1]: a footnote definition\n';
        const handle = createHandle(blockerText);
        const onEditorChange = vi.fn();
        const { get } = await mountHook({
            filePath: 'docs/notes.md',
            editorSeedText: '# Clean start',
            handle,
            onEditorChange,
        });

        expect(get().markdownEditMode).toBe('raw');

        await act(async () => {
            await get().onToggle('rich');
        });

        // Mode flips to rich, but eligibility was recomputed on the flushed text
        // (the footnote), so rich is refused and the reason is surfaced. The view
        // therefore renders the raw editor (useRichMarkdownEditor stays false).
        expect(get().markdownEditMode).toBe('rich');
        expect(get().seedText).toBe(blockerText);
        expect(get().richEligible).toBe(false);
        expect(get().richDisabledReason).toBe('footnotes');
    });

    // N4 — an external refresh/cancel/save reseed while in RAW mode must reseed
    // the raw surface from the host's authoritative seed and keep raw mode.
    it('reseeds raw mode from the host seed on an external refresh (N4)', async () => {
        settingState.markdownDefaultEditMode = 'raw';
        const { get, rerender } = await mountHook({ editorSeedText: '# Original', editorResetKey: 1 });
        expect(get().markdownEditMode).toBe('raw');
        const resetKeyBefore = get().resetKey;

        await rerender({ editorSeedText: '# Reloaded from disk', editorResetKey: 2 });

        expect(get().markdownEditMode).toBe('raw');
        expect(get().seedText).toBe('# Reloaded from disk');
        expect(get().resetKey).not.toBe(resetKeyBefore);
        expect(get().resetKey.startsWith('2:raw:')).toBe(true);
    });

    it('recomputes raw-mode rich eligibility from the live editor text during the edit session', async () => {
        vi.useFakeTimers();
        settingState.markdownDefaultEditMode = 'raw';

        let liveText = '# Clean start';
        const { get } = await mountHook({
            filePath: 'docs/notes.md',
            editorSeedText: liveText,
            getEditorText: () => liveText,
        });

        expect(get().markdownEditMode).toBe('raw');
        expect(get().richEligible).toBe(true);

        liveText = 'See the note.[^1]\n\n[^1]: a footnote definition\n';

        await act(async () => {
            await vi.advanceTimersByTimeAsync(100);
        });

        expect(get().richEligible).toBe(false);
        expect(get().richDisabledReason).toBe('footnotes');
    });
});
