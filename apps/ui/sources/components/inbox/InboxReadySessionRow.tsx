import * as React from 'react';
import { Platform, Pressable } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { InboxWorkRow } from './InboxWorkRow';
import { Icon } from '@/components/ui/icons/Icon';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { Text } from '@/components/ui/text/Text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { t } from '@/text';
import type { Session } from '@/sync/domains/state/storageTypes';
import {
    SessionListIdentity,
    type SessionListIdentityDisplay,
} from '@/components/sessions/shell/SessionListIdentity';
import { SESSION_LIST_ROW_IDENTITY_METRICS } from '@/components/sessions/shell/resolveSessionListDensityViewState';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import type { WorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';

const MARK_READ_ACCESSIBILITY_ACTION = 'markRead';
const NO_ACCESSIBILITY_ACTIONS: readonly { name: string; label?: string }[] = [];

/**
 * One completed session that is ready for review in the Inbox.
 *
 * The row navigates; marking read is always reachable, but through the
 * affordance each platform actually has. On touch platforms the row stays the
 * single focus stop and marking read is a screen-reader action on it, with the
 * swipe as the sighted accelerator — a second inline button there would add a
 * VoiceOver/TalkBack stop per row and shrink the row's own target. Web and
 * desktop have no swipe and no rotor, so they get a real focusable button.
 *
 * The leading identity matches the canonical Session-list preference; the
 * accessible name states ready-for-review without relying on colour.
 *
 * Pending belongs to the mark, never to navigation — an in-flight mark
 * withdraws only the mark-read affordance and leaves the row openable.
 */
export const InboxReadySessionRow = React.memo(function InboxReadySessionRow(props: Readonly<{
    session: Session;
    identityDisplay: SessionListIdentityDisplay;
    connected: boolean;
    sessionId: string;
    /** Exact Home scope; two Homes may hold the same session id. */
    serverId: string | null;
    title: string;
    subtitle?: string;
    /** The Session's own state word and tone, from the shared work-status owner (primitives keep the memo). */
    statusWord?: string;
    statusTone?: WorkStatusTone;
    pending: boolean;
    showDivider?: boolean;
    onOpen: () => void;
    onMarkRead: () => Promise<void> | void;
}>) {
    const { theme } = useUnistyles();
    const swipeableRef = React.useRef<Swipeable | null>(null);
    const isWeb = Platform.OS === 'web';
    const testIdPrefix = `inbox.ready_session.${props.serverId ?? 'local'}.${props.sessionId}`;

    const markRead = React.useCallback(() => {
        if (props.pending) return;
        swipeableRef.current?.close();
        void props.onMarkRead();
    }, [props.onMarkRead, props.pending]);

    const accessibilityActions = !isWeb && !props.pending
        ? [{ name: MARK_READ_ACCESSIBILITY_ACTION, label: t('sessionInfo.markSessionRead') }]
        : NO_ACCESSIBILITY_ACTIONS;
    const onAccessibilityAction = accessibilityActions.length > 0
        ? (event: { nativeEvent: { actionName: string } }) => {
            if (event.nativeEvent.actionName !== MARK_READ_ACCESSIBILITY_ACTION) return;
            markRead();
        }
        : undefined;

    const row = (
        <InboxWorkRow
            testID={testIdPrefix}
            title={props.title}
            facts={[props.subtitle]}
            status={props.statusWord ? { word: props.statusWord, tone: props.statusTone ?? 'neutral' } : null}
            phase="finished"
            accessibilityLabel={t('inbox.readySessionAccessibilityLabel', { session: props.title })}
            accessibilityActions={accessibilityActions}
            onAccessibilityAction={onAccessibilityAction}
            onPress={props.onOpen}
            mark={props.identityDisplay !== 'none' ? (
                <SessionListIdentity
                    session={props.session}
                    display={props.identityDisplay}
                    serverId={props.serverId}
                    color={theme.colors.text.primary}
                    avatarSize={SESSION_LIST_ROW_IDENTITY_METRICS.compact.slotSize}
                    agentLogoSize={SESSION_LIST_ROW_IDENTITY_METRICS.compact.agentLogoSize}
                    connected={props.connected}
                    testID={`${testIdPrefix}.identity`}
                />
            ) : undefined}
            trailingAccessory={isWeb ? (
                <IconButton
                    testID={`${testIdPrefix}.mark_read`}
                    accessibilityLabel={t('sessionInfo.markSessionRead')}
                    variant="plain"
                    size={28}
                    minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)}
                    interactiveTargetGapPx={8}
                    disabled={props.pending}
                    onPress={markRead}
                    icon={props.pending ? (
                        <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                    ) : (
                        <Icon name="check-circle" size={20} color={theme.colors.text.secondary} />
                    )}
                />
            ) : undefined}
        />
    );

    if (isWeb) return row;

    return (
        <Swipeable
            ref={swipeableRef}
            renderRightActions={() => (
                <Pressable
                    testID={`${testIdPrefix}.swipe_mark_read`}
                    accessibilityRole="button"
                    accessibilityLabel={t('sessionInfo.markSessionRead')}
                    disabled={props.pending}
                    onPress={markRead}
                    style={({ pressed }) => [
                        styles.swipeAction,
                        pressed ? styles.swipeActionPressed : null,
                        props.pending ? styles.swipeActionPending : null,
                    ]}
                >
                    {props.pending ? (
                        <ActivitySpinner size="small" color={theme.colors.button.primary.tint} />
                    ) : (
                        <Icon name="check-circle" size={20} color={theme.colors.button.primary.tint} />
                    )}
                    <Text style={styles.swipeActionText} numberOfLines={2}>
                        {t('sessionInfo.markSessionRead')}
                    </Text>
                </Pressable>
            )}
            overshootRight={false}
            enabled={!props.pending}
        >
            {row}
        </Swipeable>
    );
});

const styles = StyleSheet.create((theme) => ({
    swipeAction: {
        width: 112,
        height: '100%',
        minHeight: 48,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.button.primary.background,
        paddingHorizontal: 12,
    },
    swipeActionPressed: {
        opacity: motionTokens.press.opacity,
    },
    swipeActionPending: {
        opacity: 0.56,
    },
    swipeActionText: {
        marginTop: 4,
        fontSize: 12,
        color: theme.colors.button.primary.tint,
        textAlign: 'center',
    },
}));
