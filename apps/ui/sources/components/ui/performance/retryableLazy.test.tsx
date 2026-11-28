import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { retryableLazy } from './retryableLazy';

class RetryBoundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
    state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    retry = () => this.setState({ failed: false });
    render() { return this.state.failed ? <span data-testid="failed" /> : this.props.children; }
}

afterEach(standardCleanup);

describe('retryable lazy demand', () => {
    it('leaves repeated chunk failures with the existing boundary until each explicit retry', async () => {
        const load = vi.fn(async (): Promise<{ default: React.ComponentType }> => { throw new Error('chunk unavailable'); });
        const LazyContent = retryableLazy(load);
        const boundary = React.createRef<RetryBoundary>();
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            const screen = await renderScreen(<RetryBoundary ref={boundary}>
                <React.Suspense fallback={null}><LazyContent /></React.Suspense>
            </RetryBoundary>);
            expect(screen.findHostByTestId('failed')).not.toBeNull();
            expect(load).toHaveBeenCalledTimes(1);
            await act(async () => { boundary.current!.retry(); });
            expect(screen.findHostByTestId('failed')).not.toBeNull();
            expect(load).toHaveBeenCalledTimes(2);
            await screen.unmount();
        } finally { consoleError.mockRestore(); }
    });

    it('shares a fulfilled chunk across hosts and forwards each imperative ref', async () => {
        type Handle = { setDraft: (draft: string) => void };
        const Content = React.forwardRef<Handle, { id: string }>((props, ref) => {
            const [draft, setDraft] = React.useState('');
            React.useImperativeHandle(ref, () => ({ setDraft }), []);
            return <input data-testid={props.id} value={draft} />;
        });
        const load = vi.fn(async () => ({ default: Content }));
        const LazyContent = retryableLazy(load);
        const first = React.createRef<Handle>();
        const second = React.createRef<Handle>();
        const screen = await renderScreen(<React.Suspense fallback={null}>
            <LazyContent id="first" ref={first} /><LazyContent id="second" ref={second} />
        </React.Suspense>);
        await act(async () => { first.current!.setDraft('first draft'); second.current!.setDraft('second draft'); });
        expect(screen.findHostByTestId('first')!.props.value).toBe('first draft');
        expect(screen.findHostByTestId('second')!.props.value).toBe('second draft');
        expect(load).toHaveBeenCalledTimes(1);
        await screen.unmount();
    });

    it('recovers a rejected chunk on boundary retry and retains loaded state across ordinary updates', async () => {
        // The loader is the external chunk transport boundary; React reconciliation stays real.
        let rejectChunk!: (error: Error) => void;
        let resolveChunk!: (module: { default: typeof Content }) => void;
        const chunk = new Promise<{ default: typeof Content }>((_resolve, reject) => { rejectChunk = reject; });
        const recovered = new Promise<{ default: typeof Content }>(resolve => { resolveChunk = resolve; });
        const load = vi.fn().mockReturnValueOnce(chunk).mockReturnValue(recovered);
        function Content(props: { label: string }) {
            const [draft, setDraft] = React.useState('');
            return <input data-testid="draft" aria-label={props.label} value={draft}
                onChange={(event: { target: { value: string } }) => setDraft(event.target.value)} />;
        }
        const LazyContent = retryableLazy<{ label: string }>(load);
        const boundary = React.createRef<RetryBoundary>();
        const view = (label: string) => <RetryBoundary ref={boundary}>
            <React.Suspense fallback={<span data-testid="loading" />}><LazyContent label={label} /></React.Suspense>
        </RetryBoundary>;
        const screen = await renderScreen(view('first'));
        expect(screen.findHostByTestId('loading')).not.toBeNull();
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            await act(async () => { rejectChunk(new Error('chunk unavailable')); });
            expect(screen.findHostByTestId('failed')).not.toBeNull();
            await act(async () => { boundary.current!.retry(); });
            expect(screen.findHostByTestId('loading')).not.toBeNull();
            await act(async () => { resolveChunk({ default: Content }); });
            expect(screen.findHostByTestId('draft')).not.toBeNull();
            await act(async () => {
                screen.findHostByTestId('draft')!.props.onChange({ target: { value: 'retained draft' } });
            });
            await screen.update(view('updated'));
            expect(screen.findHostByTestId('draft')!.props.value).toBe('retained draft');
            expect(screen.findHostByTestId('draft')!.props['aria-label']).toBe('updated');
            expect(load).toHaveBeenCalledTimes(2);
        } finally {
            consoleError.mockRestore();
            await screen.unmount();
        }
    });

    it('starts the chunk on preload and lets the first render consume that same load', async () => {
        // A route preloads while it issues its first read; the later mount must not load again.
        let resolveChunk!: (module: { default: React.ComponentType }) => void;
        const load = vi.fn(() => new Promise<{ default: React.ComponentType }>(resolve => { resolveChunk = resolve; }));
        const LazyContent = retryableLazy(load);
        LazyContent.preload();
        expect(load).toHaveBeenCalledTimes(1);
        const screen = await renderScreen(<React.Suspense fallback={<span data-testid="loading" />}><LazyContent /></React.Suspense>);
        expect(load).toHaveBeenCalledTimes(1);
        await act(async () => { resolveChunk({ default: () => <span data-testid="content" /> }); });
        expect(screen.findHostByTestId('content')).not.toBeNull();
        expect(load).toHaveBeenCalledTimes(1);
        await screen.unmount();
    });

    it('lets the first render load again after a rejected preload, without surfacing the preload failure', async () => {
        const load = vi.fn()
            .mockImplementationOnce(() => Promise.reject(new Error('chunk unavailable')))
            .mockImplementation(() => Promise.resolve({ default: () => <span data-testid="content" /> }));
        const LazyContent = retryableLazy(load);
        LazyContent.preload();
        await act(async () => { await Promise.resolve(); });
        const screen = await renderScreen(<React.Suspense fallback={null}><LazyContent /></React.Suspense>);
        expect(screen.findHostByTestId('content')).not.toBeNull();
        expect(load).toHaveBeenCalledTimes(2);
        await screen.unmount();
    });
});
