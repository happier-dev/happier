import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_AGENT_ID } from '@/agents/catalog/catalog';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const {
    setScmCommitStrategy,
    setScmGitRepoPreferredBackend,
    setScmRemoteConfirmPolicy,
    setScmPushRejectPolicy,
    setScmDefaultDiffModeByBackend,
    setFilesDiffSyntaxHighlightingMode,
    setFilesDiffRendererMode,
    setFilesDiffPresentationStyle,
    setFilesChangedFilesRowDensity,
    setScmCommitMessageGeneratorEnabled,
    setScmCommitMessageGeneratorBackendId,
    setScmCommitMessageGeneratorInstructions,
    modalPrompt,
} = vi.hoisted(() => ({
    setScmCommitStrategy: vi.fn(),
    setScmGitRepoPreferredBackend: vi.fn(),
    setScmRemoteConfirmPolicy: vi.fn(),
    setScmPushRejectPolicy: vi.fn(),
    setScmDefaultDiffModeByBackend: vi.fn(),
    setFilesDiffSyntaxHighlightingMode: vi.fn(),
    setFilesDiffRendererMode: vi.fn(),
    setFilesDiffPresentationStyle: vi.fn(),
    setFilesChangedFilesRowDensity: vi.fn(),
    setScmCommitMessageGeneratorEnabled: vi.fn(),
    setScmCommitMessageGeneratorBackendId: vi.fn(),
    setScmCommitMessageGeneratorInstructions: vi.fn(),
    modalPrompt: vi.fn(),
}));

let filesDiffPresentationStyleValue: any = 'split';

vi.mock('react-native', async () => await import('@/dev/reactNativeStub'));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSettingMutable: (name: string) => {
        if (name === 'scmCommitStrategy') return ['atomic', setScmCommitStrategy];
        if (name === 'scmGitRepoPreferredBackend') return ['git', setScmGitRepoPreferredBackend];
        if (name === 'scmRemoteConfirmPolicy') return ['always', setScmRemoteConfirmPolicy];
        if (name === 'scmPushRejectPolicy') return ['prompt_fetch', setScmPushRejectPolicy];
        if (name === 'scmDefaultDiffModeByBackend') return [{}, setScmDefaultDiffModeByBackend];
        if (name === 'filesDiffSyntaxHighlightingMode') return ['off', setFilesDiffSyntaxHighlightingMode];
        if (name === 'filesDiffRendererMode') return ['pierre', setFilesDiffRendererMode];
        if (name === 'filesDiffPresentationStyle') return [filesDiffPresentationStyleValue, setFilesDiffPresentationStyle];
        if (name === 'filesChangedFilesRowDensity') return ['comfortable', setFilesChangedFilesRowDensity];
        if (name === 'scmCommitMessageGeneratorEnabled') return [true, setScmCommitMessageGeneratorEnabled];
        if (name === 'scmCommitMessageGeneratorBackendId') return [DEFAULT_AGENT_ID, setScmCommitMessageGeneratorBackendId];
        if (name === 'scmCommitMessageGeneratorInstructions') return ['', setScmCommitMessageGeneratorInstructions];
        return [null, vi.fn()];
    },
}));

vi.mock('@/modal', () => ({
    Modal: {
        prompt: modalPrompt,
    },
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

vi.mock('@/text', () => ({
    t: (key: string, params?: Record<string, unknown>) => {
        if (key === 'settingsSourceControl.backends.defaultDiffItemTitle') {
            return `settingsSourceControl.backends.defaultDiffItemTitle:${String(params?.backendTitle ?? '')}:${String(params?.diffModeTitle ?? '')}`;
        }
        if (key === 'settingsSourceControl.commitMessageGenerator.backendItemTitle') {
            return `settingsSourceControl.commitMessageGenerator.backendItemTitle:${String(params?.backendId ?? '')}`;
        }
        return key;
    },
}));

describe('SourceControlSettingsView', () => {
    it('renders commit strategy options and updates setting when selected', async () => {
        filesDiffPresentationStyleValue = 'split';
        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(SourceControlSettingsView));
        });

        const items = tree!.root.findAllByType('Item' as any);
        const titles = items.map((item) => item.props.title);
        expect(titles).toContain('settingsSourceControl.commitStrategy.options.atomic.title');
        expect(titles).toContain('settingsSourceControl.commitStrategy.options.gitStaging.title');
        expect(titles).toContain('settingsSourceControl.gitRoutingPreference.options.git.title');
        expect(titles).toContain('settingsSourceControl.remoteConfirmation.options.always.title');

        const gitStagingItem = items.find((item) => item.props.title === 'settingsSourceControl.commitStrategy.options.gitStaging.title');
        expect(gitStagingItem).toBeTruthy();
        await act(async () => {
            gitStagingItem!.props.onPress();
        });
        expect(setScmCommitStrategy).toHaveBeenCalledWith('git_staging');
    });

    it('defaults diff presentation style to unified when the setting is missing', async () => {
        filesDiffPresentationStyleValue = undefined;
        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(SourceControlSettingsView));
        });

        const items = tree!.root.findAllByType('Item' as any);
        const unified = items.find((item) => item.props.title === 'settingsSourceControl.filesDisplay.diffPresentation.options.unified.title');
        const split = items.find((item) => item.props.title === 'settingsSourceControl.filesDisplay.diffPresentation.options.split.title');

        expect(unified).toBeTruthy();
        expect(split).toBeTruthy();
        expect(unified!.props.rightElement).toBeTruthy();
        expect(split!.props.rightElement).toBeFalsy();
    });

    it('only renders backend-supported default diff modes', async () => {
        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(SourceControlSettingsView));
        });

        const titles = tree!.root.findAllByType('Item' as any).map((item) => item.props.title);
        expect(titles).toContain('settingsSourceControl.backends.defaultDiffItemTitle:Git:settingsSourceControl.diffMode.included');
        expect(titles).toContain('settingsSourceControl.backends.defaultDiffItemTitle:Sapling:settingsSourceControl.diffMode.pending');
        // When no snapshot/capabilities are available yet, Sapling conservatively only advertises "pending".
        expect(titles).not.toContain('settingsSourceControl.backends.defaultDiffItemTitle:Sapling:settingsSourceControl.diffMode.combined');
        expect(titles).not.toContain('settingsSourceControl.backends.defaultDiffItemTitle:Sapling:settingsSourceControl.diffMode.included');
    });

    it('allows updating diff syntax highlighting mode', async () => {
        setFilesDiffSyntaxHighlightingMode.mockClear();

        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(SourceControlSettingsView));
        });

        const items = tree!.root.findAllByType('Item' as any);
        const simpleItem = items.find((item) => item.props.title === 'settingsSourceControl.filesDisplay.syntaxHighlighting.options.simple.title');
        expect(simpleItem).toBeTruthy();

        await act(async () => {
            simpleItem!.props.onPress();
        });

        expect(setFilesDiffSyntaxHighlightingMode).toHaveBeenCalledWith('simple');
    });

    it('allows updating files diff renderer mode', async () => {
        setFilesDiffRendererMode.mockClear();

        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(SourceControlSettingsView));
        });

        const items = tree!.root.findAllByType('Item' as any);
        const happierItem = items.find((item) => item.props.title === 'settingsSourceControl.filesDisplay.diffRenderer.options.happier.title');
        expect(happierItem).toBeTruthy();

        await act(async () => {
            happierItem!.props.onPress();
        });

        expect(setFilesDiffRendererMode).toHaveBeenCalledWith('happier');
    });

    it('allows updating diff presentation style', async () => {
        setFilesDiffPresentationStyle.mockClear();

        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(SourceControlSettingsView));
        });

        const items = tree!.root.findAllByType('Item' as any);
        const unifiedItem = items.find((item) => item.props.title === 'settingsSourceControl.filesDisplay.diffPresentation.options.unified.title');
        expect(unifiedItem).toBeTruthy();

        await act(async () => {
            unifiedItem!.props.onPress();
        });

        expect(setFilesDiffPresentationStyle).toHaveBeenCalledWith('unified');
    });

    it('allows updating changed files row density', async () => {
        setFilesChangedFilesRowDensity.mockClear();

        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(SourceControlSettingsView));
        });

        const items = tree!.root.findAllByType('Item' as any);
        const compactItem = items.find((item) => item.props.title === 'settingsSourceControl.filesDisplay.changedFilesDensity.options.compact.title');
        expect(compactItem).toBeTruthy();

        await act(async () => {
            compactItem!.props.onPress();
        });

        expect(setFilesChangedFilesRowDensity).toHaveBeenCalledWith('compact');
    });

    it('renders commit message generator settings and allows disabling', async () => {
        setScmCommitMessageGeneratorEnabled.mockClear();

        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(SourceControlSettingsView));
        });

        const items = tree!.root.findAllByType('Item' as any);
        const generatorItem = items.find((item) => item.props.title === 'settingsSourceControl.commitMessageGenerator.title');
        expect(generatorItem).toBeTruthy();

        await act(async () => {
            generatorItem!.props.onPress();
        });

        expect(setScmCommitMessageGeneratorEnabled).toHaveBeenCalledWith(false);
    });

    it('allows editing commit message generator instructions', async () => {
        setScmCommitMessageGeneratorInstructions.mockClear();

        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(SourceControlSettingsView));
        });

        const inputs = tree!.root.findAllByType('TextInput' as any);
        const instructions = inputs.find((n: any) => n.props.placeholder === 'settingsSourceControl.commitMessageGenerator.instructionsPlaceholder');
        expect(instructions).toBeTruthy();

        await act(async () => {
            instructions!.props.onChangeText?.('Use imperative mood');
        });

        expect(setScmCommitMessageGeneratorInstructions).toHaveBeenCalledWith('Use imperative mood');
    });
});
