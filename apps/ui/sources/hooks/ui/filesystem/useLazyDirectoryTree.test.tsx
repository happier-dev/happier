import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useLazyDirectoryTree', () => {
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
