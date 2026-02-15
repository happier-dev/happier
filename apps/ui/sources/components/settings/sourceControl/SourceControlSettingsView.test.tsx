import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setScmCommitStrategy = vi.fn();
const setScmGitRepoPreferredBackend = vi.fn();
const setScmRemoteConfirmPolicy = vi.fn();
const setScmPushRejectPolicy = vi.fn();
const setScmDefaultDiffModeByBackend = vi.fn();
const setFilesDiffSyntaxHighlightingMode = vi.fn();
const setFilesChangedFilesRowDensity = vi.fn();
const setScmCommitMessageGeneratorEnabled = vi.fn();
const setScmCommitMessageGeneratorBackendId = vi.fn();
const setScmCommitMessageGeneratorInstructions = vi.fn();

const modalPrompt = vi.fn();

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                textSecondary: '#999',
            },
        },
    }),
}));

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
        if (name === 'filesChangedFilesRowDensity') return ['comfortable', setFilesChangedFilesRowDensity];
        if (name === 'scmCommitMessageGeneratorEnabled') return [false, setScmCommitMessageGeneratorEnabled];
        if (name === 'scmCommitMessageGeneratorBackendId') return ['claude', setScmCommitMessageGeneratorBackendId];
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

describe('SourceControlSettingsView', () => {
    it('renders commit strategy options and updates setting when selected', async () => {
        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(SourceControlSettingsView));
        });

        const items = tree!.root.findAllByType('Item' as any);
        const titles = items.map((item) => item.props.title);
        expect(titles).toContain('Atomic commit (recommended)');
        expect(titles).toContain('Git staging workflow');
        expect(titles).toContain('.git repositories use Git');
        expect(titles).toContain('Always confirm pull/push');

        const gitStagingItem = items.find((item) => item.props.title === 'Git staging workflow');
        expect(gitStagingItem).toBeTruthy();
        await act(async () => {
            gitStagingItem!.props.onPress();
        });
        expect(setScmCommitStrategy).toHaveBeenCalledWith('git_staging');
    });

    it('only renders backend-supported default diff modes', async () => {
        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(SourceControlSettingsView));
        });

        const titles = tree!.root.findAllByType('Item' as any).map((item) => item.props.title);
        expect(titles).toContain('Git default diff: Included');
        expect(titles).toContain('Sapling default diff: Pending');
        // When no snapshot/capabilities are available yet, Sapling conservatively only advertises "pending".
        expect(titles).not.toContain('Sapling default diff: Combined');
        expect(titles).not.toContain('Sapling default diff: Included');
    });

    it('allows updating diff syntax highlighting mode', async () => {
        setFilesDiffSyntaxHighlightingMode.mockClear();

        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(SourceControlSettingsView));
        });

        const items = tree!.root.findAllByType('Item' as any);
        const simpleItem = items.find((item) => item.props.title === 'Syntax highlighting: Simple');
        expect(simpleItem).toBeTruthy();

        await act(async () => {
            simpleItem!.props.onPress();
        });

        expect(setFilesDiffSyntaxHighlightingMode).toHaveBeenCalledWith('simple');
    });

    it('allows updating changed files row density', async () => {
        setFilesChangedFilesRowDensity.mockClear();

        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(SourceControlSettingsView));
        });

        const items = tree!.root.findAllByType('Item' as any);
        const compactItem = items.find((item) => item.props.title === 'Changed files density: Compact');
        expect(compactItem).toBeTruthy();

        await act(async () => {
            compactItem!.props.onPress();
        });

        expect(setFilesChangedFilesRowDensity).toHaveBeenCalledWith('compact');
    });

    it('renders commit message generator settings and allows enabling', async () => {
        setScmCommitMessageGeneratorEnabled.mockClear();

        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(SourceControlSettingsView));
        });

        const items = tree!.root.findAllByType('Item' as any);
        const generatorItem = items.find((item) => item.props.title === 'Commit message generator');
        expect(generatorItem).toBeTruthy();

        await act(async () => {
            generatorItem!.props.onPress();
        });

        expect(setScmCommitMessageGeneratorEnabled).toHaveBeenCalledWith(true);
    });

    it('allows editing commit message generator instructions', async () => {
        setScmCommitMessageGeneratorInstructions.mockClear();

        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(SourceControlSettingsView));
        });

        const inputs = tree!.root.findAllByType('TextInput' as any);
        const instructions = inputs.find((n: any) => n.props.placeholder === 'Commit message instructions');
        expect(instructions).toBeTruthy();

        await act(async () => {
            instructions!.props.onChangeText?.('Use imperative mood');
        });

        expect(setScmCommitMessageGeneratorInstructions).toHaveBeenCalledWith('Use imperative mood');
    });
});
