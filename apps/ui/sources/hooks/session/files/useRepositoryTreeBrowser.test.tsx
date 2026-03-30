import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const listRepositoryDirectoryEntriesSpy = vi.fn<
    (input: { sessionId: string; directoryPath: string }) => Promise<{ ok: true; entries: Array<{ name: string; type: 'file' | 'directory' }> }>
>();

const cachedDirectoryEntries = new Map<string, Array<{ name: string; type: 'file' | 'directory' }>>();

vi.mock('@/sync/domains/input/repositoryDirectory', () => ({
    listRepositoryDirectoryEntries: (input: any) => listRepositoryDirectoryEntriesSpy(input),
    warmRepositoryDirectoryCache: (input: any) => listRepositoryDirectoryEntriesSpy(input),
    getCachedRepositoryDirectoryEntries: (input: any) => cachedDirectoryEntries.get(`${input.sessionId}:${input.directoryPath}`) ?? null,
    setCachedRepositoryDirectoryEntries: (input: any) => {
        cachedDirectoryEntries.set(`${input.sessionId}:${input.directoryPath}`, input.entries);
    },
}));

describe('useRepositoryTreeBrowser', () => {
    it('hydrates initial nodes from the directory cache while revalidating in the background', async () => {
        cachedDirectoryEntries.set('session-1:', [
            { name: 'cached.md', type: 'file' },
        ]);
        let resolveRootEntries: ((value: { ok: true; entries: Array<{ name: string; type: 'file' | 'directory' }> }) => void) | null = null;

        listRepositoryDirectoryEntriesSpy.mockImplementation(async ({ directoryPath }) => {
            if (!directoryPath) {
                return await new Promise((resolve) => {
                    resolveRootEntries = resolve;
                });
            }
            return { ok: true, entries: [] };
        });

        const { useRepositoryTreeBrowser } = await import('./useRepositoryTreeBrowser');

        let api: any = null;
        function Test() {
            const [expandedPaths, setExpandedPaths] = React.useState<string[]>([]);
            api = useRepositoryTreeBrowser({
                sessionId: 'session-1',
                enabled: true,
                expandedPaths,
                onExpandedPathsChange: setExpandedPaths,
            });
            return null;
        }

        await renderScreen(<Test />);

        expect(api.nodes.map((n: any) => n.path)).toEqual(['cached.md']);

        // Revalidation should still occur.
        await act(async () => {});
        expect(listRepositoryDirectoryEntriesSpy).toHaveBeenCalledWith({ sessionId: 'session-1', directoryPath: '' });

        await act(async () => {
            resolveRootEntries?.({
                ok: true,
                entries: [
                    { name: 'src', type: 'directory' },
                    { name: 'README.md', type: 'file' },
                ],
            });
        });
        await vi.waitFor(() => {
            expect(api.nodes.map((n: any) => n.path)).toEqual(['src', 'README.md']);
        });
    });

    it('persists expanded directories via provided callbacks and collapses all', async () => {
        cachedDirectoryEntries.clear();
        listRepositoryDirectoryEntriesSpy.mockImplementation(async ({ directoryPath }) => {
            if (!directoryPath) {
                return {
                    ok: true,
                    entries: [
                        { name: 'src', type: 'directory' },
                        { name: 'README.md', type: 'file' },
                    ],
                };
            }
            if (directoryPath === 'src') {
                return { ok: true, entries: [{ name: 'a.ts', type: 'file' }] };
            }
            return { ok: true, entries: [] };
        });

        const { useRepositoryTreeBrowser } = await import('./useRepositoryTreeBrowser');

        let api: any = null;

        function Test() {
            const [expandedPaths, setExpandedPaths] = React.useState<string[]>([]);
            api = useRepositoryTreeBrowser({
                sessionId: 'session-1',
                enabled: true,
                expandedPaths,
                onExpandedPathsChange: setExpandedPaths,
            });
            return null;
        }

        await renderScreen(<Test />);
        await act(async () => {});

        expect(listRepositoryDirectoryEntriesSpy).toHaveBeenCalledWith({ sessionId: 'session-1', directoryPath: '' });

        expect(api.nodes.map((n: any) => n.path)).toEqual(['src', 'README.md']);

        await act(async () => {
            await api.toggleDirectory('src');
        });

        await vi.waitFor(() => {
            expect(api.nodes.some((n: any) => n.path === 'src/a.ts')).toBe(true);
        });

        expect(listRepositoryDirectoryEntriesSpy).toHaveBeenCalledWith({ sessionId: 'session-1', directoryPath: 'src' });
        expect(api.nodes.map((n: any) => n.path)).toEqual(['src', 'src/a.ts', 'README.md']);
        expect(api.expandedCount).toBe(1);

        act(() => {
            api.collapseAll();
        });

        expect(api.nodes.map((n: any) => n.path)).toEqual(['src', 'README.md']);
        expect(api.expandedCount).toBe(0);
    });

    it('does not apply stale directory results after switching sessions', async () => {
        cachedDirectoryEntries.clear();
        let resolveSession1Src: ((value: any) => void) | null = null;

        listRepositoryDirectoryEntriesSpy.mockImplementation(async ({ sessionId, directoryPath }) => {
            if (!directoryPath) {
                return {
                    ok: true,
                    entries: [
                        { name: 'src', type: 'directory' },
                        { name: 'README.md', type: 'file' },
                    ],
                };
            }
            if (directoryPath === 'src') {
                if (sessionId === 'session-1') {
                    return await new Promise((resolve) => {
                        resolveSession1Src = resolve;
                    });
                }
                return { ok: true, entries: [{ name: 'b.ts', type: 'file' }] };
            }
            return { ok: true, entries: [] };
        });

        const { useRepositoryTreeBrowser } = await import('./useRepositoryTreeBrowser');

        const apiRef: { current: any } = { current: null };
        let setSessionId: ((value: string) => void) | null = null;

        function Test() {
            const [sessionId, setSession] = React.useState('session-1');
            const [expandedPaths, setExpandedPaths] = React.useState<string[]>([]);
            setSessionId = setSession;

            React.useEffect(() => {
                setExpandedPaths([]);
            }, [sessionId]);

            const api = useRepositoryTreeBrowser({
                sessionId,
                enabled: true,
                expandedPaths,
                onExpandedPathsChange: setExpandedPaths,
            });
            apiRef.current = api;
            return null;
        }

        await renderScreen(<Test />);
        await act(async () => {});

        expect(listRepositoryDirectoryEntriesSpy).toHaveBeenCalledWith({ sessionId: 'session-1', directoryPath: '' });

        // Expand src for session-1, leaving the load in flight.
        act(() => {
            apiRef.current.toggleDirectory('src');
        });

        // Switch sessions while the session-1 directory load is still pending.
        await act(async () => {
            setSessionId!('session-2');
        });
        await act(async () => {});

        expect(listRepositoryDirectoryEntriesSpy).toHaveBeenCalledWith({ sessionId: 'session-2', directoryPath: '' });

        // Resolve the stale session-1 directory request.
        const resolveStaleSession: (result: any) => void =
            resolveSession1Src ?? (() => { throw new Error('Expected session-1 src resolver to be assigned'); });
        resolveStaleSession({ ok: true, entries: [{ name: 'a.ts', type: 'file' }] });
        resolveSession1Src = null;

        // Now expand src in session-2. This must fetch session-2 entries, not reuse stale session-1 results.
        await act(async () => {
            await apiRef.current.toggleDirectory('src');
        });

        await vi.waitFor(() => {
            expect(apiRef.current.nodes.some((n: any) => n.path === 'src/b.ts')).toBe(true);
        });

        expect(listRepositoryDirectoryEntriesSpy).toHaveBeenCalledWith({ sessionId: 'session-2', directoryPath: 'src' });
        expect(apiRef.current.nodes.some((n: any) => n.path === 'src/a.ts')).toBe(false);
    });

    it('revalidates already-expanded directories when reloadToken changes', async () => {
        cachedDirectoryEntries.clear();

        let srcEntries = [{ name: 'old.ts', type: 'file' as const }];
        listRepositoryDirectoryEntriesSpy.mockImplementation(async ({ directoryPath }) => {
            if (!directoryPath) {
                return {
                    ok: true,
                    entries: [{ name: 'src', type: 'directory' }],
                };
            }
            if (directoryPath === 'src') {
                return { ok: true, entries: srcEntries };
            }
            return { ok: true, entries: [] };
        });

        const { useRepositoryTreeBrowser } = await import('./useRepositoryTreeBrowser');

        const apiRef: { current: any } = { current: null };
        let setReloadToken: ((value: number) => void) | null = null;

        function Test() {
            const [expandedPaths, setExpandedPaths] = React.useState<string[]>([]);
            const [reloadToken, setReload] = React.useState(0);
            setReloadToken = setReload;

            apiRef.current = useRepositoryTreeBrowser({
                sessionId: 'session-1',
                enabled: true,
                expandedPaths,
                onExpandedPathsChange: setExpandedPaths,
                reloadToken,
            });
            return null;
        }

        await renderScreen(<Test />);
        await act(async () => {});

        await act(async () => {
            await apiRef.current.toggleDirectory('src');
        });

        await vi.waitFor(() => {
            expect(apiRef.current.nodes.some((n: any) => n.path === 'src/old.ts')).toBe(true);
        });

        expect(apiRef.current.nodes.some((n: any) => n.path === 'src/old.ts')).toBe(true);

        srcEntries = [{ name: 'new.ts', type: 'file' as const }];
        listRepositoryDirectoryEntriesSpy.mockClear();

        await act(async () => {
            setReloadToken!(1);
        });

        await vi.waitFor(() => {
            expect(apiRef.current.nodes.some((n: any) => n.path === 'src/new.ts')).toBe(true);
        });

        expect(listRepositoryDirectoryEntriesSpy.mock.calls).toContainEqual([{ sessionId: 'session-1', directoryPath: '' }]);
        expect(listRepositoryDirectoryEntriesSpy.mock.calls).toContainEqual([{ sessionId: 'session-1', directoryPath: 'src' }]);
        expect(apiRef.current.nodes.some((n: any) => n.path === 'src/new.ts')).toBe(true);
        expect(apiRef.current.nodes.some((n: any) => n.path === 'src/old.ts')).toBe(false);
    });
});
