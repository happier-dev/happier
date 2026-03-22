import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useLazyDirectoryTree', () => {
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

        for (let i = 0; i < 5; i += 1) {
            await act(async () => {
                await Promise.resolve();
            });
            if (api.nodes.some((node: any) => node.path === 'src/index.ts')) break;
        }

        expect(loadDirectoryEntries).toHaveBeenCalledWith('');
        expect(loadDirectoryEntries).toHaveBeenCalledWith('src');
        expect(api.nodes.map((node: any) => node.path)).toEqual(['src', 'src/index.ts']);
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

        for (let i = 0; i < 5; i += 1) {
            await act(async () => {
                await Promise.resolve();
            });
            if (api.nodes.some((node: any) => node.path === '/Users')) break;
        }

        expect(loadDirectoryEntries).toHaveBeenCalledWith('/');
        expect(api.nodes.map((node: any) => node.path)).toEqual(['/', '/Users']);
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

        for (let i = 0; i < 5; i += 1) {
            await act(async () => {
                await Promise.resolve();
            });
            if (api.nodes.some((node: any) => node.path === '/Users')) break;
        }

        await act(async () => {
            await api.toggleDirectory('/Users');
        });

        for (let i = 0; i < 5; i += 1) {
            await act(async () => {
                await Promise.resolve();
            });
            if (api.nodes.some((node: any) => node.path === '/Users/leeroy')) break;
        }

        expect(loadDirectoryEntries).toHaveBeenCalledWith('/Users');
        expect(api.nodes.map((node: any) => node.path)).toEqual(['/', '/Users', '/Users/leeroy']);
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

        for (let i = 0; i < 5; i += 1) {
            await act(async () => {
                await Promise.resolve();
            });
            if (api.nodes.some((node: any) => node.type === 'info')) break;
        }

        expect(api.nodes.map((node: any) => ({ type: node.type, path: node.path, count: node.entryCount }))).toEqual([
            { type: 'directory', path: '/', count: undefined },
            { type: 'directory', path: '/Users', count: undefined },
            { type: 'info', path: '/#truncated', count: 1 },
        ]);
    });
});
