import * as React from 'react';
import { act, ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {
    PromptAssetDiscoverResponseV1,
    PromptAssetListTypesResponseV1,
    PromptAssetReadResponseV1,
} from '@happier-dev/protocol';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import {
    installPromptAssetsCommonModuleMocks,
    promptAssetsRouterPushSpy,
} from './promptAssetsScreenTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machinePromptAssetsListTypesMock = vi.hoisted(() => vi.fn<() => Promise<PromptAssetListTypesResponseV1>>(async () => ({
    ok: true,
    types: [
        {
            id: 'agents.skill',
            providerId: 'agents',
            title: 'Agent skills (.agents)',
            description: 'Portable skill bundles',
            libraryKind: 'bundle',
            supportsScope: { user: true, project: true },
            supportsFiles: true,
            formatId: 'skill_md_v1',
            defaultRoots: [
                { label: 'User', scope: 'user', pathTemplate: '~/.agents/skills' },
                { label: 'Project', scope: 'project', pathTemplate: '.agents/skills' },
            ],
            capabilities: { supportsSymlinkInstall: true },
        },
    ],
})));
const machinePromptAssetsDiscoverMock = vi.hoisted(() => vi.fn<() => Promise<PromptAssetDiscoverResponseV1>>(async () => ({
    ok: true,
    items: [
        {
            assetTypeId: 'agents.skill',
            scope: 'project',
            externalRef: { name: 'refactor' },
            title: 'Refactor',
            libraryKind: 'bundle',
            bundleSchemaId: 'skills.skill_md_v1',
            digest: 'digest-1',
            displayPath: '/repo/.agents/skills/refactor',
        },
    ],
})));
const machinePromptAssetsDownloadMock = vi.hoisted(() => vi.fn<() => Promise<PromptAssetReadResponseV1>>(async () => ({
    ok: true,
    item: {
        assetTypeId: 'agents.skill',
        scope: 'project',
        externalRef: { name: 'refactor' },
        title: 'Refactor',
        libraryKind: 'bundle',
        bundleSchemaId: 'skills.skill_md_v1',
        digest: 'digest-1',
        displayPath: '/repo/.agents/skills/refactor',
        bundleBody: {
            v: 1,
            entries: [
                {
                    path: 'SKILL.md',
                    contentBase64: Buffer.from('# Refactor', 'utf8').toString('base64'),
                    contentKind: 'utf8',
                },
            ],
            createdAtMs: 1,
            updatedAtMs: 1,
        },
    },
})));
const machinePromptAssetsDeleteMock = vi.hoisted(() => vi.fn(async () => ({
    ok: true,
    externalRef: { name: 'refactor' },
    digest: 'digest-1',
    preview: {
        operation: 'delete',
        targetPath: '/repo/.agents/skills/refactor',
        fileCount: 1,
    },
})));
const createPromptBundleArtifactMock = vi.hoisted(() => vi.fn(async () => 'bundle-1'));
const createPromptDocMock = vi.hoisted(() => vi.fn(async () => 'doc-1'));
const upsertPromptExternalLinkMock = vi.hoisted(() => vi.fn((links: any, nextLink: any) => ({
    v: 1,
    links: [...((links?.links ?? []).filter((entry: any) => entry.id !== nextLink.id)), nextLink],
})));
const contextSelectionsState = vi.hoisted(() => ({
    value: { v: 1, selectionsByKey: {} as Record<string, { machineId?: string | null; workspacePath?: string | null }> },
}));
const setContextSelectionsMock = vi.hoisted(() => vi.fn());
const setPromptExternalLinksMock = vi.hoisted(() => vi.fn());
const promptExternalLinksState = vi.hoisted(() => ({
    value: { v: 1, links: [] as Array<Record<string, unknown>> },
}));
const machinesState = vi.hoisted(() => ({
    value: [
        {
            id: 'machine-1',
            metadata: {
                displayName: 'Laptop',
                host: 'laptop.local',
                homeDir: '/Users/test',
            },
        },
        {
            id: 'machine-2',
            metadata: {
                displayName: 'Desktop',
                host: 'desktop.local',
                homeDir: '/Users/desktop',
            },
        },
    ] as Array<{
        id: string;
        metadata: {
            displayName: string;
            host: string;
            homeDir: string;
        };
    }>,
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1000 },
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.rightElement ?? null),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: (props: any) => React.createElement('ItemRowActions', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/settings/contextBar/ContextBar', () => ({
    ContextBar: (props: any) => React.createElement('ContextBar', props),
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (action: any) => [false, React.useCallback(() => {
        void action();
    }, [action])],
}));

installPromptAssetsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            ScrollView: 'ScrollView',
            Platform: {
                OS: 'web',
                select: ({ web, default: defaultValue }: any) => web ?? defaultValue,
            },
        });
    },
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            useArtifacts: () => ([
                { id: 'bundle-1', title: 'Refactor', header: { kind: 'prompt_bundle.v2', title: 'Refactor' } },
                { id: 'doc-1', title: 'review/code', header: { kind: 'prompt_doc.v2', title: 'review/code' } },
            ]),
            useAllMachines: () => machinesState.value,
            useMachineListByServerId: () => ({}),
            useMachineListStatusByServerId: () => ({}),
            useSetting: (key: string) => {
                if (key === 'serverSelectionGroups') return [];
                if (key === 'promptExternalLinksV1') return promptExternalLinksState.value;
                return null;
            },
            useSettingMutable: (key: string) => {
                if (key === 'contextSelectionsV1') {
                    return [contextSelectionsState.value, setContextSelectionsMock];
                }
                if (key === 'promptExternalLinksV1') {
                    return [promptExternalLinksState.value, setPromptExternalLinksMock];
                }
                return [null, vi.fn()];
            },
        });
    },
});

vi.mock('@/sync/ops/machinePromptAssets', () => ({
    machinePromptAssetsDelete: machinePromptAssetsDeleteMock,
    machinePromptAssetsListTypes: machinePromptAssetsListTypesMock,
    machinePromptAssetsDiscover: machinePromptAssetsDiscoverMock,
    machinePromptAssetsDownload: machinePromptAssetsDownloadMock,
}));

vi.mock('@/sync/ops/promptLibrary/promptBundles', () => ({
    createPromptBundleArtifact: createPromptBundleArtifactMock,
}));

vi.mock('@/sync/ops/promptLibrary/promptDocs', () => {
    const removePromptExternalLink = (links: any, linkId: string) => ({
        v: 1,
        links: (links?.links ?? []).filter((entry: any) => entry.id !== linkId),
    });
    return {
        createPromptDoc: createPromptDocMock,
        upsertPromptExternalLink: upsertPromptExternalLinkMock,
        removePromptExternalLink,
    };
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/components/settings/server/hooks/usePrimaryMachineFromActiveSelection', () => ({
    usePrimaryMachineFromActiveSelection: () => machinesState.value[0]?.id ?? null,
}));

describe('PromptAssetsScreen', () => {
    beforeEach(() => {
        vi.resetModules();
        promptAssetsRouterPushSpy.mockReset();
        machinePromptAssetsListTypesMock.mockClear();
        machinePromptAssetsDiscoverMock.mockClear();
        machinePromptAssetsDownloadMock.mockClear();
        machinePromptAssetsDeleteMock.mockClear();
        createPromptBundleArtifactMock.mockClear();
        createPromptDocMock.mockClear();
        upsertPromptExternalLinkMock.mockClear();
        setContextSelectionsMock.mockReset();
        contextSelectionsState.value = { v: 1, selectionsByKey: {} };
        promptExternalLinksState.value = { v: 1, links: [] };
        machinesState.value = [
            {
                id: 'machine-1',
                metadata: {
                    displayName: 'Laptop',
                    host: 'laptop.local',
                    homeDir: '/Users/test',
                },
            },
            {
                id: 'machine-2',
                metadata: {
                    displayName: 'Desktop',
                    host: 'desktop.local',
                    homeDir: '/Users/desktop',
                },
            },
        ];
    });

    it('auto-loads external project skills on mount and imports them into the prompt library', async () => {
        contextSelectionsState.value = {
            v: 1,
            selectionsByKey: {
                'promptAssets.externalAssets': {
                    machineId: 'machine-1',
                    workspacePath: '/Users/test/repo',
                },
            },
        };
        const { PromptAssetsScreen } = await import('./PromptAssetsScreen');

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(React.createElement(PromptAssetsScreen))).tree;
        await act(async () => {});

        expect(machinePromptAssetsListTypesMock).toHaveBeenCalledWith('machine-1', undefined);
        expect(machinePromptAssetsDiscoverMock).toHaveBeenCalledWith(
            'machine-1',
            expect.objectContaining({ assetTypeId: 'agents.skill', scope: 'project', directory: '/Users/test/repo' }),
            undefined,
        );

        const importedItem = tree.findByTestId('promptAssets.item.project.agents.skill.0');
        expect(importedItem).toBeTruthy();

        await act(async () => {
            await pressTestInstanceAsync(importedItem);
        });

        expect(machinePromptAssetsDownloadMock).toHaveBeenCalledWith(
            'machine-1',
            expect.objectContaining({ assetTypeId: 'agents.skill', scope: 'project', externalRef: { name: 'refactor' }, directory: '/Users/test/repo' }),
            undefined,
        );
        expect(createPromptBundleArtifactMock).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Refactor',
            bundleSchemaId: 'skills.skill_md_v1',
            origin: 'imported',
        }));
        expect(setPromptExternalLinksMock).toHaveBeenCalledWith(expect.objectContaining({
            v: 1,
            links: [
                expect.objectContaining({
                    artifactId: 'bundle-1',
                    assetTypeId: 'agents.skill',
                    machineId: 'machine-1',
                    scope: 'project',
                    workspacePath: '/Users/test/repo',
                    externalRef: { name: 'refactor' },
                    syncMode: 'manual',
                    baseDigest: 'digest-1',
                    lastLibraryDigest: expect.any(String),
                    lastExternalDigest: 'digest-1',
                    lastSyncAtMs: expect.any(Number),
                }),
            ],
        }));
        expect(promptAssetsRouterPushSpy).toHaveBeenCalledWith('/settings/prompts/skills/bundle-1');
    });

    it('clears project-scoped discovery after the selected machine changes until a workspace path is chosen again', async () => {
        contextSelectionsState.value = {
            v: 1,
            selectionsByKey: {
                'promptAssets.externalAssets': {
                    machineId: 'machine-1',
                    workspacePath: '/Users/test/repo',
                },
            },
        };
        const { PromptAssetsScreen } = await import('./PromptAssetsScreen');

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(React.createElement(PromptAssetsScreen))).tree;
        await act(async () => {});

        const contextBar = tree.findByType('ContextBar' as any);
        expect(contextBar.props.machine.selectedId).toBe('machine-1');

        await act(async () => {
            contextBar.props.machine.onSelect('machine-2');
        });
        await act(async () => {});

        expect(machinePromptAssetsListTypesMock).toHaveBeenCalledWith('machine-2', undefined);
        expect(machinePromptAssetsDiscoverMock).not.toHaveBeenCalledWith(
            'machine-2',
            expect.anything(),
            undefined,
        );
    });

    it('passes machine browse config to the project directory context bar input', async () => {
        const { PromptAssetsScreen } = await import('./PromptAssetsScreen');

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(React.createElement(PromptAssetsScreen))).tree;
        await act(async () => {});

        const contextBar = tree.findByType('ContextBar' as any);
        expect(contextBar.props.workspace.browse).toEqual({
            machineId: 'machine-1',
            enabled: true,
        });
    });

    it('imports doc prompt assets into the prompt library as prompt docs', async () => {
        contextSelectionsState.value = {
            v: 1,
            selectionsByKey: {
                'promptAssets.externalAssets': {
                    machineId: 'machine-1',
                    workspacePath: '/Users/test/repo',
                },
            },
        };
        machinePromptAssetsListTypesMock.mockResolvedValueOnce({
            ok: true,
            types: [
                {
                    id: 'claude.command',
                    providerId: 'claude',
                    title: 'Claude commands (.claude)',
                    description: 'Markdown slash commands',
                    libraryKind: 'doc',
                    supportsScope: { user: true, project: true },
                    supportsFiles: false,
                    formatId: 'markdown_utf8_v1',
                    defaultRoots: [
                        { label: 'User', scope: 'user', pathTemplate: '~/.claude/commands' },
                        { label: 'Project', scope: 'project', pathTemplate: '.claude/commands' },
                    ],
                    capabilities: { supportsNestedNamespaces: true },
                },
            ],
        });
        machinePromptAssetsDiscoverMock.mockResolvedValueOnce({
            ok: true,
            items: [
                {
                    assetTypeId: 'claude.command',
                    scope: 'project',
                    externalRef: { relativePath: 'review/code.md' },
                    title: 'review/code',
                    libraryKind: 'doc',
                    digest: 'digest-doc',
                    displayPath: '/repo/.claude/commands/review/code.md',
                },
            ],
        });
        machinePromptAssetsDownloadMock.mockResolvedValueOnce({
            ok: true,
            item: {
                assetTypeId: 'claude.command',
                scope: 'project',
                externalRef: { relativePath: 'review/code.md' },
                title: 'review/code',
                libraryKind: 'doc',
                digest: 'digest-doc',
                displayPath: '/repo/.claude/commands/review/code.md',
                markdown: '# Review code\n\nUse $ARGUMENTS',
            },
        });

        const { PromptAssetsScreen } = await import('./PromptAssetsScreen');

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(React.createElement(PromptAssetsScreen))).tree;
        await act(async () => {});

        const importedItem = tree.findByTestId('promptAssets.item.project.claude.command.0');
        expect(importedItem).toBeTruthy();

        await act(async () => {
            await pressTestInstanceAsync(importedItem);
        });

        expect(createPromptDocMock).toHaveBeenCalledWith(expect.objectContaining({
            title: 'review/code',
            markdown: '# Review code\n\nUse $ARGUMENTS',
            origin: 'imported',
        }));
        expect(setPromptExternalLinksMock).toHaveBeenCalledWith(expect.objectContaining({
            v: 1,
            links: [
                expect.objectContaining({
                    artifactId: 'doc-1',
                    assetTypeId: 'claude.command',
                    machineId: 'machine-1',
                    scope: 'project',
                    workspacePath: '/Users/test/repo',
                    externalRef: { relativePath: 'review/code.md' },
                    syncMode: 'manual',
                    baseDigest: 'digest-doc',
                    lastLibraryDigest: expect.any(String),
                    lastExternalDigest: 'digest-doc',
                    lastSyncAtMs: expect.any(Number),
                }),
            ],
        }));
        expect(promptAssetsRouterPushSpy).toHaveBeenCalledWith('/settings/prompts/docs/doc-1');
    });

    it('uses the persisted context selection when refreshing external assets', async () => {
        contextSelectionsState.value = {
            v: 1,
            selectionsByKey: {
                'promptAssets.externalAssets': {
                    machineId: 'machine-2',
                    workspacePath: '/persisted/project',
                },
            },
        };

        const { PromptAssetsScreen } = await import('./PromptAssetsScreen');

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(React.createElement(PromptAssetsScreen))).tree;
        await act(async () => {});

        const refreshItem = tree.findByTestId('promptAssets.refresh');
        expect(refreshItem).toBeTruthy();

        await act(async () => {
            await pressTestInstanceAsync(refreshItem);
        });

        expect(machinePromptAssetsListTypesMock).toHaveBeenCalledWith('machine-2', undefined);
        expect(machinePromptAssetsDiscoverMock).toHaveBeenCalledWith(
            'machine-2',
            expect.objectContaining({
                assetTypeId: 'agents.skill',
                scope: 'project',
                directory: '/persisted/project',
            }),
            undefined,
        );
    });

    it('does not persist an empty context selection before machines are available', async () => {
        machinesState.value = [];

        const { PromptAssetsScreen } = await import('./PromptAssetsScreen');

        await renderScreen(React.createElement(PromptAssetsScreen));

        expect(setContextSelectionsMock).not.toHaveBeenCalled();
    });

    it('shows manage and delete actions for linked external assets', async () => {
        contextSelectionsState.value = {
            v: 1,
            selectionsByKey: {
                'promptAssets.externalAssets': {
                    machineId: 'machine-1',
                    workspacePath: '/Users/test/repo',
                },
            },
        };
        promptExternalLinksState.value = {
            v: 1,
            links: [
                {
                    id: 'link-1',
                    artifactId: 'bundle-1',
                    assetTypeId: 'agents.skill',
                    machineId: 'machine-1',
                    scope: 'project',
                    workspacePath: '/Users/test/repo',
                    externalRef: { name: 'refactor' },
                    lastExternalDigest: 'digest-1',
                },
            ],
        };

        const { PromptAssetsScreen } = await import('./PromptAssetsScreen');

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(React.createElement(PromptAssetsScreen))).tree;
        await act(async () => {});

        const actions = tree.findByType('ItemRowActions');
        expect(actions.props.actions.map((action: any) => action.id)).toEqual([
            'open',
            'manage',
            'delete',
        ]);
    });

    it('does not discover project-scoped assets until a workspace path is selected', async () => {
        const { PromptAssetsScreen } = await import('./PromptAssetsScreen');

        await renderScreen(React.createElement(PromptAssetsScreen));
        await act(async () => {});

        expect(machinePromptAssetsDiscoverMock).not.toHaveBeenCalled();
    });
});
