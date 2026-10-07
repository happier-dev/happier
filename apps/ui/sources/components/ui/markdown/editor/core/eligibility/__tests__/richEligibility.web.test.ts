// @vitest-environment jsdom
import * as React from 'react';
import { expect, it, vi } from 'vitest';

const tiptap = vi.hoisted(() => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    return { loaded: false, gate, release };
});
// Observe the genuine editor-library boundary without replacing eligibility logic.
vi.mock('@tiptap/core', async (importOriginal) => {
    tiptap.loaded = true;
    await tiptap.gate;
    return importOriginal();
});

it('does not evaluate the rich editor engine when loading eligibility for file browsing', async () => {
    await import('../richEligibility.web');
    expect(tiptap.loaded).toBe(false);
});


it('keeps cheap gates synchronous and resolves lossless HTML through the deferred engine', async () => {
    const { act } = await import('react-test-renderer');
    const { renderScreen } = await import('@/dev/testkit');
    const { useRichEligibility } = await import('../richEligibility.web');
    const options = { language: 'markdown', maxBytes: 256_000, htmlRoundTripMaxBytes: 50_000 };
    let latest: { eligible: boolean; reason?: string } | undefined;
    function Probe({ value }: { value: string }) {
        latest = useRichEligibility(value, options);
        return React.createElement('result', { eligible: latest.eligible });
    }
    const screen = await renderScreen(React.createElement(React.Suspense, { fallback: null },
        React.createElement(Probe, { value: '# Clean' })));
    expect(latest).toEqual({ eligible: true });
    expect(tiptap.loaded).toBe(false);
    await act(async () => {
        screen.tree.update(React.createElement(React.Suspense, { fallback: null },
            React.createElement(Probe, { value: 'See note.[^1]\n\n[^1]: preserved' })));
    });
    expect(latest).toEqual({ eligible: false, reason: 'footnotes' });
    expect(tiptap.loaded).toBe(false);
    await act(async () => {
        screen.tree.update(React.createElement(React.Suspense, { fallback: null },
            React.createElement(Probe, { value: 'Before <span>kept</span> after' })));
    });
    expect(latest).toEqual({ eligible: false, reason: 'html-or-jsx', pending: true });
    tiptap.release();
    await act(async () => {
        await import('../../../markdownEditorEngine.web');
    });
    expect(tiptap.loaded).toBe(true);
    expect(latest).toEqual({ eligible: true });
});
