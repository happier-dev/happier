import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPartialStorageModuleMock, renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerBackSpy = vi.fn();
const routerReplaceSpy = vi.fn();
const updateSkillPromptBundleWithEntrySpy = vi.fn(async () => {});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                        View: 'View',
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
    CodeEditor: ({ onChange, ...props }: any) => React.createElement('CodeEditor', {
        ...props,
        onChangeText: onChange,
    }),
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
    SettingsActionFooter: (props: any) => React.createElement('SettingsActionFooter', props, [
        React.createElement('Pressable', {
            key: 'primary',
            testID: props.primaryTestID,
            onPress: props.onPrimaryPress,
        }),
        React.createElement('Pressable', {
            key: 'secondary',
            testID: props.secondaryTestID,
            onPress: props.onSecondaryPress,
        }),
    ]),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('@/sync/ops/promptLibrary/promptBundles', () => ({
    readPromptBundleUtf8Entry: (body: any, path: string) => {
        const entry = Array.isArray(body?.entries)
            ? body.entries.find((item: any) => item?.path === path)
            : null;
        return entry ? Buffer.from(entry.contentBase64, 'base64').toString('utf8') : null;
    },
    updateSkillPromptBundleWithEntry: updateSkillPromptBundleWithEntrySpy,
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => createPartialStorageModuleMock(importOriginal, {
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

async function renderSkillSupportingFileEditor(path: string | null) {
    const { SkillBundleSupportingFileEditorScreen } = await import('./SkillBundleSupportingFileEditorScreen');
    return renderScreen(React.createElement(SkillBundleSupportingFileEditorScreen, {
        artifactId: 'bundle-1',
        path,
    }));
}

describe('SkillBundleSupportingFileEditorScreen', () => {
    beforeEach(() => {
        routerBackSpy.mockReset();
        routerReplaceSpy.mockReset();
        updateSkillPromptBundleWithEntrySpy.mockClear();
    });

    it('loads an existing supporting file and saves updates back to the skill bundle', async () => {
        const screen = await renderSkillSupportingFileEditor('templates/review.md');

        expect(screen.findByTestId('skillSupportingFile.path')?.props.value).toBe('templates/review.md');
        expect(screen.findByTestId('skillSupportingFile.editor')?.props.value).toBe('review template');

        await act(async () => {
            screen.changeTextByTestId('skillSupportingFile.editor', 'updated template');
        });
        await act(async () => {
            screen.pressByTestId('skillSupportingFile.save');
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(updateSkillPromptBundleWithEntrySpy).toHaveBeenCalledWith({
            artifactId: 'bundle-1',
            path: 'templates/review.md',
            content: 'updated template',
        });
        expect(routerReplaceSpy).toHaveBeenCalledWith('/settings/prompts/skills/bundle-1');
    });

    it('creates a new supporting file entry for an existing skill bundle', async () => {
        const screen = await renderSkillSupportingFileEditor(null);

        await act(async () => {
            screen.changeTextByTestId('skillSupportingFile.path', 'docs/checklist.md');
            screen.changeTextByTestId('skillSupportingFile.editor', 'checklist body');
        });
        await act(async () => {
            screen.pressByTestId('skillSupportingFile.save');
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(updateSkillPromptBundleWithEntrySpy).toHaveBeenCalledWith({
            artifactId: 'bundle-1',
            path: 'docs/checklist.md',
            content: 'checklist body',
        });
    });
});
