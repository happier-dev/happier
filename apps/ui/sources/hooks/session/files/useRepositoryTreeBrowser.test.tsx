import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const listRepositoryDirectoryEntriesSpy = vi.fn<
    (input: { sessionId: string; directoryPath: string }) => Promise<{ ok: true; entries: Array<{ name: string; type: 'file' | 'directory' }> }>
>();

vi.mock('@/sync/domains/input/repositoryDirectory', () => ({
    listRepositoryDirectoryEntries: (input: any) => listRepositoryDirectoryEntriesSpy(input),
}));

describe('useRepositoryTreeBrowser', () => {
    it('persists expanded directories via provided callbacks and collapses all', async () => {
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

        await act(async () => {
            renderer.create(<Test />);
        });
        await act(async () => {});

        expect(listRepositoryDirectoryEntriesSpy).toHaveBeenCalledWith({ sessionId: 'session-1', directoryPath: '' });

        expect(api.nodes.map((n: any) => n.path)).toEqual(['src', 'README.md']);

        await act(async () => {
            await api.toggleDirectory('src');
        });

        // Child loading happens in an effect; flush until the child node appears.
        // Avoid relying on timers here because other tests can leak fake timers.
        for (let i = 0; i < 10; i++) {
            await act(async () => {
                await Promise.resolve();
            });
            if (api.nodes.some((n: any) => n.path === 'src/a.ts')) break;
        }

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

        await act(async () => {
            renderer.create(<Test />);
        });
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
        resolveSession1Src?.({ ok: true, entries: [{ name: 'a.ts', type: 'file' }] });
        resolveSession1Src = null;

        // Flush microtasks.
        for (let i = 0; i < 5; i++) {
            await act(async () => {
                await Promise.resolve();
            });
        }

        // Now expand src in session-2. This must fetch session-2 entries, not reuse stale session-1 results.
        await act(async () => {
            await apiRef.current.toggleDirectory('src');
        });

        expect(listRepositoryDirectoryEntriesSpy).toHaveBeenCalledWith({ sessionId: 'session-2', directoryPath: 'src' });
        expect(apiRef.current.nodes.some((n: any) => n.path === 'src/b.ts')).toBe(true);
        expect(apiRef.current.nodes.some((n: any) => n.path === 'src/a.ts')).toBe(false);
    });
});
