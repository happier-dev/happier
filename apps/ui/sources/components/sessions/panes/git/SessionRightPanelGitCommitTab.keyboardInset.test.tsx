import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionGitPaneCommonModuleMocks } from './sessionGitPaneTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionGitPaneCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            FlatList: 'FlatList',
            ScrollView: 'ScrollView',
            Pressable: 'Pressable',
            Platform: {
                select: (value: any) => value?.default ?? null,
                OS: 'ios',
            },
            AppState: {
                currentState: 'active',
                addEventListener: () => ({ remove: () => {} }),
            },
        });
    },
});

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => 216,
}));

vi.mock('@/components/workspaces/scm/SourceControlBranchSummary', () => ({
    SourceControlBranchSummary: (props: any) => React.createElement('SourceControlBranchSummary', props),
}));

vi.mock('@/components/sessions/sourceControl/commitSelection/ScmChangesSelectionHeaderRow', () => ({
    ScmChangesSelectionHeaderRow: (props: any) => React.createElement('ScmChangesSelectionHeaderRow', props),
}));

vi.mock('@/components/workspaces/scm/commitComposer/ScmCommitComposerCard', () => ({
    ScmCommitComposerCard: (props: any) => React.createElement('ScmCommitComposerCard', props),
}));

vi.mock('@/components/workspaces/scm/changes/ScmChangeRow', () => ({
    ScmChangeRow: (props: any) => React.createElement('ScmChangeRow', props),
    resolveScmChangeStatsColumnWidth: (files: readonly any[]) => {
        const maxLabelLength = files.reduce((maxLength, file) => {
            const added = Number.isFinite(file?.linesAdded) ? String(Math.max(0, Math.trunc(file.linesAdded))) : '0';
            const removed = Number.isFinite(file?.linesRemoved) ? String(Math.max(0, Math.trunc(file.linesRemoved))) : '0';
            return Math.max(maxLength, `+${added}/-${removed}`.length);
        }, 0);
        return Math.max(38, maxLabelLength * 7 + 4);
    },
}));

function getStyleValue(node: ReactTestInstance, key: string): unknown {
    const styles = Array.isArray(node.props.style) ? node.props.style : [node.props.style];
    for (const entry of styles) {
        if (entry && typeof entry === 'object' && key in entry) {
            return (entry as Record<string, unknown>)[key];
        }
    }
    return undefined;
}

describe('SessionRightPanelGitCommitTab (keyboard inset)', () => {
    it('offsets the commit composer footer by the native keyboard height', async () => {
        const { SessionRightPanelGitCommitTab } = await import('./SessionRightPanelGitCommitTab');

        const screen = await renderScreen(<SessionRightPanelGitCommitTab
            theme={{
                colors: {
                    border: { default: '#ddd' },
                    divider: '#ddd',
                    surface: { base: '#fff', inset: '#f6f6f6' },
                    surfaceHigh: '#f6f6f6',
                    text: { primary: '#000', secondary: '#666' },
                    textSecondary: '#666',
                    success: '#0a0',
                    warning: '#f90',
                    textLink: '#09f',
                    danger: '#c00',
                },
            }}
            sessionId="s1"
            sessionPath="/workspace"
            backendLabel="Git"
            commitActionLabel="Commit"
            scmSnapshot={null}
            hasConflicts={false}
            scmOperationBusy={false}
            scmOperationStatus={null}
            hasGlobalOperationInFlight={false}
            inFlightScmOperation={null}
            commitAllowed={false}
            commitBlockedMessage={null}
            changedFilesViewMode="repository"
            attributionReliability="high"
            allRepositoryChangedFiles={[] as any}
            sessionAttributedFiles={[] as any}
            repositoryOnlyFiles={[] as any}
            suppressedInferredCount={0}
            repositorySelectedCount={0}
            onSelectAll={() => {}}
            onSelectNone={() => {}}
            disableSelectAll={true}
            disableSelectNone={true}
            onFilePress={() => {}}
            onFilePressPinned={() => {}}
            onToggleSelectionForFile={() => {}}
            renderFileActions={() => null}
            renderFileTrailingActions={() => null}
            commitDraftMessage=""
            onCommitDraftMessageChange={() => {}}
            onCommitFromMessage={() => {}}
            commitMessageGeneratorEnabled={false}
            onGenerateCommitMessageSuggestion={async () => ({ ok: true, message: '' })}
            scmStatusFiles={null}
            showCommitComposer={true}
        />);

        const composer = screen.findByProps({ variant: 'railFooter' });
        let current: ReactTestInstance | null = composer;
        let footerMarginBottom: unknown;
        while (current) {
            footerMarginBottom = getStyleValue(current, 'marginBottom');
            if (footerMarginBottom !== undefined) break;
            current = current.parent;
        }

        expect(footerMarginBottom).toBe(216);
    });
});
