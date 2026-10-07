import {
    createPartialStorageModuleMock,
    flushHookEffects,
} from '@/dev/testkit';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { clearActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
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
const routeFocusState = vi.hoisted(() => ({ focused: true }));
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

/** Whether the screen currently asks the navigator to hold a departure (the unsaved-changes guard). */
const preventRemoveState = vi.hoisted(() => ({ last: null as boolean | null }));

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return {
        ...createReactNavigationNativeMock(),
        NavigationContext: React.createContext({}),
        useIsFocused: () => routeFocusState.focused,
        // The navigator's remove interception is the navigation library boundary; record what the screen asks for.
        usePreventRemove: (preventRemove: boolean) => {
            preventRemoveState.last = preventRemove;
        },
    };
});

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 960 },
    useLayoutMaxWidth: () => 960,
    useLayoutMaxWidthStyle: () => ({ maxWidth: 960 }),
}));

vi.mock('@/components/ui/markdown/editor/MarkdownCodeEditorField', () => ({
    MarkdownCodeEditorField: ({ onChange, ...props }: any) => React.createElement('MarkdownCodeEditorField', {
        ...props,
        onChangeText: onChange,
    }),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: (props: any) => React.createElement('ItemRowActions', props),
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

/** The props a row was rendered with (its `Item`, the outermost element carrying the test id). */
function rowProps(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string): Record<string, unknown> | undefined {
    return screen.tree.root.findAll((node) => node.props?.testID === testID)[0]?.props;
}

async function renderSkillBundleEditor(artifactId: string | null) {
    const { SkillBundleEditorScreen } = await import('./SkillBundleEditorScreen');
    return renderScreen(React.createElement(SkillBundleEditorScreen, { artifactId }));
}

describe('SkillBundleEditorScreen', () => {
    afterEach(async () => {
        await standardCleanup();
        clearActiveUnsavedChangesGuard();
    });

    beforeEach(() => {
        clearActiveUnsavedChangesGuard();
        skillBundleRouterBackSpy.mockReset();
        skillBundleRouterReplaceSpy.mockReset();
        skillBundleRouterPushSpy.mockReset();
        createSkillPromptBundleSpy.mockClear();
        updateSkillPromptBundleSpy.mockClear();
        fetchArtifactWithBodySpy.mockClear();
        setPromptFoldersSpy.mockClear();
        routeFocusState.focused = true;
        promptFoldersState.value = {
            v: 1,
            folders: [
                { id: 'folder-1', name: 'Ops', parentId: null },
            ],
        };
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

    it('saves an edited skill in place and keeps its editor open', async () => {
        const screen = await renderSkillBundleEditor('bundle-1');
        expect(screen.findByTestId('skillBundle.save')?.props.disabled).toBe(true);

        await act(async () => {
            screen.changeTextByTestId('skillBundle.title', 'Renamed skill');
        });
        await act(async () => {
            await screen.findByTestId('skillBundle.save')?.props.onPress();
        });

        expect(updateSkillPromptBundleSpy).toHaveBeenCalledWith({
            artifactId: 'bundle-1',
            title: 'Renamed skill',
            skillMarkdown: '---\\nname: skill\\n---\\nHello skill',
            folderId: 'folder-1',
            tags: ['alpha'],
        });
        expect(skillBundleRouterReplaceSpy).not.toHaveBeenCalled();
        expect(skillBundleRouterBackSpy).not.toHaveBeenCalled();
    });

    it('navigates to the external export screen for an existing skill bundle', async () => {
        const screen = await renderSkillBundleEditor('bundle-1');

        await screen.pressByTestIdAsync('skillBundle.manageExternalAssets');

        expect(skillBundleRouterPushSpy).toHaveBeenCalledWith('/(app)/settings/prompts/skills/bundle-1/export');
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
        expect(preventRemoveState.last).toBe(true);

        await act(async () => {
            await screen.findByTestId('skillBundle.save')?.props.onPress();
        });
        // The saved draft has nothing left to lose, so opening the saved skill is not held for a decision.
        expect(preventRemoveState.last).toBe(false);

        expect(createSkillPromptBundleSpy).toHaveBeenCalledWith({
            title: 'New skill',
            skillMarkdown: expect.stringContaining('## Instructions'),
            folderId: null,
            tags: [],
        });
        expect(skillBundleRouterReplaceSpy).toHaveBeenCalledWith('/settings/prompts/skills/new-bundle');
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
        if (!titleInput || !editor) {
            throw new Error('skill bundle inputs not found');
        }

        expect(titleInput.props.editable).toBe(false);
        expect(editor.props.readOnly).toBe(true);
        expect(screen.findByTestId('skillBundle.save')?.props.disabled).toBe(true);
    });

    it('renders linked exports and the organisation fields for existing skills', async () => {
        const screen = await renderSkillBundleEditor('bundle-1');

        expect(screen.findByTestId('skillBundle.link.0')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Laptop');
        expect(screen.findByTestId('skillBundle.folderName')?.props.value).toBe('Ops');
        expect(screen.findByTestId('skillBundle.tags')?.props.value).toBe('alpha');
        expect(screen.findByTestId('skillBundle.save')).toBeTruthy();
    });

    it('renders a title input, markdown editor, and save action for new skills', async () => {
        const screen = await renderSkillBundleEditor(null);

        expect(screen.findByTestId('skillBundle.title')).toBeTruthy();
        expect(screen.findByTestId('skillBundle.editor')).toBeTruthy();
        expect(screen.findByTestId('skillBundle.save')).toBeTruthy();
        expect(screen.findAllByTestId('skillBundle.manageExternalAssets')).toHaveLength(0);
    });

    it('shows supporting files for existing skills and a save-first hint for new skills', async () => {
        const existingTree = await renderSkillBundleEditor('bundle-1');

        expect(rowProps(existingTree, 'skillBundle.supportingFile.0')?.title).toBe('templates/review.md');
        expect(existingTree.findByTestId('skillBundle.addSupportingFile')).toBeTruthy();

        const newTree = await renderSkillBundleEditor(null);

        expect(rowProps(newTree, 'skillBundle.supportingFilesSaveFirst')?.title)
            .toBe('promptLibrary.supportingFilesSaveFirstTitle');
    });

    it('refreshes supporting files when the skill screen regains focus after bundle updates', async () => {
        const screen = await renderSkillBundleEditor('bundle-1');

        expect(screen.findAllByTestId('skillBundle.supportingFile.1')).toHaveLength(0);
        const { SkillBundleEditorScreen } = await import('./SkillBundleEditorScreen');
        routeFocusState.focused = false;
        await screen.update(React.createElement(SkillBundleEditorScreen, { artifactId: 'bundle-1' }));

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

        routeFocusState.focused = true;
        await screen.update(React.createElement(SkillBundleEditorScreen, { artifactId: 'bundle-1' }));

        await vi.waitFor(() => expect(rowProps(screen, 'skillBundle.supportingFile.1')?.title).toBe('templates/checklist.md'));
    });

    it('preserves dirty skill fields when prompt-folder settings refresh', async () => {
        const screen = await renderSkillBundleEditor('bundle-1');

        await act(async () => {
            screen.changeTextByTestId('skillBundle.title', 'Draft skill title');
            screen.changeTextByTestId('skillBundle.editor', 'draft skill markdown');
            screen.changeTextByTestId('skillBundle.folderName', 'Draft folder');
            screen.changeTextByTestId('skillBundle.tags', 'draft, tag');
        });

        promptFoldersState.value = {
            v: 1,
            folders: [
                { id: 'folder-1', name: 'Renamed Ops', parentId: null },
            ],
        };

        await act(async () => {
            screen.changeTextByTestId('skillBundle.tags', 'draft, tag updated');
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(screen.findByTestId('skillBundle.title')?.props.value).toBe('Draft skill title');
        expect(screen.findByTestId('skillBundle.editor')?.props.value).toBe('draft skill markdown');
        expect(screen.findByTestId('skillBundle.folderName')?.props.value).toBe('Draft folder');
        expect(screen.findByTestId('skillBundle.tags')?.props.value).toBe('draft, tag updated');
    });
});
