import * as React from 'react';
import { ActivityIndicator, Pressable } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import type { ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import { applyFileStageAction } from '@/scm/operations/applyFileStageAction';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { t } from '@/text';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';

export type ScmCommitSelectionToggleButtonProps = Readonly<{
    sessionId: string;
    sessionPath: string | null;
    snapshot: ScmWorkingSnapshot | null;
    scmWriteEnabled: boolean;
    commitStrategy: ScmCommitStrategy;
    file: ScmFileStatus;
    selectedForCommit: boolean;
    surface: 'file' | 'files';
    onAfterToggle?: () => void | Promise<void>;
}>;

export const ScmCommitSelectionToggleButton = React.memo((props: ScmCommitSelectionToggleButtonProps) => {
    const { theme } = useUnistyles();
    const [busy, setBusy] = React.useState(false);

    const iconName = props.selectedForCommit ? 'check' : 'plus';
    const iconColor = props.selectedForCommit ? theme.colors.success : theme.colors.textSecondary;

    return (
        <Pressable
            testID={`scm-commit-selection-toggle-${toTestIdSafeValue(props.file.fullPath)}`}
            accessibilityRole="button"
            accessibilityLabel={
                props.selectedForCommit ? t('files.commitSelection.removeFromCommit') : t('files.commitSelection.addToCommit')
            }
            disabled={busy || !props.scmWriteEnabled}
            onPress={(e: any) => {
                e?.stopPropagation?.();
                fireAndForget((async () => {
                    setBusy(true);
                    try {
                        await applyFileStageAction({
                            sessionId: props.sessionId,
                            sessionPath: props.sessionPath,
                            filePath: props.file.fullPath,
                            snapshot: props.snapshot,
                            scmWriteEnabled: props.scmWriteEnabled,
                            commitStrategy: props.commitStrategy,
                            stage: !props.selectedForCommit,
                            surface: props.surface,
                        });
                        await props.onAfterToggle?.();
                    } finally {
                        setBusy(false);
                    }
                })(), { tag: 'ScmCommitSelectionToggleButton.onPress' });
            }}
            style={{
                width: 28,
                height: 28,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: theme.colors.divider,
                backgroundColor: theme.colors.surface,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: (!props.scmWriteEnabled || busy) ? 0.55 : 1,
            }}
        >
            {busy ? (
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            ) : (
                <Octicons name={iconName as any} size={14} color={iconColor} />
            )}
        </Pressable>
    );
});
