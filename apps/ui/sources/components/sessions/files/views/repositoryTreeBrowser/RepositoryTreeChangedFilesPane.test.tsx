import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const changedFilesDataSpy = vi.fn();
const derivedSessionChangeSetSpy = vi.fn();

vi.mock('react-native', async () => {
    const stub = await import('@/dev/reactNativeStub');
    return {
        ...stub,
        Platform: { OS: 'web', select: (value: any) => value?.default ?? null },
    };
});

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                surface: '#fff',
                surfaceHigh: '#f5f5f5',
                divider: '#eee',
                text: '#000',
                textSecondary: '#666',
                textLink: '#08f',
                input: { background: '#fff', placeholder: '#666' },
                success: '#0a0',
                warning: '#fa0',
            },
        },
    }),
    StyleSheet: {
        create: (value: any) => value,
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
        mono: () => ({}),
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useProjectForSession: () => ({ id: 'p1' }),
    useProjectSessions: () => ['s1'],
    useSessionProjectScmTouchedPaths: () => ['session-changes-qa-root.txt'],
    useSessionProjectScmOperationLog: () => [],
    useSetting: (key: string) => {
        if (key === 'scmReviewMaxFiles') return 25;
        if (key === 'scmReviewMaxChangedLines') return 2000;
        return null;
    },
}));

vi.mock('@/hooks/session/files/useChangedFilesData', () => ({
    useChangedFilesData: (input: unknown) => changedFilesDataSpy(input),
}));

vi.mock('@/sync/domains/session/changes/hooks/useDerivedSessionChangeSet', () => ({
    useDerivedSessionChangeSet: (sessionId: string) => derivedSessionChangeSetSpy(sessionId),
}));

vi.mock('@/components/sessions/files/content/ChangedFilesList', () => ({
    ChangedFilesList: (props: any) => React.createElement('ChangedFilesList', props),
}));

vi.mock('@/components/sessions/files/content/ChangedFilesReview', () => ({
    ChangedFilesReview: (props: any) => React.createElement('ChangedFilesReview', props),
}));

describe('RepositoryTreeChangedFilesPane', () => {
    it('surfaces turn/session toggles in the repository browser changed-files pane and can switch to review mode', async () => {
        changedFilesDataSpy.mockReturnValue({
            attributionReliability: 'high',
            showTurnViewToggle: true,
            showSessionViewToggle: true,
            scmStatusFiles: null,
            changedFilesCount: 1,
            shouldShowAllFiles: false,
            allRepositoryChangedFiles: [{ fullPath: 'session-changes-qa-root.txt', fileName: 'session-changes-qa-root.txt' }],
            turnAttributedFiles: [{ file: { fullPath: 'session-changes-qa-root.txt', fileName: 'session-changes-qa-root.txt' }, confidence: 'high' }],
            turnRepositoryOnlyFiles: [],
            sessionAttributedFiles: [{ file: { fullPath: 'session-changes-qa-root.txt', fileName: 'session-changes-qa-root.txt' }, confidence: 'high' }],
            repositoryOnlyFiles: [],
            suppressedInferredCount: 0,
        });
        derivedSessionChangeSetSpy.mockReturnValue({
            latestTurnScopedChangeSet: { sessionId: 's1', files: [{ filePath: 'session-changes-qa-root.txt' }] },
            sessionChangeSet: { sessionId: 's1', files: [{ filePath: 'session-changes-qa-root.txt' }] },
            latestTurnDiffByPath: new Map([['session-changes-qa-root.txt', 'diff --git a/session-changes-qa-root.txt b/session-changes-qa-root.txt']]),
            providerDiffByPath: new Map([['session-changes-qa-root.txt', 'diff --git a/session-changes-qa-root.txt b/session-changes-qa-root.txt']]),
        });

        const onShowAllRepositoryFiles = vi.fn();
        let tree: renderer.ReactTestRenderer | null = null;

        const { RepositoryTreeChangedFilesPane } = await import('./RepositoryTreeChangedFilesPane');

        act(() => {
            tree = renderer.create(
                <RepositoryTreeChangedFilesPane
                    sessionId="s1"
                    scmSnapshot={null}
                    searchQuery=""
                    onSearchQueryChange={vi.fn()}
                    onShowAllRepositoryFiles={onShowAllRepositoryFiles}
                    onOpenFile={vi.fn()}
                />,
            );
        });

        const getPressables = () => tree!.root.findAll((node: any) => typeof node.props?.onPress === 'function');
        const labels = getPressables().map((node: any) => node.findAllByType('TextInput' as any).length === 0
            ? node.findAll((child: any) => typeof child.props?.children === 'string').map((child: any) => child.props.children).join(' ')
            : '');

        expect(labels.some((label: string) => label.includes('files.toolbar.turnView'))).toBe(true);
        expect(labels.some((label: string) => label.includes('files.toolbar.sessionView'))).toBe(true);
        expect(tree!.root.findAllByType('ChangedFilesList' as any)).toHaveLength(1);
        expect(tree!.root.findAllByType('ChangedFilesReview' as any)).toHaveLength(0);

        const reviewToggle = getPressables().find((node: any) =>
            node.findAll((child: any) => child.props?.children === 'files.toolbar.review').length > 0,
        );
        expect(reviewToggle).toBeTruthy();

        act(() => {
            reviewToggle!.props.onPress();
        });

        expect(tree!.root.findAllByType('ChangedFilesReview' as any)).toHaveLength(1);

        const allRepositoryFilesToggle = getPressables().find((node: any) =>
            node.findAll((child: any) => child.props?.children === 'files.toolbar.allRepositoryFiles').length > 0,
        );
        expect(allRepositoryFilesToggle).toBeTruthy();

        act(() => {
            allRepositoryFilesToggle!.props.onPress();
        });

        expect(onShowAllRepositoryFiles).toHaveBeenCalledTimes(1);
    });
});
