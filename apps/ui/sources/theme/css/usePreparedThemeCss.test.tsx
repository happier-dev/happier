import { afterEach, expect, it, vi } from 'vitest';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit';
import { usePreparedThemeCss } from './usePreparedThemeCss';

const parserBoundary = vi.hoisted(() => {
    let reject!: (error: unknown) => void;
    const pending = new Promise<never>((_resolve, rejectLoad) => { reject = rejectLoad; });
    return { pending, reject, loads: 0 };
});
// Loading a third-party parser chunk is the actual asynchronous system boundary.
vi.mock('css-tree/lib/parser', async importOriginal => {
    parserBoundary.loads++;
    await parserBoundary.pending;
    return importOriginal<typeof import('css-tree/lib/parser')>();
});
afterEach(standardCleanup);

it('defers hidden acquisition and keeps failures with the source that requested them', async () => {
    const first = '[data-surface=composer]{padding:17px}';
    const second = '[data-surface=composer]{padding:23px}';
    const hook = await renderHook(({ source, presented }) => usePreparedThemeCss(source, presented), {
        initialProps: { source: first, presented: false },
    });
    expect(parserBoundary.loads).toBe(0);
    expect(hook.getCurrent()).toMatchObject({ prepared: null, error: null });
    await hook.rerender({ source: first, presented: true });
    await vi.waitFor(() => expect(parserBoundary.loads).toBe(1));
    await hook.rerender({ source: second, presented: true });
    const unavailable = new Error('Parser chunk unavailable');
    await act(async () => { parserBoundary.reject(unavailable); });
    // Vitest wraps a rejected third-party module factory, retaining its cause.
    await vi.waitFor(() => expect(hook.getCurrent().error).toMatchObject({ cause: unavailable }));
    await hook.rerender({ source: '', presented: true });
    expect(hook.getCurrent().error).toBeNull();
    expect(hook.getCurrent().prepared?.source).toBe('');
    expect(hook.getCurrent().prepared?.coverage.total).toBe(0);
    await hook.unmount();
});
