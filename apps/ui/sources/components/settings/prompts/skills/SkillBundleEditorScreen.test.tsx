import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerBackSpy = vi.fn();
const routerReplaceSpy = vi.fn();
const routerPushSpy = vi.fn();
const createSkillPromptBundleSpy = vi.fn(async () => 'new-bundle');
const updateSkillPromptBundleSpy = vi.fn(async () => {});
const setPromptFoldersSpy = vi.fn();
let latestFocusEffect: (() => void) | undefined;
const promptExternalLinksState = vi.hoisted(() => ({
    value: {
        v: 1,
        links: [
            {
                id: 'link-1',
                artifactId: 'bundle-1',
                assetTypeId: 'agents.skill',
                machineId: 'machine-1',
                scope: 'project',
                workspacePath: '/Users/test/project',
                externalRef: { skillName: 'reviewer' },
                lastExternalDigest: 'digest-1',
            },
        ],
    },
}));
const artifactBodiesState = vi.hoisted(() => ({
    value: {
        'bundle-1': {
            id: 'bundle-1',
            header: { title: 'Skill title' },
            body: JSON.stringify({
                v: 1,
                entries: [
                    {
                        path: 'SKILL.md',
                        contentBase64: Buffer.from('---\\nname: skill\\n---\\nHello skill').toString('base64'),
                        contentKind: 'utf8',
                    },
                    {
                        path: 'templates/review.md',
                        contentBase64: Buffer.from('review template').toString('base64'),
                        contentKind: 'utf8',
                    },
                ],
                createdAtMs: 1,
                updatedAtMs: 2,
            }),
        },
    } as Record<string, unknown>,
}));

vi.mock('react-native', () => ({
    View: 'View',
    TextInput: 'TextInput',
    ScrollView: 'ScrollView',
    Platform: { OS: 'web', select: ({ web, default: defaultValue }: any) => web ?? defaultValue },
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: any) =>
            factory({
                colors: {
                    groupped: { background: '#000' },
                    input: { background: '#111', text: '#fff', placeholder: '#777' },
                    divider: '#333',
                    accent: { blue: '#00f' },
                    textSecondary: '#999',
                },
            }),
    },
    useUnistyles: () => ({
        theme: {
            colors: {
                input: { placeholder: '#777' },
                accent: { blue: '#00f' },
                textSecondary: '#999',
            },
        },
    }),
}));

vi.mock('expo-router', () => ({
    Stack: { Screen: 'StackScreen' },
    useNavigation: () => ({ canGoBack: () => false }),
    useRouter: () => ({
        back: routerBackSpy,
        replace: routerReplaceSpy,
        push: routerPushSpy,
    }),
}));

vi.mock('@react-navigation/native', () => ({
    useFocusEffect: (callback: () => void) => {
        latestFocusEffect = callback;
        React.useEffect(() => {
            callback();
        }, [callback]);
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

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

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn() },
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        getCredentials: () => ({ ok: true }),
        fetchArtifactWithBody: vi.fn(async () => null),
    },
}));

vi.mock('@/sync/ops/promptLibrary/promptBundles', () => ({
    DEFAULT_SKILL_PROMPT_MARKDOWN: `---
name: skill
description: Describe when this skill should be used.
---

## When to use
- Explain the situations where this skill applies.

## Instructions
1. Add the exact steps this skill should follow.
`,
    createSkillPromptBundle: createSkillPromptBundleSpy,
    hasSkillPromptMarkdownContent: (value: string) => value.trim().length > 0,
    listPromptBundleSupportingEntries: (body: any) => Array.isArray(body?.entries)
        ? body.entries.filter((item: any) => item?.path !== 'SKILL.md')
        : [],
    removeSkillPromptBundleEntry: vi.fn(async () => {}),
    readSkillMarkdownFromPromptBundleBody: (body: any) => {
        const entry = Array.isArray(body?.entries)
            ? body.entries.find((item: any) => item?.path === 'SKILL.md')
            : null;
        return entry ? Buffer.from(entry.contentBase64, 'base64').toString('utf8') : null;
    },
    updateSkillPromptBundle: updateSkillPromptBundleSpy,
}));

vi.mock('@/sync/domains/state/storage', () => ({
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
            artifacts: artifactBodiesState.value,
            updateArtifact: vi.fn(),
        }),
    },
}));

describe('SkillBundleEditorScreen', () => {
    beforeEach(() => {
        routerBackSpy.mockReset();
        routerReplaceSpy.mockReset();
        routerPushSpy.mockReset();
        createSkillPromptBundleSpy.mockClear();
        updateSkillPromptBundleSpy.mockClear();
        setPromptFoldersSpy.mockClear();
        latestFocusEffect = undefined;
        artifactBodiesState.value = {
            'bundle-1': {
                id: 'bundle-1',
                header: { title: 'Skill title', folderId: 'folder-1', tags: ['alpha'] },
                body: JSON.stringify({
                    v: 1,
                    entries: [
                        {
                            path: 'SKILL.md',
                            contentBase64: Buffer.from('---\\nname: skill\\n---\\nHello skill').toString('base64'),
                            contentKind: 'utf8',
                        },
                        {
                            path: 'templates/review.md',
                            contentBase64: Buffer.from('review template').toString('base64'),
                            contentKind: 'utf8',
                        },
                    ],
                    createdAtMs: 1,
                    updatedAtMs: 2,
                }),
            },
        };
    });

    it('falls back to the skills list when saving from a deep-linked skill editor without back history', async () => {
        const { SkillBundleEditorScreen } = await import('./SkillBundleEditorScreen');
        let tree!: ReactTestRenderer;

        await act(async () => {
            tree = renderer.create(React.createElement(SkillBundleEditorScreen, { artifactId: 'bundle-1' }));
            await Promise.resolve();
        });

        const saveFooter = tree.root.findByType('SettingsActionFooter');

        await act(async () => {
            await saveFooter.props.onPrimaryPress();
        });

        expect(updateSkillPromptBundleSpy).toHaveBeenCalledWith({
            artifactId: 'bundle-1',
            title: 'Skill title',
            skillMarkdown: '---\\nname: skill\\n---\\nHello skill',
            folderId: 'folder-1',
            tags: ['alpha'],
        });
        expect(routerReplaceSpy).toHaveBeenCalledWith('/settings/prompts/skills');
        expect(routerBackSpy).not.toHaveBeenCalled();
    });

    it('navigates to the external export screen for an existing skill bundle', async () => {
        const { SkillBundleEditorScreen } = await import('./SkillBundleEditorScreen');
        let tree!: ReactTestRenderer;

        await act(async () => {
            tree = renderer.create(React.createElement(SkillBundleEditorScreen, { artifactId: 'bundle-1' }));
            await Promise.resolve();
        });

        const manageItem = tree.root.findByProps({ testID: 'skillBundle.manageExternalAssets' });
        await act(async () => {
            manageItem.props.onPress();
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/(app)/settings/prompts/skills/bundle-1/export');
    });

    it('starts new skills with starter markdown and saves it when only the title changes', async () => {
        const { SkillBundleEditorScreen } = await import('./SkillBundleEditorScreen');
        let tree!: ReactTestRenderer;

        await act(async () => {
            tree = renderer.create(React.createElement(SkillBundleEditorScreen, { artifactId: null }));
            await Promise.resolve();
        });

        const editor = tree.root.findByProps({ testID: 'skillBundle.editor' });
        expect(editor.props.value).toContain('## When to use');

        const titleInput = tree.root.findByProps({ testID: 'skillBundle.title' });
        await act(async () => {
            titleInput.props.onChangeText('New skill');
        });

        const saveButton = tree.root.findByType('SettingsActionFooter');
        await act(async () => {
            await saveButton.props.onPrimaryPress();
        });

        expect(createSkillPromptBundleSpy).toHaveBeenCalledWith({
            title: 'New skill',
            skillMarkdown: expect.stringContaining('## Instructions'),
            folderId: null,
            tags: [],
        });
        expect(routerReplaceSpy).toHaveBeenCalledWith('/settings/prompts/skills');
    });

    it('renders linked exports and a settings footer for existing skills', async () => {
        const { SkillBundleEditorScreen } = await import('./SkillBundleEditorScreen');
        let tree!: ReactTestRenderer;

        await act(async () => {
            tree = renderer.create(React.createElement(SkillBundleEditorScreen, { artifactId: 'bundle-1' }));
            await Promise.resolve();
        });

        expect(tree.root.findByProps({ testID: 'skillBundle.link.0' }).props.subtitle).toContain('Laptop');
        expect(tree.root.findByProps({ testID: 'skillBundle.folderName' }).props.value).toBe('Ops');
        expect(tree.root.findByProps({ testID: 'skillBundle.tags' }).props.value).toBe('alpha');

        const footer = tree.root.findByType('SettingsActionFooter');
        expect(footer.props.primaryTestID).toBe('skillBundle.save');
        expect(footer.props.secondaryTestID).toBe('skillBundle.cancel');
    });

    it('renders a title input, markdown editor, and save action for new skills', async () => {
        const { SkillBundleEditorScreen } = await import('./SkillBundleEditorScreen');
        let tree!: ReactTestRenderer;

        await act(async () => {
            tree = renderer.create(React.createElement(SkillBundleEditorScreen, { artifactId: null }));
            await Promise.resolve();
        });

        expect(tree.root.findByProps({ testID: 'skillBundle.title' })).toBeTruthy();
        expect(tree.root.findByProps({ testID: 'skillBundle.editor' })).toBeTruthy();
        expect(tree.root.findByType('SettingsActionFooter').props.primaryTestID).toBe('skillBundle.save');
        expect(tree.root.findAllByProps({ testID: 'skillBundle.manageExternalAssets' })).toHaveLength(0);
    });

    it('shows supporting files for existing skills and a save-first hint for new skills', async () => {
        const { SkillBundleEditorScreen } = await import('./SkillBundleEditorScreen');
        let existingTree!: ReactTestRenderer;

        await act(async () => {
            existingTree = renderer.create(React.createElement(SkillBundleEditorScreen, { artifactId: 'bundle-1' }));
            await Promise.resolve();
        });
        await act(async () => {
            await Promise.resolve();
        });

        expect(existingTree.root.findByProps({ testID: 'skillBundle.supportingFile.0' }).props.title).toBe('templates/review.md');
        expect(existingTree.root.findByProps({ testID: 'skillBundle.addSupportingFile' })).toBeTruthy();

        let newTree!: ReactTestRenderer;
        await act(async () => {
            newTree = renderer.create(React.createElement(SkillBundleEditorScreen, { artifactId: null }));
            await Promise.resolve();
        });

        expect(newTree.root.findByProps({ testID: 'skillBundle.supportingFilesSaveFirst' }).props.title)
            .toBe('promptLibrary.supportingFilesSaveFirstTitle');
    });

    it('refreshes supporting files when the skill screen regains focus after bundle updates', async () => {
        const { SkillBundleEditorScreen } = await import('./SkillBundleEditorScreen');
        let tree!: ReactTestRenderer;

        await act(async () => {
            tree = renderer.create(React.createElement(SkillBundleEditorScreen, { artifactId: 'bundle-1' }));
            await Promise.resolve();
        });

        expect(tree.root.findAllByProps({ testID: 'skillBundle.supportingFile.1' })).toHaveLength(0);

        artifactBodiesState.value = {
            ...artifactBodiesState.value,
            'bundle-1': {
                id: 'bundle-1',
                header: { title: 'Skill title' },
                body: JSON.stringify({
                    v: 1,
                    entries: [
                        {
                            path: 'SKILL.md',
                            contentBase64: Buffer.from('---\\nname: skill\\n---\\nHello skill').toString('base64'),
                            contentKind: 'utf8',
                        },
                        {
                            path: 'templates/review.md',
                            contentBase64: Buffer.from('review template').toString('base64'),
                            contentKind: 'utf8',
                        },
                        {
                            path: 'templates/checklist.md',
                            contentBase64: Buffer.from('checklist template').toString('base64'),
                            contentKind: 'utf8',
                        },
                    ],
                    createdAtMs: 1,
                    updatedAtMs: 3,
                }),
            },
        };

        await act(async () => {
            latestFocusEffect?.();
            await Promise.resolve();
        });

        expect(tree.root.findByProps({ testID: 'skillBundle.supportingFile.1' }).props.title).toBe('templates/checklist.md');
    });
});
