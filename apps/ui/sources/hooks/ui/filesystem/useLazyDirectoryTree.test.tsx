import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderHook, renderScreen } from '@/dev/testkit';
import { useLazyDirectoryTree } from './useLazyDirectoryTree';
import type { LazyDirectoryTreeEntry, LazyDirectoryTreeLoadResult } from './lazyDirectoryTreeTypes';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useLazyDirectoryTree', () => {
    const directory = (path: string): LazyDirectoryTreeEntry => ({ path, name: path.split('/').at(-1)!, type: 'directory' });
    const file = (path: string): LazyDirectoryTreeEntry => ({ path, name: path.split('/').at(-1)!, type: 'file' });

    it('reconciles only the nearest loaded ancestor and queues writes during an inline edit', async () => {
        const entries = new Map<string, LazyDirectoryTreeEntry[]>([
            ['', [directory('src'), directory('other')]],
            ['src', [file('src/old.ts')]],
        ]);
        const loaded: string[] = [];
        const loadDirectoryEntries = async (path: string): Promise<LazyDirectoryTreeLoadResult> => {
            loaded.push(path);
            return { ok: true, entries: entries.get(path) ?? [] };
        };
        const getCachedEntries = (path: string) => entries.get(path) ?? null;
        const hook = await renderHook(({ paused }: { paused: boolean }) => useLazyDirectoryTree({
            scopeKey: 'workspace', enabled: true, rootDirectoryPath: '', getCachedEntries,
            loadDirectoryEntries, reconciliationPaused: paused,
        }), { initialProps: { paused: false } });
        await act(async () => { await hook.getCurrent().toggleDirectory('src'); });
        loaded.length = 0;
        entries.set('src', [file('src/old.ts'), file('src/new.ts')]);
        await hook.rerender({ paused: true });
        await act(async () => { hook.getCurrent().reconcilePaths(['src/new.ts', 'src/nested/another.ts']); });
        expect(loaded).toEqual([]);
        await hook.rerender({ paused: false });
        expect(loaded).toEqual(['src']);
        expect(hook.getCurrent().nodes.map(node => node.path)).toContain('src/new.ts');
        expect(hook.getCurrent().arrivedPaths.has('src/new.ts')).toBe(true);
    });

    it('marks collapsed cached directories stale and reloads them on expand', async () => {
        let children = [file('src/old.ts')];
        const loaded: string[] = [];
        const getCachedEntries = (path: string) => path === '' ? [directory('src')] : null;
        const loadDirectoryEntries = async (path: string): Promise<LazyDirectoryTreeLoadResult> => {
            loaded.push(path);
            return { ok: true, entries: path === '' ? [directory('src')] : children };
        };
        const hook = await renderHook(() => useLazyDirectoryTree({ scopeKey: 'workspace', enabled: true,
            rootDirectoryPath: '', getCachedEntries, loadDirectoryEntries }));
        await act(async () => { await hook.getCurrent().toggleDirectory('src'); });
        await act(async () => { await hook.getCurrent().toggleDirectory('src'); });
        loaded.length = 0;
        children = [file('src/new.ts')];
        await act(async () => { hook.getCurrent().reconcilePaths(['src/new.ts']); });
        expect(loaded).toEqual([]);
        await act(async () => { await hook.getCurrent().toggleDirectory('src'); });
        expect(loaded).toEqual(['src']);
        expect(hook.getCurrent().nodes.map(node => node.path)).toEqual(['src', 'src/new.ts']);
    });

    it('prunes removed directory descendants so recreating the directory cannot resurrect old rows', async () => {
        let root = [directory('src')];
        let children = [file('src/old.ts')];
        let childError = false;
        const getCachedEntries = () => null;
        const loadDirectoryEntries = async (path: string): Promise<LazyDirectoryTreeLoadResult> => path !== '' && childError
            ? { ok: false, error: 'deleted_during_refresh' } : { ok: true, entries: path === '' ? root : children };
        const hook = await renderHook(() => useLazyDirectoryTree({ scopeKey: 'workspace', enabled: true,
            rootDirectoryPath: '', getCachedEntries, loadDirectoryEntries }));
        await act(async () => { await hook.getCurrent().toggleDirectory('src'); });
        childError = true;
        await act(async () => { await hook.getCurrent().retryDirectory('src'); });
        root = [];
        await act(async () => { hook.getCurrent().reconcilePaths(['src']); });
        expect(hook.getCurrent().nodes).toEqual([]);
        root = [directory('src')];
        children = [file('src/recreated.ts')];
        childError = false;
        await act(async () => { hook.getCurrent().reconcilePaths(['src']); });
        await vi.waitFor(() => expect(hook.getCurrent().nodes.map(node => node.path)).toEqual(['src', 'src/recreated.ts']));
    });

    it('coalesces mutations during a directory request to one trailing reload', async () => {
        let resolvePending: ((value: LazyDirectoryTreeLoadResult) => void) | undefined;
        let requests = 0;
        const getCachedEntries = () => [file('old.ts')];
        const loadDirectoryEntries = async (): Promise<LazyDirectoryTreeLoadResult> => {
            requests += 1;
            if (requests === 2) return await new Promise(resolve => { resolvePending = resolve; });
            return { ok: true, entries: [file('new.ts')] };
        };
        const hook = await renderHook(() => useLazyDirectoryTree({ scopeKey: 'workspace', enabled: true,
            rootDirectoryPath: '', getCachedEntries, loadDirectoryEntries }));
        await act(async () => { hook.getCurrent().reconcilePaths(['first.ts']); });
        await act(async () => { hook.getCurrent().reconcilePaths(['second.ts', 'third.ts']); });
        expect(requests).toBe(2);
        await act(async () => { resolvePending!({ ok: true, entries: [file('intermediate.ts')] }); });
        expect(requests).toBe(3);
        expect(hook.getCurrent().nodes.map(node => node.path)).toEqual(['new.ts']);
    });

    it('retains a write that settles before the first root listing finishes', async () => {
        let resolveInitial: ((value: LazyDirectoryTreeLoadResult) => void) | undefined;
        let requests = 0;
        const getCachedEntries = () => null;
        const loadDirectoryEntries = async (): Promise<LazyDirectoryTreeLoadResult> => {
            requests += 1;
            if (requests === 1) return await new Promise(resolve => { resolveInitial = resolve; });
            return { ok: true, entries: [file('created.ts')] };
        };
        const hook = await renderHook(() => useLazyDirectoryTree({ scopeKey: 'workspace', enabled: true,
            rootDirectoryPath: '', getCachedEntries, loadDirectoryEntries }));
        await act(async () => { hook.getCurrent().reconcilePaths(['created.ts']); });
        await act(async () => { resolveInitial!({ ok: true, entries: [] }); });
        expect(hook.getCurrent().nodes.map(node => node.path)).toEqual(['created.ts']);
    });

    it('drops reconciliation results when the workspace changes while awaiting', async () => {
        let resolvePending: ((value: LazyDirectoryTreeLoadResult) => void) | undefined;
        let requests = 0;
        const getCachedEntries = () => null;
        const loadDirectoryEntries = async (): Promise<LazyDirectoryTreeLoadResult> => {
            requests += 1;
            if (requests === 2) return await new Promise(resolve => { resolvePending = resolve; });
            return { ok: true, entries: [file('current.ts')] };
        };
        const hook = await renderHook(({ scopeKey }: { scopeKey: string }) => useLazyDirectoryTree({ scopeKey, enabled: true,
            rootDirectoryPath: '', getCachedEntries, loadDirectoryEntries }), { initialProps: { scopeKey: 'first' } });
        await act(async () => { hook.getCurrent().reconcilePaths(['old.ts']); });
        await hook.rerender({ scopeKey: 'second' });
        await act(async () => { resolvePending!({ ok: true, entries: [file('wrong-workspace.ts')] }); });
        expect(hook.getCurrent().nodes.map(node => node.path)).toEqual(['current.ts']);
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

        expect(loadDirectoryEntries).toHaveBeenCalledWith('', expect.any(AbortSignal), undefined);
        expect(loadDirectoryEntries).toHaveBeenCalledWith('src', expect.any(AbortSignal), undefined);
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

        expect(loadDirectoryEntries).toHaveBeenCalledWith('/', expect.any(AbortSignal), undefined);
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

        expect(loadDirectoryEntries).toHaveBeenCalledWith('/Users', expect.any(AbortSignal), undefined);
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

    it('reuses unchanged node objects when expanding a descendant directory', async () => {
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
                scopeKey: 'machine-reference-stability-scope',
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
        const rootNodeBeforeExpand = api.nodes.find((node: any) => node.path === '/');
        expect(rootNodeBeforeExpand).toBeTruthy();

        await act(async () => {
            await api.toggleDirectory('/Users');
        });

        await waitForNodePaths(api, ['/', '/Users', '/Users/leeroy']);

        expect(api.nodes.find((node: any) => node.path === '/')).toBe(rootNodeBeforeExpand);
    });
});
