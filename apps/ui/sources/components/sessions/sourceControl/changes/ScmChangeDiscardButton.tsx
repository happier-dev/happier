import * as React from 'react';
import { ActivityIndicator, Pressable } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import type { ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import { applyFileDiscardAction } from '@/scm/operations/applyFileDiscardAction';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { t } from '@/text';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';

export type ScmChangeDiscardButtonProps = Readonly<{
    sessionId: string;
    sessionPath: string | null;
    snapshot: ScmWorkingSnapshot | null;
    scmWriteEnabled: boolean;
    commitStrategy: ScmCommitStrategy;
    file: ScmFileStatus;
    surface: 'file' | 'files';
    onAfterDiscard?: () => void | Promise<void>;
}>;

export const ScmChangeDiscardButton = React.memo((props: ScmChangeDiscardButtonProps) => {
    const { theme } = useUnistyles();
    const [busy, setBusy] = React.useState(false);

    const supported = props.snapshot?.capabilities?.writeDiscard === true;
    const disabled = busy || !props.scmWriteEnabled || !supported;

    return (
        <Pressable
            testID={`scm-discard-${toTestIdSafeValue(props.file.fullPath)}`}
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
                        await applyFileDiscardAction({
                            sessionId: props.sessionId,
                            sessionPath: props.sessionPath,
                            file: props.file,
                            snapshot: props.snapshot,
                            scmWriteEnabled: props.scmWriteEnabled,
                            commitStrategy: props.commitStrategy,
                            surface: props.surface,
                        });
                        await props.onAfterDiscard?.();
                    } finally {
                        setBusy(false);
                    }
                })(), { tag: 'ScmChangeDiscardButton.onPress' });
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
                opacity: disabled ? 0.55 : 1,
            }}
        >
            {busy ? (
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            ) : (
                <Octicons name="history" size={14} color={theme.colors.textSecondary} />
            )}
        </Pressable>
    );
});
