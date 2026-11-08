/** @vitest-environment jsdom */
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MarkdownEditorSurfaceRef } from '../MarkdownEditor';
import { flushHookEffects } from '@/dev/testkit';

vi.mock('react-native', async () => import('react-native-web'));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

const { TiptapEditorSurface } = await import('./TiptapEditorSurface.web');
let root: Root | null = null;
afterEach(async () => {
    await React.act(async () => { root?.unmount(); });
    root = null;
    document.body.replaceChildren();
});
async function renderEditor(element: React.ReactElement) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await React.act(async () => { root!.render(element); });
}

describe('real rich Markdown editor', () => {
    it('keeps source bytes through a no-edit flush even when the serializer normalizes them', async () => {
        const value = '# Guide\n\n- one\n- two\n';
        const ref = React.createRef<MarkdownEditorSurfaceRef>();
        const onChange = vi.fn();
        await renderEditor(<TiptapEditorSurface ref={ref} resetKey="guide" value={value} onChange={onChange} />);
        await React.act(async () => { await ref.current?.flushPendingChange(); });
        expect(ref.current?.getValue()).toBe(value);
        expect(onChange).not.toHaveBeenCalled();
        await React.act(async () => { root!.render(<TiptapEditorSurface ref={ref} resetKey="guide" value={`${value}\n`} onChange={onChange} />); });
        expect(ref.current?.getValue()).toBe(`${value}\n`);
    });

    it('comes back with its document after a hidden Activity destroyed its editor', async () => {
        // Navigation can hide a mounted editor in an Activity: its effects disconnect, Tiptap destroys the
        // unmounted editor a tick later, and the reconnecting effects first see that destroyed instance.
        const value = 'Ship the beta on Thursday.';
        const ref = React.createRef<MarkdownEditorSurfaceRef>();
        // One element: the revealed surface gets no new props, as on a navigation reveal.
        const editor = <TiptapEditorSurface ref={ref} resetKey="doc" value={value} onChange={vi.fn()} />;
        const scene = (mode: 'visible' | 'hidden') => <React.Activity mode={mode}>{editor}</React.Activity>;
        await renderEditor(scene('visible'));
        const errors: unknown[] = [];
        const onError = (event: ErrorEvent) => { errors.push(event.error); event.preventDefault(); };
        window.addEventListener('error', onError);
        try {
            // Hiding disconnects the effects, which schedules Tiptap's destroy on a 1 ms timer (the clock boundary).
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            await React.act(async () => { root!.render(scene('hidden')); });
            // Tiptap destroys the editor while the hidden surface is unsubscribed from it.
            vi.advanceTimersByTime(1);
            vi.useRealTimers();
            await React.act(async () => { root!.render(scene('visible')); });
            await React.act(async () => { await flushHookEffects(); });
        } finally {
            vi.useRealTimers();
            window.removeEventListener('error', onError);
        }
        expect(errors).toEqual([]);
        expect(document.querySelector('.ProseMirror')?.textContent).toBe(value);
        expect(ref.current?.getValue()).toBe(value);
    });

    it('finds rich text across formatting and blocks without editing the document', async () => {
        const value = '# Retries\n\nRetry **now**. Retry now.\n';
        const ref = React.createRef<MarkdownEditorSurfaceRef>();
        const onChange = vi.fn();
        await renderEditor(<TiptapEditorSurface ref={ref} resetKey="find" value={value} onChange={onChange} />);
        const find = ref.current?.find;
        expect(find).toBeDefined();
        await React.act(async () => { find?.open(); find?.set('Retry now', { matchCase: false, regex: false }); });
        expect(find?.getSnapshot().status).toEqual({ kind: 'results', total: 2, current: 1, coverage: 'complete' });
        await React.act(async () => { find?.step(1); });
        expect(find?.getSnapshot().status).toMatchObject({ current: 2 });
        await React.act(async () => { find?.set('[', { matchCase: false, regex: true }); });
        expect(find?.getSnapshot().status).toEqual({ kind: 'invalidPattern' });
        await React.act(async () => { find?.close(); });
        expect(ref.current?.getValue()).toBe(value);
        expect(onChange).not.toHaveBeenCalled();
    });
});
