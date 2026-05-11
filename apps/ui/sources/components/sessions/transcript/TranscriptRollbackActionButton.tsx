import * as React from 'react';
import { ActivityIndicator, Platform, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Modal } from '@/modal';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { t } from '@/text';
import type { SessionRollbackTarget } from '@happier-dev/protocol';
import { executeTranscriptRollbackAction, type CheckpointCodeRollbackEvidence } from './transcriptRollbackActionRunner';

export const TranscriptRollbackActionButton = React.memo((props: {
    sessionId: string;
    target?: SessionRollbackTarget;
    restoredDraftText?: string | null;
    testID?: string;
    onHoverIn?: () => void;
    onHoverOut?: () => void;
    style?: any;
    pressedStyle?: any;
    checkpointCodeRollback?: CheckpointCodeRollbackEvidence;
}) => {
    const { theme } = useUnistyles();
    const sessionServerId = usePreferredServerIdForSession(props.sessionId);
    const [isRollingBack, setIsRollingBack] = React.useState(false);
    const executor = React.useMemo(
        () => createDefaultActionExecutor({
            resolveServerIdForSessionId: () => sessionServerId,
        }),
        [sessionServerId],
    );
    const hitSlop = Platform.OS === 'web' ? undefined : 15;

    const handlePress = React.useCallback(async () => {
        if (isRollingBack) return;
        setIsRollingBack(true);
        try {
            await executeTranscriptRollbackAction({
                checkpointCodeRollback: props.checkpointCodeRollback,
                executor,
                restoredDraftText: props.restoredDraftText,
                sessionId: props.sessionId,
                target: props.target,
            });
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.unknownError'));
        } finally {
            setIsRollingBack(false);
        }
    }, [executor, isRollingBack, props.checkpointCodeRollback, props.restoredDraftText, props.sessionId, props.target]);

    const accessibilityLabel = props.target?.type === 'before_user_message'
        ? t('session.rollback.beforeUserMessageA11y')
        : t('session.rollback.latestTurnA11y');

    return (
        <>
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
                <ActivityIndicator size="small" color={theme.colors.text.secondary} />
            ) : (
                <Ionicons name="arrow-undo-outline" size={12} color={theme.colors.text.secondary} />
            )}
        </Pressable>
        </>
    );
});
