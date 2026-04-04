import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { buildWorkspaceChangedFilesData } from '@/hooks/workspaces/scm/buildWorkspaceChangedFilesData';
import { useWorkspaceScmSnapshotController } from '@/hooks/workspaces/scm/useWorkspaceScmSnapshotController';
import { NotSourceControlRepositoryState } from '@/components/workspaces/scm/states/NotSourceControlRepositoryState';
import { SourceControlUnavailableState } from '@/components/workspaces/scm/states/SourceControlUnavailableState';
import { useSetting } from '@/sync/domains/state/storage';
import { ChangedFilesReview } from '@/components/workspaces/scm/review/ChangedFilesReview';
import { fetchWorkspaceUnifiedDiffForPath } from '@/scm/diff/fetchWorkspaceUnifiedDiffForPath';
import type { ScmReviewUnifiedDiffFetcher } from '@/components/workspaces/scm/review/scmReviewDiffFetcher';

export type WorkspaceScmReviewDetailsViewProps = Readonly<{
    scopeId: string;
    workspaceRefId: string;
    workspaceCacheKey: string;
    machineId: string;
    rootPath: string;
    serverId: string;
    onOpenFile?: (path: string) => void;
    onOpenFilePinned?: (path: string) => void;
}>;

export const WorkspaceScmReviewDetailsView = React.memo((props: WorkspaceScmReviewDetailsViewProps) => {
    const { theme } = useUnistyles();
    const scmReviewMaxFilesSetting = useSetting('scmReviewMaxFiles');
    const scmReviewMaxChangedLinesSetting = useSetting('scmReviewMaxChangedLines');
    const scope = React.useMemo(() => ({
        serverId: props.serverId,
        machineId: props.machineId,
        rootPath: props.rootPath,
    }), [props.machineId, props.rootPath, props.serverId]);
    const { snapshot, loading, error, refresh } = useWorkspaceScmSnapshotController(scope);

    const maxFiles = React.useMemo(() => {
        const raw = typeof scmReviewMaxFilesSetting === 'number' && Number.isFinite(scmReviewMaxFilesSetting)
            ? scmReviewMaxFilesSetting
            : 25;
        return Math.max(1, Math.floor(raw));
    }, [scmReviewMaxFilesSetting]);
    const maxChangedLines = React.useMemo(() => {
        const raw = typeof scmReviewMaxChangedLinesSetting === 'number' && Number.isFinite(scmReviewMaxChangedLinesSetting)
            ? scmReviewMaxChangedLinesSetting
            : 2000;
        return Math.max(1, Math.floor(raw));
    }, [scmReviewMaxChangedLinesSetting]);
    const changedFiles = React.useMemo(() => buildWorkspaceChangedFilesData({ scmSnapshot: snapshot }), [snapshot]);
    const fetchUnifiedDiffForPath = React.useCallback<ScmReviewUnifiedDiffFetcher>(async (input) => {
        return await fetchWorkspaceUnifiedDiffForPath({
            scope,
            ...input,
        });
    }, [scope]);

    if (loading && !snapshot) {
        return (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 16, gap: 10 }}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                <Text style={{ color: theme.colors.textSecondary, ...Typography.default() }}>
                    {t('common.loading')}
                </Text>
            </View>
        );
    }

    if (error) {
        return (
            <SourceControlUnavailableState
                details={error.message}
                onRetry={() => {
                    void refresh();
                }}
            />
        );
    }

    if (snapshot?.repo.isRepo === false) {
        return <NotSourceControlRepositoryState />;
    }

    return (
        <View style={{ flex: 1, minHeight: 0, minWidth: 0, backgroundColor: theme.colors.surface }}>
            <ChangedFilesReview
                theme={theme}
                sessionId={props.scopeId}
                snapshot={snapshot ?? null}
                changedFilesViewMode="repository"
                attributionReliability="high"
                allRepositoryChangedFiles={changedFiles.allRepositoryChangedFiles}
                turnAttributedFiles={[]}
                turnRepositoryOnlyFiles={[]}
                sessionAttributedFiles={[]}
                repositoryOnlyFiles={changedFiles.allRepositoryChangedFiles}
                suppressedInferredCount={0}
                maxFiles={maxFiles}
                maxChangedLines={maxChangedLines}
                onFilePress={(file) => props.onOpenFile?.(file.fullPath)}
                onFilePressPinned={(file) => props.onOpenFilePinned?.(file.fullPath)}
                rowDensity="compact"
                workspaceScope={scope}
                fetchUnifiedDiffForPath={fetchUnifiedDiffForPath}
            />
        </View>
    );
});
