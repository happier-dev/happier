import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    flushHookEffects,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { installFilesContentCommonModuleMocks } from './filesContentTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type SessionListDirectoryLikeResponse =
    | { success: true; entries: Array<{ name: string; type: 'file' | 'directory' | 'other' }> }
    | { success: false; error: string };

const sessionListDirectorySpy = vi.fn<(_sessionId: string, _path: string) => Promise<SessionListDirectoryLikeResponse>>(
    async (_sessionId: string, _path: string) => ({
        success: true,
        entries: [],
    }),
);

const theme = {
    colors: {
        surface: '#111',
        surfaceHigh: '#222',
        surfaceHighest: '#2a2a2a',
        surfacePressed: '#1b1b1b',
        surfacePressedOverlay: 'rgba(255, 255, 255, 0.08)',
        surfaceSelected: '#191919',
        divider: '#333',
        text: '#eee',
        textSecondary: '#aaa',
        textLink: '#08f',
        accent: {
            blue: '#08f',
        },
        warning: '#f80',
        success: '#0f0',
        textDestructive: '#f00',
        deleteAction: '#f44',
        button: {
            secondary: {
                tint: '#08f',
            },
        },
        modal: {
            border: '#444',
        },
        shadow: {
            color: '#000',
            opacity: 0.2,
        },
    },
    dark: false,
} as const;

installFilesContentCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            TurboModuleRegistry: { get: () => ({}) },
            FlatList: ({ data, renderItem, keyExtractor, ListHeaderComponent }: any) => {
                const header = ListHeaderComponent
                    ? (React.isValidElement(ListHeaderComponent) ? ListHeaderComponent : React.createElement(ListHeaderComponent))
                    : null;
                const items = (data ?? []).map((item: any, index: number) => {
                    const key = keyExtractor ? keyExtractor(item, index) : String(item?.path ?? index);
                    return React.createElement(React.Fragment, { key }, renderItem({ item, index }));
                });
                return React.createElement('FlatList', null, header, ...items);
            },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({ theme });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/components/ui/text/Text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return {
        ...createTextModuleMock(),
        Text: 'Text',
        TextInput: 'TextInput',
    };
});

vi.mock('@/components/ui/media/FileIcon', () => ({
    FileIcon: 'FileIcon',
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.rightElement),
}));

vi.mock('@/components/sessions/files/repositoryTree/WebDropTargetView', () => ({
    WebDropTargetView: (props: any) => React.createElement('WebDropTargetView', props, props.children),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
        mono: () => ({}),
    },
}));

vi.mock('@/sync/ops', async (importOriginal) => {
    const { createSyncOpsModuleMock } = await import('@/dev/testkit/mocks/syncOps');
    return createSyncOpsModuleMock({
        importOriginal,
        overrides: {
            sessionListDirectory: (sessionId: string, path: string) => sessionListDirectorySpy(sessionId, path),
            sessionRenamePath: vi.fn(async () => ({ success: true as const })),
            sessionStatFile: vi.fn(async () => ({ success: true as const, exists: false })),
            sessionDeletePath: vi.fn(async () => ({ success: true as const })),
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({ theme });
});

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: any) => React.createElement('RoundButton', props),
}));

function repositoryTreeRowTestId(path: string): string {
    return `repository-tree-row-${toTestIdSafeValue(path)}`;
}

function findRepositoryRows(screen: Awaited<ReturnType<typeof renderRepositoryTreeList>>['screen']) {
    return screen.findAll((node) =>
        (node.type as any) === 'Item'
        && typeof node.props?.testID === 'string'
        && node.props.testID.startsWith('repository-tree-row-')
        && typeof node.props?.title === 'string',
    );
}

function findDropTargetForTitle(screen: Awaited<ReturnType<typeof renderRepositoryTreeList>>['screen'], title: string) {
    return screen.findAll((node) => (node.type as any) === 'WebDropTargetView').find((target) => (
        target.findAll((child) => child.props?.title === title).length > 0
    )) ?? null;
}

async function settleRepositoryTree() {
    await flushHookEffects({ cycles: 3 });
}

async function renderRepositoryTreeList(overrides: Partial<Readonly<{
    reloadToken?: number;
    detailsMode?: boolean;
    writeActionsEnabled?: boolean;
    onRequestRefresh?: (() => void) | null;
    onRequestDownload?: ((params: Readonly<{ path: string; asZip: boolean }>) => Promise<{ ok: true } | { ok: false; error: string }>) | null;
    onWebDropTargetChange?: ((target: unknown) => void) | null;
    webDropHoverPath?: string | null;
    onOpenFile?: (path: string) => void;
    onOpenFilePinned?: (path: string) => void;
}>> = {}) {
    const { RepositoryTreeList } = await import('./RepositoryTreeList');
    const onOpenFile = overrides.onOpenFile ?? vi.fn();
    const onOpenFilePinned = overrides.onOpenFilePinned;

    function Wrapper() {
        const [expandedPaths, setExpandedPaths] = React.useState<string[]>([]);
        return (
            <RepositoryTreeList
                theme={theme}
                sessionId="session-1"
                expandedPaths={expandedPaths}
                onExpandedPathsChange={setExpandedPaths}
                onOpenFile={onOpenFile}
                onOpenFilePinned={onOpenFilePinned}
                reloadToken={overrides.reloadToken}
                detailsMode={overrides.detailsMode}
                writeActionsEnabled={overrides.writeActionsEnabled}
                onRequestRefresh={overrides.onRequestRefresh}
                onRequestDownload={overrides.onRequestDownload}
                onWebDropTargetChange={overrides.onWebDropTargetChange as any}
                webDropHoverPath={overrides.webDropHoverPath}
            />
        );
    }

    const screen = await renderScreen(<Wrapper />);
    await settleRepositoryTree();

    return {
        screen,
        onOpenFile,
    };
}

describe('RepositoryTreeList', () => {
    beforeEach(() => {
        sessionListDirectorySpy.mockReset();
        sessionListDirectorySpy.mockResolvedValue({
            success: true,
            entries: [],
        });
    });

    afterEach(() => {
        standardCleanup();
    });

    it('renders an error state when directory listing fails', async () => {
        sessionListDirectorySpy.mockResolvedValue({
            success: false,
            error: 'offline',
        });

        const { screen } = await renderRepositoryTreeList();

        expect(screen.findAllByTestId('repository-tree-error')).toHaveLength(1);
    });

    it('orders directories before files and supports expanding a directory', async () => {
        sessionListDirectorySpy.mockImplementation(async (_sessionId: string, path: string) => {
            if (path === '') {
                return {
                    success: true,
                    entries: [
                        { name: 'README.md', type: 'file' },
                        { name: 'src', type: 'directory' },
                    ],
                };
            }
            if (path === 'src') {
                return {
                    success: true,
                    entries: [{ name: 'a.ts', type: 'file' }],
                };
            }
            return { success: true, entries: [] };
        });

        const { screen } = await renderRepositoryTreeList();

        expect(findRepositoryRows(screen).map((row) => row.props.title)).toEqual(['src/', 'README.md']);
        expect(findRepositoryRows(screen).every((row) => row.props.density === 'tight')).toBe(true);

        await act(async () => {
            screen.pressByTestId(repositoryTreeRowTestId('src'));
        });
        await settleRepositoryTree();

        expect(findRepositoryRows(screen).map((row) => row.props.title)).toContain('a.ts');
    });

    it('shows a folder load error row instead of an empty tree when a child directory cannot be loaded', async () => {
        sessionListDirectorySpy.mockImplementation(async (_sessionId: string, path: string) => {
            if (path === '') {
                return {
                    success: true,
                    entries: [{ name: 'src', type: 'directory' }],
                };
            }
            if (path === 'src') {
                return {
                    success: false,
                    error: 'permission denied',
                };
            }
            return { success: true, entries: [] };
        });

        const { screen } = await renderRepositoryTreeList();

        await act(async () => {
            screen.pressByTestId(repositoryTreeRowTestId('src'));
        });
        await settleRepositoryTree();

        expect(
            screen.findAll((node) => (node.type as any) === 'Item' && node.props?.title === 'files.repositoryFolderLoadFailed'),
        ).toHaveLength(1);
    });

    it('pins a file when double-pressed', async () => {
        sessionListDirectorySpy.mockResolvedValue({
            success: true,
            entries: [{ name: 'README.md', type: 'file' }],
        });

        const onOpenFilePinned = vi.fn();
        const { screen, onOpenFile } = await renderRepositoryTreeList({ onOpenFilePinned });

        const readme = screen.findByTestId(repositoryTreeRowTestId('README.md'));
        expect(readme).toBeTruthy();
        expect(typeof readme?.props.onDoublePress).toBe('function');

        await act(async () => {
            readme?.props.onDoublePress();
        });

        expect(onOpenFilePinned).toHaveBeenCalledWith('README.md');
        expect(onOpenFile).not.toHaveBeenCalled();
    });

    it('routes file-row drag hover to the parent directory destination', async () => {
        sessionListDirectorySpy.mockImplementation(async (_sessionId: string, path: string) => {
            if (path !== '') return { success: true, entries: [] };
            return {
                success: true,
                entries: [
                    { name: 'src', type: 'directory' },
                    { name: 'README.md', type: 'file' },
                ],
            };
        });

        const onWebDropTargetChange = vi.fn();
        const { screen } = await renderRepositoryTreeList({ onWebDropTargetChange });

        const fileTarget = findDropTargetForTitle(screen, 'README.md');
        expect(fileTarget).toBeTruthy();

        await act(async () => {
            const stopPropagation = vi.fn();
            fileTarget?.props.onDragEnter({
                dataTransfer: { types: ['Files'] },
                stopPropagation,
            });
            expect(stopPropagation).not.toHaveBeenCalled();
        });

        expect(onWebDropTargetChange).toHaveBeenCalledWith({
            destinationDir: '',
            hoverPath: 'README.md',
            autoExpandDirectoryPath: null,
        });
    });

    it('marks a hovered collapsed directory for delayed auto-expand', async () => {
        sessionListDirectorySpy.mockImplementation(async (_sessionId: string, path: string) => {
            if (path === '') {
                return {
                    success: true,
                    entries: [{ name: 'src', type: 'directory' }],
                };
            }
            if (path === 'src') {
                return {
                    success: true,
                    entries: [{ name: 'a.ts', type: 'file' }],
                };
            }
            return { success: true, entries: [] };
        });

        const onWebDropTargetChange = vi.fn();
        const { screen } = await renderRepositoryTreeList({ onWebDropTargetChange });

        const directoryTarget = findDropTargetForTitle(screen, 'src/');
        expect(directoryTarget).toBeTruthy();

        await act(async () => {
            const stopPropagation = vi.fn();
            directoryTarget?.props.onDragEnter({
                dataTransfer: { types: ['Files'] },
                stopPropagation,
            });
            expect(stopPropagation).not.toHaveBeenCalled();
        });

        expect(onWebDropTargetChange).toHaveBeenCalledWith({
            destinationDir: 'src',
            hoverPath: 'src',
            autoExpandDirectoryPath: 'src',
        });
    });

    it('keeps the previous tree visible while reloading the root directory', async () => {
        const pending = (() => {
            let resolve: ((value: SessionListDirectoryLikeResponse) => void) | null = null;
            const promise = new Promise<SessionListDirectoryLikeResponse>((res) => {
                resolve = res;
            });
            return { promise, resolve: resolve! };
        })();

        let rootCalls = 0;
        sessionListDirectorySpy.mockImplementation(async (_sessionId: string, path: string) => {
            if (path !== '') return { success: true, entries: [] };
            rootCalls += 1;
            if (rootCalls === 1) {
                return {
                    success: true,
                    entries: [
                        { name: 'README.md', type: 'file' },
                        { name: 'src', type: 'directory' },
                    ],
                };
            }
            return pending.promise;
        });

        const { RepositoryTreeList } = await import('./RepositoryTreeList');

        function Wrapper() {
            const [expandedPaths, setExpandedPaths] = React.useState<string[]>([]);
            const [reloadToken, setReloadToken] = React.useState(0);
            return (
                <>
                    <RepositoryTreeList
                        theme={theme}
                        sessionId="session-1"
                        reloadToken={reloadToken}
                        expandedPaths={expandedPaths}
                        onExpandedPathsChange={setExpandedPaths}
                        onOpenFile={vi.fn()}
                    />
                    {React.createElement('Pressable' as any, {
                        testID: 'reload-root',
                        onPress: () => setReloadToken((value) => value + 1),
                    })}
                </>
            );
        }

        const screen = await renderScreen(<Wrapper />);
        await settleRepositoryTree();

        expect(findRepositoryRows(screen).map((row) => row.props.title)).toEqual(['src/', 'README.md']);

        await act(async () => {
            screen.pressByTestId('reload-root');
        });
        await settleRepositoryTree();

        expect(findRepositoryRows(screen).map((row) => row.props.title)).toEqual(['src/', 'README.md']);
        expect(screen.findAll((node) => (node.type as any) === 'ActivityIndicator').length).toBeGreaterThanOrEqual(1);

        await act(async () => {
            pending.resolve({
                success: true,
                entries: [{ name: 'src', type: 'directory' }],
            });
        });
        await settleRepositoryTree();

        expect(findRepositoryRows(screen).map((row) => row.props.title)).toEqual(['src/']);
    });
});
