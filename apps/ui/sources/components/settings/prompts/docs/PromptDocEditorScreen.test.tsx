import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerBackSpy = vi.fn();
const routerReplaceSpy = vi.fn();
const routerPushSpy = vi.fn();
const updatePromptDocSpy = vi.fn(async () => {});
const setPromptFoldersSpy = vi.fn();
const promptExternalLinksState = vi.hoisted(() => ({
    value: {
        v: 1,
        links: [
            {
                id: 'link-1',
                artifactId: 'doc-1',
                assetTypeId: 'claude.command',
                machineId: 'machine-1',
                scope: 'user',
                workspacePath: null,
                externalRef: { relativePath: 'review/code.md' },
                lastExternalDigest: 'digest-1',
            },
        ],
    },
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                            View: 'View',
                                            TextInput: 'TextInput',
                                            ScrollView: 'ScrollView',
                                            Platform: {
                                                OS: 'web',
                                                select: ({ web, default: defaultValue }: any) => web ?? defaultValue,
                                            },
                                        }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const routerMock = createExpoRouterMock({
        router: {
        back: routerBackSpy,
        replace: routerReplaceSpy,
        push: routerPushSpy,
    },
        navigation: { canGoBack: () => false },
    });
    return routerMock.module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 960 },
}));

vi.mock('@/components/ui/code/editor/CodeEditor', () => ({
    CodeEditor: (props: any) => React.createElement('CodeEditor', props),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: (props: any) => React.createElement('ItemRowActions', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/components/ui/settingsSurface/SettingsActionFooter', () => ({
    SettingsActionFooter: (props: any) => React.createElement('SettingsActionFooter', props),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('@/sync/sync', () => ({
    sync: {
        getCredentials: () => ({ ok: true }),
        fetchArtifactWithBody: vi.fn(async () => null),
    },
}));

vi.mock('@/sync/ops/promptLibrary/promptDocs', () => ({
    createPromptDoc: vi.fn(async () => 'new-doc'),
    updatePromptDoc: updatePromptDocSpy,
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    useAllMachines: () => ([
        {
            id: 'machine-1',
            metadata: {
                displayName: 'Laptop',
                host: 'laptop.local',
            },
        },
    ]),
    useSetting: (key: string) => {
        if (key === 'promptExternalLinksV1') return promptExternalLinksState.value;
        return null;
    },
    useSettingMutable: (key: string) => {
        if (key === 'promptFoldersV1') {
            return [{
                v: 1,
                folders: [
                    { id: 'folder-1', name: 'Ops', parentId: null },
                ],
            }, setPromptFoldersSpy];
        }
        return [null, vi.fn()];
    },
    storage: {
        getState: () => ({
            artifacts: {
                'doc-1': {
                    id: 'doc-1',
                    header: { title: 'Doc title', folderId: 'folder-1', tags: ['alpha', 'beta'] },
                    body: JSON.stringify({
                        v: 1,
                        markdown: 'existing markdown',
                        createdAtMs: 1,
                        updatedAtMs: 2,
                    }),
                },
            },
            updateArtifact: vi.fn(),
        }),
    },
});
});

describe('PromptDocEditorScreen', () => {
    beforeEach(() => {
        routerBackSpy.mockReset();
        routerReplaceSpy.mockReset();
        routerPushSpy.mockReset();
        updatePromptDocSpy.mockClear();
        setPromptFoldersSpy.mockClear();
    });

    it('falls back to the docs list when saving from a deep-linked editor without back history', async () => {
        const { PromptDocEditorScreen } = await import('./PromptDocEditorScreen');
        const screen = await renderScreen(React.createElement(PromptDocEditorScreen, { artifactId: 'doc-1' }));
        const footer = screen.findByType('SettingsActionFooter');

        await act(async () => {
            footer.props.onPrimaryPress();
        });

        expect(updatePromptDocSpy).toHaveBeenCalledWith({
            artifactId: 'doc-1',
            title: 'Doc title',
            markdown: 'existing markdown',
            folderId: 'folder-1',
            tags: ['alpha', 'beta'],
        });
        expect(routerReplaceSpy).toHaveBeenCalledWith('/settings/prompts/docs');
        expect(routerBackSpy).not.toHaveBeenCalled();
    });

    it('navigates to the external export screen for an existing prompt doc', async () => {
        const { PromptDocEditorScreen } = await import('./PromptDocEditorScreen');
        const screen = await renderScreen(React.createElement(PromptDocEditorScreen, { artifactId: 'doc-1' }));

        await screen.pressByTestIdAsync('promptDoc.manageExternalAssets');

        expect(routerPushSpy).toHaveBeenCalledWith('/(app)/settings/prompts/docs/doc-1/export');
    });

    it('renders linked exports and a settings footer for existing docs', async () => {
        const { PromptDocEditorScreen } = await import('./PromptDocEditorScreen');
        const screen = await renderScreen(React.createElement(PromptDocEditorScreen, { artifactId: 'doc-1' }));
        const footer = screen.findByType('SettingsActionFooter');

        expect(screen.findByTestId('promptDoc.link.0')?.props.subtitle).toContain('Laptop');
        expect(screen.findByTestId('promptDoc.folderName')?.props.value).toBe('Ops');
        expect(screen.findByTestId('promptDoc.tags')?.props.value).toBe('alpha, beta');
        expect(footer.props.primaryTestID).toBe('promptDoc.save');
        expect(footer.props.secondaryTestID).toBe('promptDoc.cancel');
    });

    it('renders a title input, markdown editor, and save action for new docs', async () => {
        const { PromptDocEditorScreen } = await import('./PromptDocEditorScreen');
        const screen = await renderScreen(React.createElement(PromptDocEditorScreen, { artifactId: null }));
        const footer = screen.findByType('SettingsActionFooter');

        expect(screen.findByTestId('promptDoc.title')).toBeTruthy();
        expect(screen.findByTestId('promptDoc.editor')).toBeTruthy();
        expect(screen.findByTestId('promptDoc.folderName')).toBeTruthy();
        expect(screen.findByTestId('promptDoc.tags')).toBeTruthy();
        expect(footer.props.primaryTestID).toBe('promptDoc.save');
        expect(screen.findAllByTestId('promptDoc.manageExternalAssets')).toHaveLength(0);
    });
});
