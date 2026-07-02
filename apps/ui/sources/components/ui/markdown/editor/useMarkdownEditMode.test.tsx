import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { CodeEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import type { MarkdownEditModeState } from './useMarkdownEditMode';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
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

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'markdownDefaultEditMode') return settingsState.markdownDefaultEditMode;
        if (key === 'filesMarkdownRichEditorMaxBytes') return settingsState.maxBytes;
        if (key === 'filesMarkdownRichEditorHtmlRoundTripMaxBytes') return settingsState.htmlRoundTripMaxBytes;
        return null;
    },
}));

import { useMarkdownEditMode } from './useMarkdownEditMode';

type ProbeArgs = Readonly<{
    value: string;
    language: string | null;
    editorHandleRef: React.MutableRefObject<CodeEditorHandle | null>;
    onValueChange: (next: string) => void;
}>;

const captured = { state: null as MarkdownEditModeState | null };

function Probe(args: ProbeArgs) {
    captured.state = useMarkdownEditMode({
        value: args.value,
        language: args.language,
        baseResetKey: 'base',
        editorHandleRef: args.editorHandleRef,
        onValueChange: args.onValueChange,
    });
    return null;
}

function makeRef(handle: Partial<CodeEditorHandle> | null = null): React.MutableRefObject<CodeEditorHandle | null> {
    return { current: handle as CodeEditorHandle | null };
}

beforeEach(() => {
    settingsState.markdownRichEditor = true;
    settingsState.markdownDefaultEditMode = 'rich';
    settingsState.maxBytes = 1_000_000;
    settingsState.htmlRoundTripMaxBytes = 200_000;
    captured.state = null;
});

describe('useMarkdownEditMode', () => {
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
});
