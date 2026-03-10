import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerBackSpy = vi.fn();
const routerReplaceSpy = vi.fn();
const updateSkillPromptBundleWithEntrySpy = vi.fn(async () => {});

vi.mock('react-native', () => ({
    View: 'View',
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
    }),
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

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
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

vi.mock('@/sync/ops/promptLibrary/promptBundles', () => ({
    readPromptBundleUtf8Entry: (body: any, path: string) => {
        const entry = Array.isArray(body?.entries)
            ? body.entries.find((item: any) => item?.path === path)
            : null;
        return entry ? Buffer.from(entry.contentBase64, 'base64').toString('utf8') : null;
    },
    updateSkillPromptBundleWithEntry: updateSkillPromptBundleWithEntrySpy,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => ({
            artifacts: {
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
            },
            updateArtifact: vi.fn(),
        }),
    },
}));

describe('SkillBundleSupportingFileEditorScreen', () => {
    beforeEach(() => {
        routerBackSpy.mockReset();
        routerReplaceSpy.mockReset();
        updateSkillPromptBundleWithEntrySpy.mockClear();
    });

    it('loads an existing supporting file and saves updates back to the skill bundle', async () => {
        const { SkillBundleSupportingFileEditorScreen } = await import('./SkillBundleSupportingFileEditorScreen');
        let tree!: ReactTestRenderer;

        await act(async () => {
            tree = renderer.create(React.createElement(SkillBundleSupportingFileEditorScreen, {
                artifactId: 'bundle-1',
                path: 'templates/review.md',
            }));
            await Promise.resolve();
        });

        expect(tree.root.findByProps({ testID: 'skillSupportingFile.path' }).props.value).toBe('templates/review.md');
        expect(tree.root.findByProps({ testID: 'skillSupportingFile.editor' }).props.value).toBe('review template');

        await act(async () => {
            tree.root.findByProps({ testID: 'skillSupportingFile.editor' }).props.onChange('updated template');
        });
        await act(async () => {
            await tree.root.findByType('SettingsActionFooter').props.onPrimaryPress();
        });

        expect(updateSkillPromptBundleWithEntrySpy).toHaveBeenCalledWith({
            artifactId: 'bundle-1',
            path: 'templates/review.md',
            content: 'updated template',
        });
        expect(routerReplaceSpy).toHaveBeenCalledWith('/settings/prompts/skills/bundle-1');
    });

    it('creates a new supporting file entry for an existing skill bundle', async () => {
        const { SkillBundleSupportingFileEditorScreen } = await import('./SkillBundleSupportingFileEditorScreen');
        let tree!: ReactTestRenderer;

        await act(async () => {
            tree = renderer.create(React.createElement(SkillBundleSupportingFileEditorScreen, {
                artifactId: 'bundle-1',
                path: null,
            }));
            await Promise.resolve();
        });

        await act(async () => {
            tree.root.findByProps({ testID: 'skillSupportingFile.path' }).props.onChangeText('docs/checklist.md');
            tree.root.findByProps({ testID: 'skillSupportingFile.editor' }).props.onChange('checklist body');
        });
        await act(async () => {
            await tree.root.findByType('SettingsActionFooter').props.onPrimaryPress();
        });

        expect(updateSkillPromptBundleWithEntrySpy).toHaveBeenCalledWith({
            artifactId: 'bundle-1',
            path: 'docs/checklist.md',
            content: 'checklist body',
        });
    });
});
