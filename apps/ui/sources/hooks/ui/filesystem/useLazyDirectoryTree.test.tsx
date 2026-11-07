import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { createDeferred, renderHook, renderScreen } from '@/dev/testkit';
import type { LazyDirectoryTreeEntry, LazyDirectoryTreeLoadResult } from './lazyDirectoryTreeTypes';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useLazyDirectoryTree', () => {
    it('refreshes renamed files in every expanded directory without leaving the session', async () => {
        const { useLazyDirectoryTree } = await import('./useLazyDirectoryTree');
        const rootEntries: LazyDirectoryTreeEntry[] = ['src', 'docs'].map((path) => ({
            name: path, path, type: 'directory',
        }));
        const entries = new Map<string, LazyDirectoryTreeEntry[]>([
            ['', rootEntries],
            ['src', [{ name: 'index.ts', path: 'src/index.ts', type: 'file' }]],
            ['docs', [{ name: 'old.txt', path: 'docs/old.txt', type: 'file' }]],
        ]);
        const getCachedEntries = (path: string) => entries.get(path) ?? null;
        let pendingSrc: ReturnType<typeof createDeferred<LazyDirectoryTreeLoadResult>> | null = null;
        // Directory I/O is the boundary; the tree state and refresh effects stay real.
        const loadDirectoryEntries = async (path: string): Promise<LazyDirectoryTreeLoadResult> => {
            if (path === 'src' && pendingSrc) return pendingSrc.promise;
            return { ok: true, entries: entries.get(path) ?? [] };
        };
        const expandedPaths = ['src', 'docs'];
        const onExpandedPathsChange = vi.fn();
        const hook = await renderHook(({ reloadToken }: { reloadToken: number }) => useLazyDirectoryTree({
            scopeKey: 'session-1', enabled: true, rootDirectoryPath: '',
            expandedPaths, onExpandedPathsChange, reloadToken, getCachedEntries, loadDirectoryEntries,
        }), { initialProps: { reloadToken: 0 } });
        const paths = () => hook.getCurrent().nodes.map((node) => node.path);
        expect(paths()).toEqual(['src', 'src/index.ts', 'docs', 'docs/old.txt']);

        entries.set('docs', [{ name: 'renamed.txt', path: 'docs/renamed.txt', type: 'file' }]);
        pendingSrc = createDeferred<LazyDirectoryTreeLoadResult>();
        await hook.rerender({ reloadToken: 1 });
        await act(async () => {
            pendingSrc?.resolve({ ok: true, entries: entries.get('src')! });
        });
        expect(paths()).toEqual(['src', 'src/index.ts', 'docs', 'docs/renamed.txt']);
        expect(hook.getCurrent().expandedCount).toBe(2);

        // Another refresh in the same session must not reuse the previous listing.
        pendingSrc = null;
        entries.set('docs', [{ name: 'renamed-again.txt', path: 'docs/renamed-again.txt', type: 'file' }]);
        await hook.rerender({ reloadToken: 2 });
        expect(paths()).toEqual(['src', 'src/index.ts', 'docs', 'docs/renamed-again.txt']);
    });

    async function waitForNodePaths(api: { nodes: Array<{ path: string }> }, expectedPaths: readonly string[]) {
        await vi.waitFor(() => {
            expect(api.nodes.map((node) => node.path)).toEqual(expectedPaths);
        });
    }

    it('hydrates cached root entries and loads children lazily on expand', async () => {
        const getCachedEntries = vi.fn((directoryPath: string) => {
            if (directoryPath === '') {
                return [{ name: 'src', path: 'src', type: 'directory' as const }];
            }
            return null;
        });

        const loadDirectoryEntries = vi.fn(async (directoryPath: string) => {
            if (directoryPath === '') {
                return {
                    ok: true as const,
                    entries: [{ name: 'src', path: 'src', type: 'directory' as const }],
                };
            }
            return {
                ok: true as const,
                entries: [{ name: 'index.ts', path: 'src/index.ts', type: 'file' as const }],
            };
        });

        const { useLazyDirectoryTree } = await import('./useLazyDirectoryTree');

        let api: any = null;

        function Test() {
            const [expandedPaths, setExpandedPaths] = React.useState<string[]>([]);
            api = useLazyDirectoryTree({
                scopeKey: 'scope-1',
                enabled: true,
                rootDirectoryPath: '',
                expandedPaths,
                onExpandedPathsChange: setExpandedPaths,
                getCachedEntries,
                loadDirectoryEntries,
            });
            return null;
        }

        await renderScreen(<Test />);

        expect(api.nodes.map((node: any) => node.path)).toEqual(['src']);

        await act(async () => {
            await api.toggleDirectory('src');
        });

        await waitForNodePaths(api, ['src', 'src/index.ts']);

        expect(loadDirectoryEntries).toHaveBeenCalledWith('');
        expect(loadDirectoryEntries).toHaveBeenCalledWith('src');
    });

    it('preserves absolute root directory paths so machine root rows can expand', async () => {
        const getCachedEntries = vi.fn((directoryPath: string) => {
            if (directoryPath === '') {
                return [{ name: '/', path: '/', type: 'directory' as const }];
            }
            return null;
        });

        const loadDirectoryEntries = vi.fn(async (directoryPath: string) => {
            if (directoryPath === '') {
                return {
                    ok: true as const,
                    entries: [{ name: '/', path: '/', type: 'directory' as const }],
                };
            }
            if (directoryPath === '/') {
                return {
                    ok: true as const,
                    entries: [{ name: 'Users', path: '/Users', type: 'directory' as const }],
                };
            }
            return { ok: true as const, entries: [] };
        });

        const { useLazyDirectoryTree } = await import('./useLazyDirectoryTree');

        let api: any = null;

        function Test() {
            const [expandedPaths, setExpandedPaths] = React.useState<string[]>([]);
            api = useLazyDirectoryTree({
                scopeKey: 'machine-root-scope',
                enabled: true,
                rootDirectoryPath: '',
                expandedPaths,
                onExpandedPathsChange: setExpandedPaths,
                getCachedEntries,
                loadDirectoryEntries,
            });
            return null;
        }

        await renderScreen(<Test />);

        await act(async () => {
            await api.toggleDirectory('/');
        });

        await waitForNodePaths(api, ['/', '/Users']);

        expect(loadDirectoryEntries).toHaveBeenCalledWith('/');
    });

    it('renders nested absolute child directories after expanding them', async () => {
        const getCachedEntries = vi.fn(() => null);

        const loadDirectoryEntries = vi.fn(async (directoryPath: string) => {
            if (directoryPath === '') {
                return {
                    ok: true as const,
                    entries: [{ name: '/', path: '/', type: 'directory' as const }],
                };
            }
            if (directoryPath === '/') {
                return {
                    ok: true as const,
                    entries: [{ name: 'Users', path: '/Users', type: 'directory' as const }],
                };
            }
            if (directoryPath === '/Users') {
                return {
                    ok: true as const,
                    entries: [{ name: 'leeroy', path: '/Users/leeroy', type: 'directory' as const }],
                };
            }
            return { ok: true as const, entries: [] };
        });

        const { useLazyDirectoryTree } = await import('./useLazyDirectoryTree');

        let api: any = null;

        function Test() {
            const [expandedPaths, setExpandedPaths] = React.useState<string[]>([]);
            api = useLazyDirectoryTree({
                scopeKey: 'machine-nested-scope',
                enabled: true,
                rootDirectoryPath: '',
                expandedPaths,
                onExpandedPathsChange: setExpandedPaths,
                getCachedEntries,
                loadDirectoryEntries,
            });
            return null;
        }

        await renderScreen(<Test />);

        await act(async () => {
            await api.toggleDirectory('/');
        });

        await waitForNodePaths(api, ['/', '/Users']);

        await act(async () => {
            await api.toggleDirectory('/Users');
        });

        await waitForNodePaths(api, ['/', '/Users', '/Users/leeroy']);

        expect(loadDirectoryEntries).toHaveBeenCalledWith('/Users');
    });

    it('adds an informational node when a directory result is truncated', async () => {
        const getCachedEntries = vi.fn(() => null);

        const loadDirectoryEntries = vi.fn(async (directoryPath: string) => {
            if (directoryPath === '') {
                return {
                    ok: true as const,
                    entries: [{ name: '/', path: '/', type: 'directory' as const }],
                };
            }
            if (directoryPath === '/') {
                return {
                    ok: true as const,
                    entries: [{ name: 'Users', path: '/Users', type: 'directory' as const }],
                    truncated: true,
                };
            }
            return { ok: true as const, entries: [] };
        });

        const { useLazyDirectoryTree } = await import('./useLazyDirectoryTree');

        let api: any = null;

        function Test() {
            const [expandedPaths, setExpandedPaths] = React.useState<string[]>([]);
            api = useLazyDirectoryTree({
                scopeKey: 'machine-truncated-scope',
                enabled: true,
                rootDirectoryPath: '',
                expandedPaths,
                onExpandedPathsChange: setExpandedPaths,
                getCachedEntries,
                loadDirectoryEntries,
            });
            return null;
        }

        await renderScreen(<Test />);

        await act(async () => {
            await api.toggleDirectory('/');
        });

        await vi.waitFor(() => {
            expect(api.nodes.map((node: any) => ({ type: node.type, path: node.path, count: node.entryCount }))).toEqual([
                { type: 'directory', path: '/', count: undefined },
                { type: 'directory', path: '/Users', count: undefined },
                { type: 'info', path: '/#truncated', count: 1 },
            ]);
        });

    });
});
