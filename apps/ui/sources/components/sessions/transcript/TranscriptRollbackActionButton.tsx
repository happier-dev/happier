import * as React from 'react';
import { ActivityIndicator, Platform, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Modal } from '@/modal';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { storage } from '@/sync/domains/state/storage';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { t } from '@/text';
import type { SessionRollbackTarget } from '@happier-dev/protocol';

export const TranscriptRollbackActionButton = React.memo((props: {
    sessionId: string;
    target?: SessionRollbackTarget;
    restoredDraftText?: string | null;
    testID?: string;
    onHoverIn?: () => void;
    onHoverOut?: () => void;
    style?: any;
    pressedStyle?: any;
}) => {
    const { theme } = useUnistyles();
    const [isRollingBack, setIsRollingBack] = React.useState(false);
    const executor = React.useMemo(
        () => createDefaultActionExecutor({ resolveServerIdForSessionId: resolveServerIdForSessionIdFromLocalCache }),
        [],
    );
    const hitSlop = Platform.OS === 'web' ? undefined : 15;

    const readInnerOkError = React.useCallback((value: unknown): { ok: boolean; errorMessage?: string } | null => {
        if (!value || typeof value !== 'object') return null;
        if (!('ok' in value)) return null;
        const ok = (value as any).ok;
        if (typeof ok !== 'boolean') return null;
        const errorMessage = (value as any).errorMessage;
        return {
            ok,
            ...(typeof errorMessage === 'string' ? { errorMessage } : null),
        };
    }, []);

    const handlePress = React.useCallback(async () => {
        if (isRollingBack) return;
        setIsRollingBack(true);
        try {
            const target = props.target ?? { type: 'latest_turn' };
            const result = await executor.execute('session.rollback', {
                sessionId: props.sessionId,
                target,
            }, {
                defaultSessionId: props.sessionId,
                surface: 'ui_button',
            });

            if (result.ok !== true) {
                Modal.alert(t('common.error'), result.error ?? t('errors.unknownError'));
                return;
            }

            const inner = readInnerOkError(result.result);
            if (inner && inner.ok !== true) {
                Modal.alert(t('common.error'), inner.errorMessage ?? t('errors.unknownError'));
                return;
            }

            const restoredDraftText = typeof props.restoredDraftText === 'string' ? props.restoredDraftText : null;
            if (restoredDraftText && restoredDraftText.trim().length > 0) {
                storage.getState().updateSessionDraft(props.sessionId, restoredDraftText);
            }
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.unknownError'));
        } finally {
            setIsRollingBack(false);
        }
    }, [executor, isRollingBack, props.restoredDraftText, props.sessionId, props.target, readInnerOkError]);

    const accessibilityLabel = props.target?.type === 'before_user_message'
        ? t('session.rollback.beforeUserMessageA11y')
        : t('session.rollback.latestTurnA11y');

    return (
        <Pressable
            testID={props.testID}
            onPress={handlePress}
            onHoverIn={props.onHoverIn}
            onHoverOut={props.onHoverOut}
            hitSlop={hitSlop}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            style={({ pressed }) => [
                props.style,
                (pressed || isRollingBack) ? props.pressedStyle : null,
            ]}
        >
            {isRollingBack ? (
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            ) : (
                <Ionicons name="arrow-undo-outline" size={12} color={theme.colors.textSecondary} />
            )}
        </Pressable>
    );
});
