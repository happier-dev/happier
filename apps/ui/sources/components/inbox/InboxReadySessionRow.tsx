import * as React from 'react';
import { Platform } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { useUnistyles } from 'react-native-unistyles';
import type { InboxPluginSessionRow } from './inboxItemProjection';
import { InboxPluginSessionLines } from './InboxPluginSessionLines';
import type { InboxPluginSessionControlInvoker } from '@/hooks/inbox/useInboxPluginSessionControls';

import { InboxWorkRow } from './InboxWorkRow';
import { Icon } from '@/components/ui/icons/Icon';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { RowSwipeAction } from '@/components/ui/lists/RowSwipeAction';
import { t } from '@/text';
import { normalizeSessionAddress, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { useSessionContentDemand } from '@/sync/domains/session/useSessionContentDemand';

import {
    SessionListIdentity,
    type SessionListIdentityDisplay,
} from '@/components/sessions/shell/SessionListIdentity';
import { SESSION_LIST_ROW_IDENTITY_METRICS } from '@/components/sessions/shell/resolveSessionListDensityViewState';
import type { WorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import type { SessionListPresentationSource } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';

const MARK_READ_ACCESSIBILITY_ACTION = 'markRead';
const NO_SESSION_ADDRESSES: readonly SessionAddress[] = [];
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
    session: React.ComponentProps<typeof SessionListIdentity>['session'];
    presentationSource?: SessionListPresentationSource;
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
    /** Availability and its owning explanation come from the shared Inbox model. */
    readUnavailableReason?: string;
    showDivider?: boolean;
    onOpen: () => void;
    onMarkRead: () => Promise<void> | void;
    /** What plugins say about this Session (a watched PR) and their declared controls, under its line. */
    pluginSessionRows?: readonly InboxPluginSessionRow[];
    invokePluginSessionControl?: InboxPluginSessionControlInvoker;
}>) {
    const { theme } = useUnistyles();
    const swipeableRef = React.useRef<Swipeable | null>(null);
    const isWeb = Platform.OS === 'web';
    const readDisabled = props.pending || Boolean(props.readUnavailableReason);
    const testIdPrefix = `inbox.ready_session.${props.serverId ?? 'local'}.${props.sessionId}`;
    // The row shows the Session by name, so it demands its content like a visible list row: an undecided one is not "locked".
    const demanded = normalizeSessionAddress(props.serverId, props.sessionId);
    useSessionContentDemand(demanded ? [demanded] : NO_SESSION_ADDRESSES, { tag: 'inbox.hydrateReadySessionRow', hydrate: 'unsettled' });

    const markRead = React.useCallback(() => {
        if (readDisabled) return;
        swipeableRef.current?.close();
        void props.onMarkRead();
    }, [props.onMarkRead, readDisabled]);

    const accessibilityActions = !isWeb && !readDisabled
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
            showDivider={props.showDivider}
            belowAccessory={props.pluginSessionRows?.length && props.invokePluginSessionControl ? (
                <InboxPluginSessionLines rows={props.pluginSessionRows} invoke={props.invokePluginSessionControl}
                    testID={`${testIdPrefix}.plugin_rows`} />
            ) : undefined}
            mark={props.identityDisplay !== 'none' ? (
                <SessionListIdentity
                    session={props.session}
                    presentationSource={props.presentationSource}
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
                    interactiveTargetGapPx={8}
                    disabled={readDisabled}
                    disabledReason={props.readUnavailableReason}
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
                <RowSwipeAction
                    testID={`${testIdPrefix}.swipe_mark_read`}
                    icon="check-circle"
                    label={props.readUnavailableReason ?? t('sessionInfo.markSessionRead')}
                    accessibilityHint={props.readUnavailableReason}
                    disabled={readDisabled}
                    busy={props.pending}
                    onPress={markRead}
                />
            )}
            overshootRight={false}
            enabled={!props.pending}
        >
            {row}
        </Swipeable>
    );
});
