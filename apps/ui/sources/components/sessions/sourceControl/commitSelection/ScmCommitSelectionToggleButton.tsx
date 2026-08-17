import * as React from 'react';
import { Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import type { ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import { applyFileStageAction } from '@/scm/operations/applyFileStageAction';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { t } from '@/text';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { ActivitySpinner, iconMatchedSpinnerSize } from '@/components/ui/feedback/ActivitySpinner';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon } from '@/components/ui/icons/Icon';

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

const COMMIT_TOGGLE_ICON_SIZE_PX = 14;

export const ScmCommitSelectionToggleButton = React.memo((props: ScmCommitSelectionToggleButtonProps) => {
    const { theme } = useUnistyles();
    const [busy, setBusy] = React.useState(false);

    const iconName = props.selectedForCommit ? 'check' : 'plus';
    const iconColor = props.selectedForCommit ? theme.colors.state.success.foreground : theme.colors.text.secondary;

    return (
        <IconButton
            variant="plain"
            size={28}
            testID={`scm-commit-selection-toggle-${toTestIdSafeValue(props.file.fullPath)}`}
            accessibilityLabel={
                props.selectedForCommit ? t('files.commitSelection.removeFromCommit') : t('files.commitSelection.addToCommit')
            }
            disabled={busy || !props.scmWriteEnabled}
            icon={busy
                ? <ActivitySpinner size={iconMatchedSpinnerSize(COMMIT_TOGGLE_ICON_SIZE_PX)} color={theme.colors.text.secondary} />
                : <Icon name={iconName as any} size={COMMIT_TOGGLE_ICON_SIZE_PX} color={iconColor} />}
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
        />
    );
});
