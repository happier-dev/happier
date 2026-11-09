import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { AvatarStack } from '@/components/ui/avatar/AvatarStack';
import { Item } from '@/components/ui/lists/Item';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { ITEM_SUBTITLE_TEXT_METRICS, ITEM_TITLE_TEXT_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { useMountedRef } from '@/hooks/ui/useMountedRef';
import { t } from '@/text';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { useSessionHumanPresence } from '@/sync/domains/session/humanPresence/useSessionHumanPresence';
import { PoliteAccessibilityStatus } from '@/components/ui/accessibility/PoliteAccessibilityStatus';
import { STALE_PRESENCE_OPACITY } from './SessionViewerFacepile';
import { formatSessionPresenceHere, formatSessionPresenceTyping, formatSessionPresenceViewerNames } from './sessionPresenceNames';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';

const AVATAR_PX = 28;

const styles = StyleSheet.create((theme) => ({
    // Retained last-known rows are de-emphasized exactly like the header
    // facepile. The `May be out of date` text carries the meaning; the
    // treatment never relies on color alone.
    stale: { opacity: STALE_PRESENCE_OPACITY },
    presenceDot: { position: 'absolute', right: -1, bottom: -1 },
    title: {
        ...Typography.default('semiBold'),
        ...ITEM_TITLE_TEXT_METRICS.compact,
        color: theme.colors.text.primary,
    },
    titleQuiet: { ...Typography.default(), color: theme.colors.text.secondary },
    subtitle: {
        ...Typography.default(),
        ...ITEM_SUBTITLE_TEXT_METRICS.compact,
        color: theme.colors.text.secondary,
    },
}));

/**
 * The present, in one line at the top of the Collaboration pane (lab `collab` C1): live avatars with
 * the presence dot, "Ana and Ben are here", and "Ben is typing…" beneath. It never collapses: while
 * connecting, alone, unanswered or unsupported it keeps its line and says which.
 */
export function SessionPresenceSection(target: SessionAddress) {
    const presence = useSessionHumanPresence(target);
    const { theme } = useUnistyles();
    // The plan announces a viewer arrival or departure only to someone who has
    // navigated INTO this region; an unfocused polite region speaks every
    // presence change of every open Session.
    const [regionFocused, setRegionFocused] = React.useState(false);
    const onRegionFocus = React.useCallback(() => setRegionFocused(true), []);
    const onRegionBlur = React.useCallback(() => setRegionFocused(false), []);
    const mounted = useMountedRef();
    const summaryAnchor = React.useRef<React.ElementRef<typeof View>>(null);
    const modalId = React.useRef<string | null>(null);
    const currentTarget = React.useRef(target);
    currentTarget.current = target;
    React.useEffect(() => () => {
        if (modalId.current) Modal.hide(modalId.current);
        modalId.current = null;
    }, [target.serverId, target.sessionId]);

    const viewers = presence.viewers;
    const hasViewers = viewers.length > 0;
    const retained = presence.status === 'stale' || (presence.status === 'unavailable' && hasViewers);
    const live = presence.status === 'live';
    const title = presence.status === 'unsupported' ? t('session.collaboration.pane.presenceUnsupported')
        : presence.status === 'connecting' && !hasViewers ? t('session.collaboration.pane.presenceConnecting')
            : presence.status === 'unavailable' && !hasViewers ? t('session.collaboration.pane.presenceUnavailable')
                : formatSessionPresenceHere(viewers);
    const subtitle = retained ? t('session.collaboration.stale')
        // Alone, the title says it; who could join is the access card's to say (one message per state).
        : live && hasViewers ? formatSessionPresenceTyping(viewers) ?? t('session.collaboration.viewingNow')
            : null;
    const names = formatSessionPresenceViewerNames(viewers, { stale: !live });
    // Membership and reachability are the meaningful transitions. A typing
    // renewal keeps this key, so the one live-region owner coalesces it away.
    const membershipTransitionKey = `${presence.status}|${viewers.map((viewer) => viewer.account.accountId).join(',')}`;
    const announcement = `${t('session.collaboration.viewingNow')}: ${hasViewers ? formatSessionPresenceViewerNames(viewers, { stale: true }) : title}`;
    const openViewers = async () => {
        const { SessionPresenceViewerList } = await import('./SessionPresenceViewerList');
        if (!mounted.current || currentTarget.current.serverId !== target.serverId || currentTarget.current.sessionId !== target.sessionId) return;
        if (modalId.current) return;
        const id = Modal.show({
            component: SessionPresenceViewerList,
            props: { target },
            chrome: { kind: 'card', title: t('session.collaboration.viewingNow'), dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide, maxHeightRatio: 0.85, size: 'md' } },
            // Closing the complete viewer list returns focus to the summary that
            // opened it, through the canonical modal focus-return contract.
            focusReturnRef: summaryAnchor,
            onDismissRequest: () => { modalId.current = null; },
            closeOnBackdrop: true,
        });
        if (!mounted.current || currentTarget.current.serverId !== target.serverId || currentTarget.current.sessionId !== target.sessionId) Modal.hide(id);
        else modalId.current = id;
    };
    const lead = hasViewers ? (
        <AvatarStack size={AVATAR_PX} entries={viewers.slice(0, 3).map((viewer) => ({
            key: viewer.account.accountId,
            content: <View>
                    <Avatar id={viewer.account.accountId} size={AVATAR_PX} imageUrl={viewer.account.avatarUrl} />
                    {live ? (
                        <View style={styles.presenceDot}>
                            <StatusDot color={theme.colors.state.success.foreground} size={8} />
                        </View>
                    ) : null}
                </View>,
        }))} />
    ) : null;
    // Alone, the line's glyph takes the pane's icon slot, so its words start on the rows' text edge.
    const glyph = hasViewers ? undefined : (
        <View accessible={false} importantForAccessibility="no-hide-descendants">
            {presence.status === 'connecting'
                ? <ActivitySpinner size="small" />
                : <Icon name={presence.status === 'unsupported' || presence.status === 'unavailable' ? 'cloud-slash' : 'users'} size={18} color={theme.colors.text.tertiary} />}
        </View>
    );
    return <View testID="session-presence-section">
        <View ref={summaryAnchor} tabIndex={-1} testID="session-presence-summary-anchor"
            onFocus={onRegionFocus} onBlur={onRegionBlur}
            style={retained ? styles.stale : undefined}>
            <Item
                testID="session-presence-summary"
                accessibilityRole={hasViewers ? 'button' : 'text'}
                accessibilityLabel={`${title}${names ? `. ${names}` : ''}${subtitle && !names.includes(subtitle) ? `. ${subtitle}` : ''}`}
                accessibilityHint={hasViewers ? t('session.collaboration.viewingNow') : undefined}
                mode={hasViewers ? 'interactive' : 'info'}
                onPress={hasViewers ? () => { void openViewers(); } : undefined}
                density="compact"
                showChevron={false}
                showDivider={false}
                leftElement={lead ?? undefined}
                icon={glyph}
                title={<Text testID="session-presence-title" style={[styles.title, hasViewers ? null : styles.titleQuiet]} numberOfLines={1}>{title}</Text>}
                subtitle={subtitle ? <Text testID="session-presence-status" style={styles.subtitle} numberOfLines={1}>{subtitle}</Text> : undefined}
            />
            {regionFocused ? (
                <PoliteAccessibilityStatus
                    statusTestID="session-presence-announcement"
                    announcement={announcement}
                    transitionKey={membershipTransitionKey}
                />
            ) : null}
        </View>
    </View>;
}
