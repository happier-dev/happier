import {
    createPartialStorageModuleMock,
    flushHookEffects,
} from '@/dev/testkit';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import {
    installSkillBundleCommonModuleMocks,
    skillBundleRouterBackSpy,
    skillBundleRouterPushSpy,
    skillBundleRouterReplaceSpy,
} from './skillBundleScreenTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const createSkillPromptBundleSpy = vi.fn(async () => 'new-bundle');
const updateSkillPromptBundleSpy = vi.fn(async () => {});
const setPromptFoldersSpy = vi.fn();
let latestFocusEffect: (() => void) | undefined;
const fetchArtifactWithBodySpy = vi.fn(async () => null);
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
const promptFoldersState = vi.hoisted(() => ({
    value: {
        v: 1,
        folders: [
            { id: 'folder-1', name: 'Ops', parentId: null },
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

installSkillBundleCommonModuleMocks({
    storage: async (importOriginal) =>
        createPartialStorageModuleMock(importOriginal, {
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
                    return [promptFoldersState.value, setPromptFoldersSpy];
                }
                return [null, vi.fn()];
            },
            storage: {
                getState: () => ({
                    artifacts: artifactBodiesState.value,
                    updateArtifact: vi.fn(),
                }),
            },
        }),
});

vi.mock('@react-navigation/native', () => ({
    useFocusEffect: (callback: () => void) => {
        latestFocusEffect = callback;
        React.useEffect(() => {
            callback();
        }, [callback]);
    },
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

vi.mock('@/sync/sync', () => ({
    sync: {
        getCredentials: () => ({ ok: true }),
        fetchArtifactWithBody: fetchArtifactWithBodySpy,
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

async function renderSkillBundleEditor(artifactId: string | null) {
    const { SkillBundleEditorScreen } = await import('./SkillBundleEditorScreen');
    return renderScreen(React.createElement(SkillBundleEditorScreen, { artifactId }));
}

describe('SkillBundleEditorScreen', () => {
    beforeEach(() => {
        skillBundleRouterBackSpy.mockReset();
        skillBundleRouterReplaceSpy.mockReset();
        skillBundleRouterPushSpy.mockReset();
        createSkillPromptBundleSpy.mockClear();
        updateSkillPromptBundleSpy.mockClear();
        fetchArtifactWithBodySpy.mockClear();
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
        const screen = await renderSkillBundleEditor('bundle-1');
        const saveFooter = screen.findByType('SettingsActionFooter');

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
        expect(skillBundleRouterReplaceSpy).toHaveBeenCalledWith('/settings/prompts/skills');
        expect(skillBundleRouterBackSpy).not.toHaveBeenCalled();
    });

    it('navigates to the external export screen for an existing skill bundle', async () => {
        const screen = await renderSkillBundleEditor('bundle-1');

        await screen.pressByTestIdAsync('skillBundle.manageExternalAssets');

        expect(skillBundleRouterPushSpy).toHaveBeenCalledWith('/settings/prompts/skills/bundle-1/export');
    });

    it('starts new skills with starter markdown and saves it when only the title changes', async () => {
        const screen = await renderSkillBundleEditor(null);
        const editor = screen.findByTestId('skillBundle.editor');
        if (!editor) {
            throw new Error('skillBundle.editor not found');
        }
        expect(editor.props.value).toContain('## When to use');

        await act(async () => {
            screen.changeTextByTestId('skillBundle.title', 'New skill');
        });

        const saveButton = screen.findByType('SettingsActionFooter');
        await act(async () => {
            await saveButton.props.onPrimaryPress();
        });

        expect(createSkillPromptBundleSpy).toHaveBeenCalledWith({
            title: 'New skill',
            skillMarkdown: expect.stringContaining('## Instructions'),
            folderId: null,
            tags: [],
        });
        expect(skillBundleRouterReplaceSpy).toHaveBeenCalledWith('/settings/prompts/skills');
    });

    it('keeps existing skill editors locked when the requested artifact body does not load', async () => {
        artifactBodiesState.value = {
            'bundle-1': {
                id: 'bundle-1',
                header: { title: 'Skill title' },
                body: undefined,
            },
        };
        fetchArtifactWithBodySpy.mockResolvedValueOnce(null);

        const screen = await renderSkillBundleEditor('bundle-1');

        const titleInput = screen.findByTestId('skillBundle.title');
        const editor = screen.findByTestId('skillBundle.editor');
        const footer = screen.findByType('SettingsActionFooter');
        if (!titleInput || !editor) {
            throw new Error('skill bundle inputs not found');
        }

        expect(titleInput.props.editable).toBe(false);
        expect(editor.props.readOnly).toBe(true);
        expect(footer.props.primaryDisabled).toBe(true);
    });

    it('renders linked exports and a settings footer for existing skills', async () => {
        const screen = await renderSkillBundleEditor('bundle-1');

        expect(screen.findByTestId('skillBundle.link.0')?.props.subtitle).toContain('Laptop');
        expect(screen.findByTestId('skillBundle.folderName')?.props.value).toBe('Ops');
        expect(screen.findByTestId('skillBundle.tags')?.props.value).toBe('alpha');

        const footer = screen.findByType('SettingsActionFooter');
        expect(footer.props.primaryTestID).toBe('skillBundle.save');
        expect(footer.props.secondaryTestID).toBe('skillBundle.cancel');
    });

    it('renders a title input, markdown editor, and save action for new skills', async () => {
        const screen = await renderSkillBundleEditor(null);

        expect(screen.findByTestId('skillBundle.title')).toBeTruthy();
        expect(screen.findByTestId('skillBundle.editor')).toBeTruthy();
        expect(screen.findByType('SettingsActionFooter').props.primaryTestID).toBe('skillBundle.save');
        expect(screen.findAllByTestId('skillBundle.manageExternalAssets')).toHaveLength(0);
    });

    it('shows supporting files for existing skills and a save-first hint for new skills', async () => {
        const existingTree = await renderSkillBundleEditor('bundle-1');

        expect(existingTree.findByTestId('skillBundle.supportingFile.0')?.props.title).toBe('templates/review.md');
        expect(existingTree.findByTestId('skillBundle.addSupportingFile')).toBeTruthy();

        const newTree = await renderSkillBundleEditor(null);

        expect(newTree.findByTestId('skillBundle.supportingFilesSaveFirst')?.props.title)
            .toBe('promptLibrary.supportingFilesSaveFirstTitle');
    });

    it('refreshes supporting files when the skill screen regains focus after bundle updates', async () => {
        const screen = await renderSkillBundleEditor('bundle-1');

        expect(screen.findAllByTestId('skillBundle.supportingFile.1')).toHaveLength(0);

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
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(screen.findByTestId('skillBundle.supportingFile.1')?.props.title).toBe('templates/checklist.md');
    });
});
