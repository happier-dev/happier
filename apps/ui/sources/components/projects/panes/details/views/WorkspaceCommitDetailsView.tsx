import * as React from 'react';
import { Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';
import { machineScmDiffCommit } from '@/sync/ops/scm/machineScm';
import { buildDiffBlocks, buildDiffFileEntries } from '@/components/ui/code/model/diff/diffViewModel';
import { DiffFilesListView } from '@/components/ui/code/diff/DiffFilesListView';
import { useSetting } from '@/sync/domains/state/storage';
import { WrapLinesToggleButton } from '@/components/ui/code/WrapLinesToggleButton';
import { DiffPresentationStyleToggleButton } from '@/components/ui/code/diff/DiffPresentationStyleToggleButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { DetailsDiffSummaryRow } from '@/components/appShell/panes/details/header/DetailsDiffSummaryRow';
import { ScmCommitDetailsHeader } from '@/components/workspaces/scm/history/ScmCommitDetailsHeader';
import { useScmCommitLogEntry } from '@/scm/history/useScmCommitLogEntry';

export type WorkspaceCommitDetailsViewProps = Readonly<{
    scopeId: string;
    workspaceRefId: string;
    workspaceCacheKey: string;
    machineId: string;
    rootPath: string;
    serverId: string;
    sha: string;
    presentation?: 'screen' | 'panel';
    onOpenFile?: (filePath: string) => void;
    onOpenFilePinned?: (filePath: string) => void;
}>;

export const WorkspaceCommitDetailsView = React.memo((props: WorkspaceCommitDetailsViewProps) => {
    const { theme } = useUnistyles();
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);
    const [diff, setDiff] = React.useState('');

    const commitScope = React.useMemo(
        () => ({ serverId: props.serverId, machineId: props.machineId, rootPath: props.rootPath }),
        [props.machineId, props.rootPath, props.serverId],
    );
    const commitEntry = useScmCommitLogEntry(commitScope, props.sha);
    const [reloadToken, setReloadToken] = React.useState(0);
    const wrapLines = useSetting('wrapLinesInDiffs') === true;
    const showLineNumbers = useSetting('showLineNumbers') === true;

    React.useEffect(() => {
        let active = true;
        void (async () => {
            setLoading(true);
            setError(null);
            try {
                const response = await machineScmDiffCommit(
                    props.machineId,
                    { cwd: props.rootPath, commit: props.sha },
                    { serverId: props.serverId },
                );
                if (!active) return;
                if (!response.success) {
                    setError(response.error || t('files.commitDetails.failedToLoadDiff'));
                    setDiff('');
                    return;
                }
                setDiff(response.diff ?? '');
            } catch (err) {
                if (!active) return;
                setError(err instanceof Error ? err.message : t('files.commitDetails.failedToLoadDiff'));
                setDiff('');
            } finally {
                if (active) setLoading(false);
            }
        })();
        return () => {
            active = false;
        };
    }, [props.machineId, props.rootPath, props.serverId, props.sha, reloadToken]);

    if (loading) {
        return <SurfaceStateCard testID="workspace-commit-details-loading" kind="loading" title={t('surfaceState.opening', { name: props.sha.slice(0, 7) })} />;
    }

    if (error) {
        // Pane-states lab 0: what failed in words and one recovery; the transport text is the diagnostic.
        return (
            <SurfaceStateCard
                testID="workspace-commit-details-error"
                kind="error"
                iconName="git-commit"
                title={t('files.commitDetails.couldNotOpenTitle', { sha: props.sha.slice(0, 7) })}
                reason={t('files.commitDetails.couldNotOpenReason')}
                diagnosticCode={error}
                action={{ label: t('surfaceState.tryAgain'), onPress: () => setReloadToken((token) => token + 1) }}
            />
        );
    }

    const diffBlocks = buildDiffBlocks({ unified_diff: diff });
    const files = buildDiffFileEntries(diffBlocks);
    const allKeys = files.map((f) => f.key);
    const expandedKeys = new Set(allKeys);

    return (
        <View style={{ flex: 1, minHeight: 0, minWidth: 0, backgroundColor: theme.colors.surface.base }}>
            <ScmCommitDetailsHeader
                sha={props.sha}
                commit={commitEntry}
                actions={files.length > 0 ? (
                    <>
                        {Platform.OS === 'web' ? <DiffPresentationStyleToggleButton presentation="segmented" /> : null}
                        <WrapLinesToggleButton />
                    </>
                ) : null}
            />
            <DetailsDiffSummaryRow
                label={t('detailsSurface.history.filesChanged', { count: files.length })}
                added={files.reduce((sum, file) => sum + Math.max(0, typeof file.added === 'number' ? file.added : 0), 0)}
                removed={files.reduce((sum, file) => sum + Math.max(0, typeof file.removed === 'number' ? file.removed : 0), 0)}
            />
            <DiffFilesListView
                files={files}
                expandedKeys={expandedKeys}
                onToggleExpanded={() => {}}
                canRenderInlineDiffs
                wrapLines={wrapLines}
                showLineNumbers={showLineNumbers}
                showPrefix={showLineNumbers}
                onOpenFile={props.onOpenFile}
                onOpenFilePinned={props.onOpenFilePinned}
            />
        </View>
    );
});
