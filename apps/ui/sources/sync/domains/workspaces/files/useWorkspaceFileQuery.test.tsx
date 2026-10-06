import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit';
import { useWorkspaceFileQuery } from './useWorkspaceFileQuery';

const transport = vi.hoisted(() => ({ list: vi.fn(), directory: vi.fn() }));
vi.mock('@/sync/ops/machineWorkspaceFileList', () => ({ machineWorkspaceFileList: transport.list }));
vi.mock('@/sync/ops/machineFileBrowser', () => ({ machineFilesystemListDirectory: transport.directory }));
// The selected-account environment is a boundary; the filename owner and its matching stay real.
vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({ captureActiveServerAccountScopeLifetime: () => null }));

const scope = { machineId: 'machine', serverId: 'home', rootPath: '/repo' };
const accountLifetime = { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true,
    onRetire: () => ({ dispose: () => {} }) };

describe('useWorkspaceFileQuery', () => {
    beforeEach(() => { vi.useFakeTimers(); transport.list.mockReset(); });
    afterEach(() => { vi.useRealTimers(); });

    it('retains rows during refresh, cancels superseded requests and reports failed coverage', async () => {
        transport.list.mockResolvedValueOnce({ ok: true, paths: ['src/first.ts'], truncated: true });
        let finishLate: (value: unknown) => void = () => {};
        transport.list.mockImplementationOnce(() => new Promise((resolve) => { finishLate = resolve; }));
        transport.list.mockResolvedValueOnce({ ok: false, errorCode: 'ripgrep_failed' });
        const hook = await renderHook((query: string) => useWorkspaceFileQuery({ scope, query, mode: 'glob', accountLifetime }), { initialProps: 'first' });
        await act(async () => { await vi.advanceTimersByTimeAsync(200); });
        expect(hook.getCurrent().items.some((item) => item.fullPath === 'src/first.ts')).toBe(true);
        expect(hook.getCurrent().coverage).toBe('partial');
        await hook.rerender('second');
        expect(hook.getCurrent().isSearching).toBe(true);
        expect(hook.getCurrent().items.some((item) => item.fullPath === 'src/first.ts')).toBe(true);
        await act(async () => { await vi.advanceTimersByTimeAsync(200); });
        const signal = transport.list.mock.calls[1]?.[2]?.signal as AbortSignal;
        await hook.rerender('third');
        expect(signal.aborted).toBe(true);
        await act(async () => { finishLate({ ok: true, paths: ['stale.ts'], truncated: false }); await vi.advanceTimersByTimeAsync(200); });
        expect(hook.getCurrent().error?.code).toBe('WORKSPACE_FILE_SEARCH_UNAVAILABLE');
        expect(hook.getCurrent().error).toMatchObject({ errorCode: 'ripgrep_failed' });
        expect(hook.getCurrent().coverage).toBe('unavailable');
        expect(hook.getCurrent().items.some((item) => item.fullPath === 'stale.ts')).toBe(false);
        expect(hook.getCurrent().isSearching).toBe(false);
    });

    it('does no work for a closed query and clears results at a scope change', async () => {
        transport.list.mockResolvedValue({ ok: true, paths: ['first.ts'], truncated: false });
        const hook = await renderHook((input: { query: string; rootPath: string; enabled: boolean }) => useWorkspaceFileQuery({
            scope: { ...scope, rootPath: input.rootPath }, query: input.query, enabled: input.enabled, mode: 'glob', accountLifetime,
        }), { initialProps: { query: 'first', rootPath: '/repo', enabled: false } });
        await act(async () => { await vi.advanceTimersByTimeAsync(200); });
        expect(transport.list).not.toHaveBeenCalled();
        await hook.rerender({ query: 'first', rootPath: '/repo', enabled: true });
        await act(async () => { await vi.advanceTimersByTimeAsync(200); });
        expect(hook.getCurrent().items).toHaveLength(1);
        await hook.rerender({ query: 'first', rootPath: '/other', enabled: true });
        expect(hook.getCurrent().items).toHaveLength(0);
    });

    it('does not leave an already-retired credential query loading indefinitely', async () => {
        const accountLifetime = { scope: { serverId: 'home', accountId: 'old-account' }, isCurrent: () => false,
            onRetire: (cancel: () => void) => { cancel(); return { dispose: () => {} }; } };
        const hook = await renderHook(() => useWorkspaceFileQuery({ scope, query: 'needle', mode: 'glob', accountLifetime }));
        await act(async () => { await vi.advanceTimersByTimeAsync(200); });
        expect(transport.list).not.toHaveBeenCalled();
        expect(hook.getCurrent().items).toHaveLength(0);
        expect(hook.getCurrent().coverage).toBe('unavailable');
        expect(hook.getCurrent().isSearching).toBe(false);
    });

    it('clears retained rows and aborts transport when the exact credential lifetime retires', async () => {
        let current = true;
        const callbacks = new Set<() => void>();
        const accountLifetime = { scope: { serverId: 'home', accountId: 'target-account' }, isCurrent: () => current,
            onRetire: (cancel: () => void) => { callbacks.add(cancel); return { dispose: () => callbacks.delete(cancel) }; } };
        transport.list.mockResolvedValueOnce({ ok: true, paths: ['needle.ts'], truncated: false });
        transport.list.mockImplementationOnce(() => new Promise(() => {}));
        const hook = await renderHook((query: string) => useWorkspaceFileQuery({ scope, query, mode: 'glob', accountLifetime }),
            { initialProps: 'needle' });
        await act(async () => { await vi.advanceTimersByTimeAsync(200); });
        expect(hook.getCurrent().items).toHaveLength(1);
        await hook.rerender('next');
        await act(async () => { await vi.advanceTimersByTimeAsync(200); });
        const signal = transport.list.mock.calls[1]?.[2]?.signal as AbortSignal;
        await act(async () => { current = false; for (const retire of callbacks) retire(); });
        expect(signal.aborted).toBe(true);
        expect(hook.getCurrent().items).toHaveLength(0);
        expect(hook.getCurrent().error?.code).toBe('WORKSPACE_FILE_SEARCH_UNAVAILABLE');
        expect(hook.getCurrent().isSearching).toBe(false);
    });
});
