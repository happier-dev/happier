import * as React from 'react';
import { Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import type { ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { t } from '@/text';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { applyWorkspaceFileDiscardAction } from './applyWorkspaceFileDiscardAction';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';

export type WorkspaceScmChangeDiscardButtonProps = Readonly<{
    scope: WorkspaceScopeBase;
    machineId: string;
    rootPath: string;
    snapshot: ScmWorkingSnapshot | null;
    scmWriteEnabled: boolean;
    commitStrategy: ScmCommitStrategy;
    file: ScmFileStatus;
    surface: 'file' | 'files';
    onAfterDiscard?: () => void | Promise<void>;
}>;

export const WorkspaceScmChangeDiscardButton = React.memo((props: WorkspaceScmChangeDiscardButtonProps) => {
    const { theme } = useUnistyles();
    const [busy, setBusy] = React.useState(false);

    const supported = props.snapshot?.capabilities?.writeDiscard === true;
    const disabled = busy || !props.scmWriteEnabled || !supported;

    return (
        <Pressable
            testID={`workspace-scm-discard-${toTestIdSafeValue(props.file.fullPath)}`}
            accessibilityRole="button"
            accessibilityLabel={t('files.discardChangesFor', { path: props.file.fullPath })}
            // @ts-expect-error - react-native types do not model the web-only `title` attribute; RN Web forwards it.
            title={t('files.discardChangesFor', { path: props.file.fullPath })}
            disabled={disabled}
            onPress={(e: any) => {
                e?.stopPropagation?.();
                fireAndForget((async () => {
                    setBusy(true);
                    try {
                        await applyWorkspaceFileDiscardAction({
                            scope: props.scope,
                            machineId: props.machineId,
                            rootPath: props.rootPath,
                            file: props.file,
                            snapshot: props.snapshot,
                            scmWriteEnabled: props.scmWriteEnabled,
                            commitStrategy: props.commitStrategy,
                            surface: props.surface,
                            refreshAll: props.onAfterDiscard ? async () => { await props.onAfterDiscard?.(); } : undefined,
                        });
                    } finally {
                        setBusy(false);
                    }
                })(), { tag: 'WorkspaceScmChangeDiscardButton.onPress' });
            }}
            style={{
                width: 28,
                height: 28,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: theme.colors.border.default,
                backgroundColor: theme.colors.surface.base,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: disabled ? 0.55 : 1,
            }}
        >
            {busy ? (
                <ActivitySpinner size="small" color={theme.colors.text.secondary} />
            ) : (
                <Icon name="clock-counter-clockwise" size={14} color={theme.colors.text.secondary} />
            )}
        </Pressable>
    );
});
