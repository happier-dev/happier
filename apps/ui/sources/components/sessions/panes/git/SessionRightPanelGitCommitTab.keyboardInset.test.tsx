import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionGitPaneCommonModuleMocks } from './sessionGitPaneTestHelpers';
import type { SessionAttributedFile } from '@/scm/scmAttribution';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installSessionGitPaneCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            FlatList: 'FlatList',
            ScrollView: 'ScrollView',
            Pressable: 'Pressable',
            Platform: {
                OS: 'ios',
                select: (value: Record<string, unknown>) => value.ios ?? value.native ?? value.default ?? null,
            },
        });
    },
});

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => 216,
}));

vi.mock('@/components/sessions/files/SourceControlBranchSummary', () => ({
    SourceControlBranchSummary: (props: Record<string, unknown>) => React.createElement('SourceControlBranchSummary', props),
}));

vi.mock('@/components/sessions/sourceControl/commitComposer/ScmCommitComposerCard', () => ({
    ScmCommitComposerCard: (props: Record<string, unknown>) => React.createElement('ScmCommitComposerCard', props),
}));

vi.mock('@/components/sessions/sourceControl/changes/ScmChangeRow', () => ({
    ScmChangeRow: (props: Record<string, unknown>) => React.createElement('ScmChangeRow', props),
    resolveScmChangeStatsColumnWidth: () => 38,
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

function findAncestorStyleValue(instance: ReactTestInstance | null, key: string): unknown {
    let current = instance?.parent ?? null;
    while (current) {
        const value = flattenStyle(current.props.style)[key];
        if (value !== undefined) return value;
        current = current.parent;
    }
    return undefined;
}

describe('SessionRightPanelGitCommitTab (keyboard inset)', () => {
    it('keeps the commit composer footer above the native keyboard', async () => {
        const { SessionRightPanelGitCommitTab } = await import('./SessionRightPanelGitCommitTab');
        const emptyFiles: ScmFileStatus[] = [];
        const emptyAttributedFiles: SessionAttributedFile[] = [];

        const screen = await renderScreen(
            <SessionRightPanelGitCommitTab
                theme={{ colors: { divider: '#ddd', surface: '#fff', surfaceHigh: '#f6f6f6', text: '#000', textSecondary: '#666', success: '#0a0', warning: '#f90', textLink: '#09f', danger: '#c00' } }}
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
                allRepositoryChangedFiles={emptyFiles}
                sessionAttributedFiles={emptyAttributedFiles}
                repositoryOnlyFiles={emptyFiles}
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
            />,
        );

        const composer = screen.findByProps({ variant: 'railFooter' });
        expect(findAncestorStyleValue(composer, 'marginBottom')).toBe(216);
    });
});
