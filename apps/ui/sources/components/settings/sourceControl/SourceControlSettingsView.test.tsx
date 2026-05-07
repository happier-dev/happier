import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_AGENT_ID } from '@/agents/catalog/catalog';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

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
}));

type FilesDiffPresentationStyleValue = 'split' | 'unified' | undefined;

let filesDiffPresentationStyleValue: FilesDiffPresentationStyleValue = 'split';

installSettingsViewCommonModuleMocks({
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
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
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key, params) => {
                if (key === 'settingsSourceControl.backends.defaultDiffItemTitle') {
                    return `settingsSourceControl.backends.defaultDiffItemTitle:${String(params?.backendTitle ?? '')}:${String(params?.diffModeTitle ?? '')}`;
                }
                if (key === 'settingsSourceControl.commitMessageGenerator.backendItemTitle') {
                    return `settingsSourceControl.commitMessageGenerator.backendItemTitle:${String(params?.backendId ?? '')}`;
                }
                return key;
            },
        });
    },
});

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
        filesDiffPresentationStyleValue = 'split';
        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));

        expect(screen.findRowByTitle('settingsSourceControl.commitStrategy.options.gitStaging.title')).toBeTruthy();
        expect(screen.findRowByTitle('settingsSourceControl.commitStrategy.options.atomic.title')).toBeTruthy();
        expect(screen.findRowByTitle('settingsSourceControl.gitRoutingPreference.options.git.title')).toBeTruthy();
        expect(screen.findRowByTitle('settingsSourceControl.remoteConfirmation.pull.title')).toBeTruthy();
        expect(screen.findRowByTitle('settingsSourceControl.remoteConfirmation.push.title')).toBeTruthy();
        screen.pressRowByTitle('settingsSourceControl.commitStrategy.options.gitStaging.title');
        expect(setScmCommitStrategy).toHaveBeenCalledWith('git_staging');
    });

    it('maps pull and push confirmation toggles onto the shared remote confirmation policy', async () => {
        setScmRemoteConfirmPolicy.mockClear();
        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));

        screen.pressRowByTitle('settingsSourceControl.remoteConfirmation.push.title');
        expect(setScmRemoteConfirmPolicy).toHaveBeenCalledWith('pull_only');

        screen.pressRowByTitle('settingsSourceControl.remoteConfirmation.pull.title');
        expect(setScmRemoteConfirmPolicy).toHaveBeenCalledWith('push_only');
    });

    it('defaults diff presentation style to unified when the setting is missing', async () => {
        filesDiffPresentationStyleValue = undefined;
        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        const unified = screen.findRowByTitle('settingsSourceControl.filesDisplay.diffPresentation.options.unified.title');
        const split = screen.findRowByTitle('settingsSourceControl.filesDisplay.diffPresentation.options.split.title');

        expect(unified).toBeTruthy();
        expect(split).toBeTruthy();
        expect(unified!.props.rightElement).toBeTruthy();
        expect(split!.props.rightElement).toBeFalsy();
    });

    it('only renders backend-supported default diff modes', async () => {
        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        expect(screen.findRowByTitle('settingsSourceControl.backends.defaultDiffItemTitle:Git:settingsSourceControl.diffMode.included')).toBeTruthy();
        expect(screen.findRowByTitle('settingsSourceControl.backends.defaultDiffItemTitle:Sapling:settingsSourceControl.diffMode.pending')).toBeTruthy();
        // When no snapshot/capabilities are available yet, Sapling conservatively only advertises "pending".
        expect(screen.findRowByTitle('settingsSourceControl.backends.defaultDiffItemTitle:Sapling:settingsSourceControl.diffMode.combined')).toBeNull();
        expect(screen.findRowByTitle('settingsSourceControl.backends.defaultDiffItemTitle:Sapling:settingsSourceControl.diffMode.included')).toBeNull();
    });

    it('allows updating diff syntax highlighting mode', async () => {
        setFilesDiffSyntaxHighlightingMode.mockClear();

        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        expect(screen.findRowByTitle('settingsSourceControl.filesDisplay.syntaxHighlighting.options.simple.title')).toBeTruthy();
        screen.pressRowByTitle('settingsSourceControl.filesDisplay.syntaxHighlighting.options.simple.title');

        expect(setFilesDiffSyntaxHighlightingMode).toHaveBeenCalledWith('simple');
    });

    it('allows updating files diff renderer mode', async () => {
        setFilesDiffRendererMode.mockClear();

        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        expect(screen.findRowByTitle('settingsSourceControl.filesDisplay.diffRenderer.options.happier.title')).toBeTruthy();
        screen.pressRowByTitle('settingsSourceControl.filesDisplay.diffRenderer.options.happier.title');

        expect(setFilesDiffRendererMode).toHaveBeenCalledWith('happier');
    });

    it('allows updating diff presentation style', async () => {
        setFilesDiffPresentationStyle.mockClear();

        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        expect(screen.findRowByTitle('settingsSourceControl.filesDisplay.diffPresentation.options.unified.title')).toBeTruthy();
        screen.pressRowByTitle('settingsSourceControl.filesDisplay.diffPresentation.options.unified.title');

        expect(setFilesDiffPresentationStyle).toHaveBeenCalledWith('unified');
    });

    it('allows updating changed files row density', async () => {
        setFilesChangedFilesRowDensity.mockClear();

        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        expect(screen.findRowByTitle('settingsSourceControl.filesDisplay.changedFilesDensity.options.compact.title')).toBeTruthy();
        screen.pressRowByTitle('settingsSourceControl.filesDisplay.changedFilesDensity.options.compact.title');

        expect(setFilesChangedFilesRowDensity).toHaveBeenCalledWith('compact');
    });

    it('renders commit message generator settings and allows disabling', async () => {
        setScmCommitMessageGeneratorEnabled.mockClear();

        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        expect(screen.findRowByTitle('settingsSourceControl.commitMessageGenerator.title')).toBeTruthy();
        screen.pressRowByTitle('settingsSourceControl.commitMessageGenerator.title');

        expect(setScmCommitMessageGeneratorEnabled).toHaveBeenCalledWith(false);
    });

    it('allows editing commit message generator instructions', async () => {
        setScmCommitMessageGeneratorInstructions.mockClear();

        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        const instructions = screen.findByProps({
            placeholder: 'settingsSourceControl.commitMessageGenerator.instructionsPlaceholder',
        });
        expect(instructions).toBeTruthy();

        await act(async () => {
            instructions!.props.onChangeText?.('Use imperative mood');
        });

        expect(setScmCommitMessageGeneratorInstructions).toHaveBeenCalledWith('Use imperative mood');
    });
});
