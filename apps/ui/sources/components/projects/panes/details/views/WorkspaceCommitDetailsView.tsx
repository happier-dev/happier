import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { machineScmDiffCommit } from '@/sync/ops/scm/machineScm';
import { buildDiffBlocks, buildDiffFileEntries } from '@/components/ui/code/model/diff/diffViewModel';
import { DiffFilesListView } from '@/components/ui/code/diff/DiffFilesListView';
import { useSetting } from '@/sync/domains/state/storage';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

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
    }, [props.machineId, props.rootPath, props.serverId, props.sha]);

    if (loading) {
        return (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 16, gap: 10 }}>
                <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                <Text style={{ color: theme.colors.text.secondary, ...Typography.default() }}>
                    {t('common.loading')}
                </Text>
            </View>
        );
    }

    if (error) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
                <Text style={{ color: theme.colors.text.secondary, ...Typography.default(), textAlign: 'center' }}>
                    {error}
                </Text>
            </View>
        );
    }

    const diffBlocks = buildDiffBlocks({ unified_diff: diff });
    const files = buildDiffFileEntries(diffBlocks);
    const allKeys = files.map((f) => f.key);
    const expandedKeys = new Set(allKeys);

    return (
        <View style={{ flex: 1, minHeight: 0, minWidth: 0, backgroundColor: theme.colors.surface.base }}>
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
