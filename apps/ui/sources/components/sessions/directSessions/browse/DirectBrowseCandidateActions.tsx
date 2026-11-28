import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { IconAction } from '@/components/ui/buttons/IconAction';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { Modal } from '@/modal';
import { t } from '@/text';

export const DirectBrowseCandidateActions = React.memo(function DirectBrowseCandidateActions(props: Readonly<{
    candidateTitle: string;
    candidateId: string;
    providerLabel: string;
    deleting: boolean;
    onDelete: () => void | Promise<void>;
    canDelete?: boolean;
    onKeep?: () => void;
}>) {
    const { theme } = useUnistyles();
    const { candidateId, candidateTitle, deleting, onDelete, providerLabel } = props;
    const confirmDelete = React.useCallback(() => {
        void (async () => {
            const confirmed = await Modal.confirm(
                t('directSessions.deleteCandidateConfirmTitle'),
                t('directSessions.deleteCandidateConfirmMessage', {
                    title: candidateTitle,
                    provider: providerLabel,
                }),
                {
                    cancelText: t('common.cancel'),
                    confirmText: t('common.delete'),
                    destructive: true,
                },
            );
            if (confirmed) await onDelete();
        })();
    }, [candidateTitle, onDelete, providerLabel]);

    const { onKeep, canDelete = true } = props;
    const actions = React.useMemo((): ItemAction[] => [
        ...(onKeep ? [{
            id: 'keep_local_session',
            title: t('keepOrLetGo.localKeepSession'),
            icon: 'clock' as const,
            onPress: onKeep,
        }] : []),
        ...(canDelete ? [{
            id: 'delete_provider_session',
            title: t('common.delete'),
            icon: 'trash' as const,
            destructive: true,
            disabled: deleting,
            onPress: confirmDelete,
        }] : []),
    ], [canDelete, confirmDelete, deleting, onKeep]);

    return (
        <ItemRowActions
            title={candidateTitle}
            actions={actions}
            compactThreshold={Number.POSITIVE_INFINITY}
            compactActionIds={[]}
            overflowTriggerTestID={`direct-session-candidate-actions:${candidateId}`}
            renderOverflowTrigger={({ toggle, testID }) => (
                <IconAction
                    testID={testID}
                    size="sm"
                    hitSlop={8}
                    accessibilityLabel={t('directSessions.deleteCandidateActionsAccessibilityLabel', {
                        title: candidateTitle,
                    })}
                    onPress={(event) => {
                        event?.stopPropagation?.();
                        toggle();
                    }}
                >
                    <Icon name="dots-three" size={18} color={theme.colors.text.secondary} />
                </IconAction>
            )}
        />
    );
});
