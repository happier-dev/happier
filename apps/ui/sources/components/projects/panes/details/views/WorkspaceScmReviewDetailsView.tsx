import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { machineScmDiffFile, machineScmStatusSnapshot } from '@/sync/ops/scm/machineScm';
import { buildWorkspaceChangedFilesData } from '@/hooks/workspaces/scm/buildWorkspaceChangedFilesData';
import { DiffFilesListView } from '@/components/ui/code/diff/DiffFilesListView';
import { buildDiffBlocks, buildDiffFileEntries } from '@/components/ui/code/model/diff/diffViewModel';
import { NotSourceControlRepositoryState } from '@/components/sessions/sourceControl/states/NotSourceControlRepositoryState';
import { SourceControlUnavailableState } from '@/components/sessions/sourceControl/states/SourceControlUnavailableState';
import { useSetting } from '@/sync/domains/state/storage';

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
    const wrapLines = useSetting('wrapLinesInDiffs') === true;
    const showLineNumbers = useSetting('showLineNumbers') === true;
    const scmReviewMaxFilesSetting = useSetting('scmReviewMaxFiles');

    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);
    const [isRepo, setIsRepo] = React.useState<boolean | null>(null);
    const [diff, setDiff] = React.useState('');

    const maxFiles = React.useMemo(() => {
        const raw = typeof scmReviewMaxFilesSetting === 'number' && Number.isFinite(scmReviewMaxFilesSetting)
            ? scmReviewMaxFilesSetting
            : 25;
        return Math.max(1, Math.floor(raw));
    }, [scmReviewMaxFilesSetting]);

    const refresh = React.useCallback(async () => {
        setLoading(true);
        setError(null);
        setIsRepo(null);
        setDiff('');

        try {
            const status = await machineScmStatusSnapshot(props.machineId, { cwd: props.rootPath });
            if (!status.success || !status.snapshot) {
                setError(status.error || t('errors.tryAgain'));
                return;
            }
            if (status.snapshot.repo.isRepo === false) {
                setIsRepo(false);
                return;
            }
            setIsRepo(true);

            const { allRepositoryChangedFiles } = buildWorkspaceChangedFilesData({ scmSnapshot: status.snapshot });
            const changed = allRepositoryChangedFiles.slice(0, maxFiles);
            if (changed.length === 0) {
                setDiff('');
                return;
            }

            let combined = '';
            for (const file of changed) {
                const response = await machineScmDiffFile(props.machineId, {
                    cwd: props.rootPath,
                    path: file.fullPath,
                    area: 'both',
                });
                if (!response.success) {
                    setError(response.error || t('errors.tryAgain'));
                    return;
                }
                const patch = response.diff ?? '';
                if (!patch.trim()) continue;
                if (combined.length > 0 && !combined.endsWith('\n')) combined += '\n';
                combined += patch;
                if (!combined.endsWith('\n')) combined += '\n';
            }

            setDiff(combined);
        } catch (err) {
            setError(err instanceof Error ? err.message : t('errors.tryAgain'));
        } finally {
            setLoading(false);
        }
    }, [maxFiles, props.machineId, props.rootPath]);

    React.useEffect(() => {
        void refresh();
    }, [refresh]);

    if (loading) {
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
                details={error}
                onRetry={() => {
                    void refresh();
                }}
            />
        );
    }

    if (isRepo === false) {
        return <NotSourceControlRepositoryState />;
    }

    if (!diff.trim()) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
                <Text style={{ color: theme.colors.textSecondary, ...Typography.default(), textAlign: 'center' }}>
                    {t('files.noChanges')}
                </Text>
            </View>
        );
    }

    const diffBlocks = buildDiffBlocks({ unified_diff: diff });
    const files = buildDiffFileEntries(diffBlocks);
    const expandedKeys = new Set(files.map((f) => f.key));

    return (
        <View style={{ flex: 1, minHeight: 0, minWidth: 0, backgroundColor: theme.colors.surface }}>
            <DiffFilesListView
                files={files}
                expandedKeys={expandedKeys}
                onToggleExpanded={() => {}}
                canRenderInlineDiffs
                wrapLines={wrapLines}
                showLineNumbers={showLineNumbers}
                showPrefix={showLineNumbers}
                virtualizeFileList
                onOpenFile={props.onOpenFile}
                onOpenFilePinned={props.onOpenFilePinned}
            />
        </View>
    );
});
