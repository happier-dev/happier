import * as React from 'react';
import { act, ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PromptRegistryListAdaptersResponseV1, PromptRegistryScanSourceResponseV1 } from '@happier-dev/protocol';
import type { PromptRegistrySkillImportResult } from '@/sync/ops/promptLibrary/promptRegistrySkillImports';
import { createModalModuleMock } from '@/dev/testkit/mocks/modal';
import { createPartialStorageModuleMock } from '@/dev/testkit/mocks/storage';
import { changeTextTestInstance, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import {
    installPromptRegistriesCommonModuleMocks,
    promptRegistriesRouterPushSpy,
} from './promptRegistriesScreenTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setRegistrySourcesMock = vi.fn();
const modalAlertSpy = vi.hoisted(() => vi.fn());
const machinePromptRegistriesListSourcesMock = vi.hoisted(() => vi.fn(async () => ({
    ok: true,
    sources: [
        {
            id: 'git:local-skills',
            adapterId: 'git',
            title: 'Local skills repo',
            subtitle: '/tmp/skills',
            origin: 'user',
        },
    ],
})));
const machinePromptRegistriesListAdaptersMock = vi.hoisted(() => vi.fn<() => Promise<PromptRegistryListAdaptersResponseV1>>(async () => ({
    ok: true,
    adapters: [
        {
            id: 'git',
            title: 'Git repositories',
            description: 'Scan SKILL.md bundles from Git repositories.',
            supportsConfiguredSources: true,
            supportsQuery: true,
        },
        {
            id: 'skills_sh',
            title: 'skills.sh',
            description: 'Curated skills registry backed by the Vercel skills ecosystem.',
            supportsConfiguredSources: false,
            supportsQuery: true,
            minimumQueryLength: 2,
        },
    ],
})));
const machinePromptRegistriesScanSourceMock = vi.hoisted(() => vi.fn(async (_machineId: string, _payload: { query?: string }) => ({
    ok: true,
    items: [
        {
            sourceId: 'git:local-skills',
            itemId: 'git:local-skills:reviewer',
            title: 'reviewer',
            description: 'Code review helper',
            bundleSchemaId: 'skills.skill_md_v1',
            displayPath: 'reviewer',
            providerHints: ['agents.skill'],
        },
    ],
})));
const importPromptRegistrySkillItemMock = vi.hoisted(() => vi.fn<() => Promise<PromptRegistrySkillImportResult>>(async () => ({ ok: true as const, artifactId: 'bundle-1' })));
const contextSelectionsState = vi.hoisted(() => ({
    value: { v: 1, selectionsByKey: {} as Record<string, { machineId?: string | null; workspacePath?: string | null }> },
}));
const setContextSelectionsMock = vi.hoisted(() => vi.fn());
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

installPromptRegistriesCommonModuleMocks({
    modal: async () => createModalModuleMock({
        spies: {
            alert: modalAlertSpy,
            confirm: vi.fn(async () => true),
        },
    }).module,
    storage: async (importOriginal) => createPartialStorageModuleMock(importOriginal, {
        useAllMachines: () => machinesState.value,
        useSettingMutable: (key: string) => {
            if (key === 'promptRegistrySourcesV1') {
                return [{ v: 1, sources: [] }, setRegistrySourcesMock];
            }
            if (key === 'contextSelectionsV1') {
                return [contextSelectionsState.value, setContextSelectionsMock];
            }
            return [null, vi.fn()];
        },
    }),
});

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1000 },
}));

vi.mock('@/components/settings/contextBar/ContextBar', () => ({
    ContextBar: (props: any) => React.createElement('ContextBar', props),
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: (props: any) => React.createElement('ItemRowActions', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/forms/InlineAddExpander', () => ({
    InlineAddExpander: (props: any) => React.createElement('InlineAddExpander', props, props.children),
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (action: any) => [false, React.useCallback(async () => {
        await action();
    }, [action])],
}));

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'registry-source-1',
}));

vi.mock('@/components/settings/server/hooks/usePrimaryMachineFromActiveSelection', () => ({
    usePrimaryMachineFromActiveSelection: () => machinesState.value[0]?.id ?? null,
}));

vi.mock('@/sync/ops/machinePromptRegistries', () => ({
    machinePromptRegistriesListAdapters: machinePromptRegistriesListAdaptersMock,
    machinePromptRegistriesListSources: machinePromptRegistriesListSourcesMock,
    machinePromptRegistriesScanSource: machinePromptRegistriesScanSourceMock,
}));

vi.mock('@/sync/ops/promptLibrary/promptRegistrySkillImports', () => ({
    importPromptRegistrySkillItem: importPromptRegistrySkillItemMock,
}));

describe('PromptRegistriesScreen', () => {
    beforeEach(() => {
        vi.resetModules();
        promptRegistriesRouterPushSpy.mockReset();
        setRegistrySourcesMock.mockReset();
        machinePromptRegistriesListSourcesMock.mockReset();
        machinePromptRegistriesListSourcesMock.mockResolvedValue({
            ok: true,
            sources: [
                {
                    id: 'git:local-skills',
                    adapterId: 'git',
                    title: 'Local skills repo',
                    subtitle: '/tmp/skills',
                    origin: 'user',
                },
            ],
        });
        machinePromptRegistriesListAdaptersMock.mockReset();
        machinePromptRegistriesListAdaptersMock.mockResolvedValue({
            ok: true,
            adapters: [
                {
                    id: 'git',
                    title: 'Git repositories',
                    description: 'Scan SKILL.md bundles from Git repositories.',
                    supportsConfiguredSources: true,
                    supportsQuery: true,
                },
                {
                    id: 'skills_sh',
                    title: 'skills.sh',
                    description: 'Curated skills registry backed by the Vercel skills ecosystem.',
                    supportsConfiguredSources: false,
                    supportsQuery: true,
                    minimumQueryLength: 2,
                },
            ],
        });
        machinePromptRegistriesScanSourceMock.mockReset();
        machinePromptRegistriesScanSourceMock.mockResolvedValue({
            ok: true,
            items: [
                {
                    sourceId: 'git:local-skills',
                    itemId: 'git:local-skills:reviewer',
                    title: 'reviewer',
                    description: 'Code review helper',
                    bundleSchemaId: 'skills.skill_md_v1',
                    displayPath: 'reviewer',
                    providerHints: ['agents.skill'],
                },
            ],
        });
        importPromptRegistrySkillItemMock.mockClear();
        modalAlertSpy.mockReset();
        contextSelectionsState.value = { v: 1, selectionsByKey: {} };
        setContextSelectionsMock.mockReset();
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

    it('auto-loads sources on mount, opens registry item details, and imports registry items from row actions', async () => {
        const { PromptRegistriesScreen } = await import('./PromptRegistriesScreen');

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(React.createElement(PromptRegistriesScreen))).tree;
        await act(async () => {});

        expect(machinePromptRegistriesListAdaptersMock).toHaveBeenCalledWith('machine-1');
        expect(machinePromptRegistriesListSourcesMock).toHaveBeenCalledWith(
            'machine-1',
            expect.objectContaining({
                configuredSources: expect.any(Array),
            }),
        );
        expect(machinePromptRegistriesScanSourceMock).toHaveBeenCalledWith(
            'machine-1',
            expect.objectContaining({
                sourceId: 'git:local-skills',
            }),
        );

        const addSourceExpander = tree.findByType('InlineAddExpander');
        expect(addSourceExpander.props?.title).toBe('promptLibrary.registriesAddGitSource');
        expect(addSourceExpander.props?.triggerTestID).toBe('promptRegistries.addGitSource');

        await act(async () => {
            addSourceExpander.props?.onOpenChange?.(true);
        });

        const sourceTitleInput = tree.findByTestId('promptRegistries.sourceTitle');
        const sourceUrlInput = tree.findByTestId('promptRegistries.sourceUrl');
        expect(sourceTitleInput).toBeTruthy();
        expect(sourceUrlInput).toBeTruthy();

        await act(async () => {
            sourceTitleInput?.props?.onChangeText?.('Local skills repo');
            sourceUrlInput?.props?.onChangeText?.('/tmp/skills');
        });

        await act(async () => {
            addSourceExpander.props?.onSave?.();
        });

        expect(setRegistrySourcesMock).toHaveBeenCalledWith({
            v: 1,
            sources: [
                {
                    id: 'registry-source-1',
                    adapterId: 'git',
                    title: 'Local skills repo',
                    enabled: true,
                    config: {
                        repositoryUrl: '/tmp/skills',
                    },
                },
            ],
        });

        const sourceItem = tree.findByTestId('promptRegistries.source.0');
        expect(sourceItem).toBeTruthy();

        await act(async () => {
            await pressTestInstanceAsync(sourceItem);
        });

        expect(machinePromptRegistriesScanSourceMock).toHaveBeenCalledWith(
            'machine-1',
            expect.objectContaining({
                sourceId: 'git:local-skills',
            }),
        );

        const registryItem = tree.findByTestId('promptRegistries.item.0');
        expect(registryItem).toBeTruthy();
        await act(async () => {
            await pressTestInstanceAsync(registryItem);
        });

        expect(promptRegistriesRouterPushSpy).toHaveBeenCalledWith(expect.stringContaining('/settings/prompts/registries/item?'));
        expect(promptRegistriesRouterPushSpy).toHaveBeenCalledWith(expect.stringContaining('machineId=machine-1'));
        expect(promptRegistriesRouterPushSpy).toHaveBeenCalledWith(expect.stringContaining('sourceId=git%3Alocal-skills'));
        expect(promptRegistriesRouterPushSpy).toHaveBeenCalledWith(expect.stringContaining('itemId=git%3Alocal-skills%3Areviewer'));

        const rowActions = registryItem?.props?.rightElement;
        expect(rowActions).toBeTruthy();
        const importAction = rowActions?.props?.actions?.find((action: { id: string }) => action.id === 'import');
        expect(importAction).toBeTruthy();

        await act(async () => {
            importAction?.onPress?.();
        });

        expect(importPromptRegistrySkillItemMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            sourceId: 'git:local-skills',
            itemId: 'git:local-skills:reviewer',
        }));
        expect(promptRegistriesRouterPushSpy).toHaveBeenCalledWith('/settings/prompts/skills/bundle-1');
    });

    it('passes the search query through when rescanning the selected source', async () => {
        const { PromptRegistriesScreen } = await import('./PromptRegistriesScreen');

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(React.createElement(PromptRegistriesScreen))).tree;
        await act(async () => {});

        machinePromptRegistriesScanSourceMock.mockClear();
        const searchInput = tree.findByTestId('promptRegistries.searchQuery');
        expect(searchInput).toBeTruthy();

        await act(async () => {
            changeTextTestInstance(searchInput, 'design');
        });
        await act(async () => {});
        await act(async () => {
            await searchInput?.props?.onSubmitEditing?.();
        });

        expect(machinePromptRegistriesScanSourceMock.mock.calls).toContainEqual([
            'machine-1',
            expect.objectContaining({
                sourceId: 'git:local-skills',
                query: 'design',
            }),
        ]);
    });

    it('does not rescan when the selected adapter requires a longer query', async () => {
        machinePromptRegistriesListSourcesMock.mockResolvedValueOnce({
            ok: true,
            sources: [
                {
                    id: 'skills_sh:featured',
                    adapterId: 'skills_sh',
                    title: 'skills.sh',
                    subtitle: 'Top skills',
                    origin: 'built_in',
                },
            ],
        });

        const { PromptRegistriesScreen } = await import('./PromptRegistriesScreen');

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(React.createElement(PromptRegistriesScreen))).tree;
        await act(async () => {});

        machinePromptRegistriesListSourcesMock.mockClear();
        machinePromptRegistriesScanSourceMock.mockClear();

        const searchInput = tree.findByTestId('promptRegistries.searchQuery');
        expect(searchInput).toBeTruthy();

        await act(async () => {
            searchInput?.props?.onChangeText?.('u');
            searchInput?.props?.onSubmitEditing?.();
        });

        expect(machinePromptRegistriesScanSourceMock.mock.calls).not.toContainEqual([
            'machine-1',
            expect.objectContaining({
                sourceId: 'skills_sh:featured',
                query: 'u',
            }),
        ]);
        expect(machinePromptRegistriesListSourcesMock).not.toHaveBeenCalled();
    });

    it('does not refresh registry sources while the user is typing a search query', async () => {
        machinePromptRegistriesListSourcesMock.mockResolvedValueOnce({
            ok: true,
            sources: [
                {
                    id: 'skills_sh:featured',
                    adapterId: 'skills_sh',
                    title: 'skills.sh',
                    subtitle: 'Top skills',
                    origin: 'built_in',
                },
            ],
        });

        const { PromptRegistriesScreen } = await import('./PromptRegistriesScreen');

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(React.createElement(PromptRegistriesScreen))).tree;
        await act(async () => {});

        machinePromptRegistriesListSourcesMock.mockClear();
        machinePromptRegistriesScanSourceMock.mockClear();

        const searchInput = tree.findByTestId('promptRegistries.searchQuery');
        expect(searchInput).toBeTruthy();

        await act(async () => {
            changeTextTestInstance(searchInput, 'ux');
        });

        expect(machinePromptRegistriesListSourcesMock).not.toHaveBeenCalled();
        expect(machinePromptRegistriesScanSourceMock).not.toHaveBeenCalled();
    });

    it('ignores stale search failures once a newer search succeeds', async () => {
        machinePromptRegistriesListSourcesMock.mockResolvedValueOnce({
            ok: true,
            sources: [
                {
                    id: 'skills_sh:featured',
                    adapterId: 'skills_sh',
                    title: 'skills.sh',
                    subtitle: 'Top skills',
                    origin: 'built_in',
                },
            ],
        });

        const shortQuerySearch = createDeferred<PromptRegistryScanSourceResponseV1>();
        const validQuerySearch = createDeferred<PromptRegistryScanSourceResponseV1>();
        (machinePromptRegistriesScanSourceMock as any).mockImplementation(async (_machineId: string, payload: { query?: string }) => {
            if (payload.query === 'u') return await shortQuerySearch.promise;
            if (payload.query === 'ux') return await validQuerySearch.promise;
            return {
                ok: true,
                items: [],
            } as PromptRegistryScanSourceResponseV1;
        });

        const { PromptRegistriesScreen } = await import('./PromptRegistriesScreen');

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(React.createElement(PromptRegistriesScreen))).tree;
        await act(async () => {});

        machinePromptRegistriesScanSourceMock.mockClear();
        modalAlertSpy.mockClear();

        const searchInput = tree.findByTestId('promptRegistries.searchQuery');
        expect(searchInput).toBeTruthy();

        await act(async () => {
            changeTextTestInstance(searchInput, 'u');
        });
        await act(async () => {});
        let firstSubmit: Promise<void> | undefined;
        await act(async () => {
            firstSubmit = searchInput?.props?.onSubmitEditing?.();
        });
        await act(async () => {});

        await act(async () => {
            changeTextTestInstance(searchInput, 'ux');
        });
        await act(async () => {});
        let secondSubmit: Promise<void> | undefined;
        await act(async () => {
            secondSubmit = searchInput?.props?.onSubmitEditing?.();
        });

        await act(async () => {
            validQuerySearch.resolve({
                ok: true,
                items: [
                    {
                        sourceId: 'skills_sh:featured',
                        itemId: 'skills_sh:featured:ux-skill',
                        title: 'ux-skill',
                        description: 'UX helper',
                        bundleSchemaId: 'skills.skill_md_v1',
                        displayPath: 'owner/repo/ux-skill',
                    },
                ],
            });
            await secondSubmit;
        });

        await act(async () => {
            shortQuerySearch.resolve({
                ok: false,
                errorCode: 'invalid_request',
                error: 'Query must be at least 2 characters',
            });
            await firstSubmit;
        });

        expect(modalAlertSpy).not.toHaveBeenCalled();
        const registryItem = tree.findByTestId('promptRegistries.item.0');
        expect(registryItem?.props?.title).toBe('ux-skill');
    });

    it('renders the registry search input without a separate field label', async () => {
        const { PromptRegistriesScreen } = await import('./PromptRegistriesScreen');

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(React.createElement(PromptRegistriesScreen))).tree;
        await act(async () => {});

        const searchInput = tree.findByTestId('promptRegistries.searchQuery');
        expect(searchInput).toBeTruthy();

        const textNodes = tree.findAllByType('Text');
        expect(textNodes.some((node) => node.props?.children === 'promptLibrary.registriesSearchLabel')).toBe(false);
    });

    it('rejects non-skill registry bundles instead of routing them into the skill editor', async () => {
        machinePromptRegistriesScanSourceMock.mockResolvedValueOnce({
            ok: true,
            items: [
                {
                    sourceId: 'git:local-skills',
                    itemId: 'git:local-skills:bundle',
                    title: 'shared prompts',
                    description: 'Generic prompt bundle',
                    bundleSchemaId: 'bundle.generic_v1',
                    displayPath: 'shared/prompts',
                    providerHints: [],
                },
            ],
        });
        importPromptRegistrySkillItemMock.mockResolvedValueOnce({
            ok: false,
            error: 'promptLibrary.externalAssetsUnsupportedImport',
        });

        const { PromptRegistriesScreen } = await import('./PromptRegistriesScreen');

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(React.createElement(PromptRegistriesScreen))).tree;
        await act(async () => {});

        const sourceItem = tree.findByTestId('promptRegistries.source.0');
        expect(sourceItem).toBeTruthy();
        await act(async () => {
            await pressTestInstanceAsync(sourceItem);
        });

        const registryItem = tree.findByTestId('promptRegistries.item.0');
        expect(registryItem).toBeTruthy();
        const rowActions = registryItem?.props?.rightElement;
        const importAction = rowActions?.props?.actions?.find((action: { id: string }) => action.id === 'import');
        await act(async () => {
            importAction?.onPress?.();
        });

        expect(importPromptRegistrySkillItemMock).toHaveBeenCalled();
        expect(promptRegistriesRouterPushSpy).not.toHaveBeenCalledWith('/settings/prompts/skills/bundle-1');
        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'promptLibrary.externalAssetsUnsupportedImport');
    });

    it('uses the persisted machine selection when auto-loading registry sources', async () => {
        contextSelectionsState.value = {
            v: 1,
            selectionsByKey: {
                'promptRegistries.browse': {
                    machineId: 'machine-2',
                },
            },
        };

        const { PromptRegistriesScreen } = await import('./PromptRegistriesScreen');

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(React.createElement(PromptRegistriesScreen))).tree;
        await act(async () => {});

        expect(machinePromptRegistriesListSourcesMock).toHaveBeenCalledWith(
            'machine-2',
            expect.objectContaining({
                configuredSources: expect.any(Array),
            }),
        );
    });

    it('re-loads registry sources when the selected machine changes', async () => {
        const { PromptRegistriesScreen } = await import('./PromptRegistriesScreen');

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(React.createElement(PromptRegistriesScreen))).tree;
        await act(async () => {});

        const contextBar = tree.findByType('ContextBar' as any);
        expect(contextBar.props.machine.selectedId).toBe('machine-1');

        await act(async () => {
            contextBar.props.machine.onSelect('machine-2');
        });
        await act(async () => {});

        expect(machinePromptRegistriesListSourcesMock).toHaveBeenCalledWith(
            'machine-2',
            expect.objectContaining({
                configuredSources: expect.any(Array),
            }),
        );
    });

    it('does not persist an empty machine selection before machines are available', async () => {
        machinesState.value = [];

        const { PromptRegistriesScreen } = await import('./PromptRegistriesScreen');

        await renderScreen(React.createElement(PromptRegistriesScreen));

        expect(setContextSelectionsMock).not.toHaveBeenCalled();
    });
});
