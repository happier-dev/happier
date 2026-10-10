import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { VoiceMarkArt } from '@/components/voice/presence/VoiceMark';
import { VoiceNeedsYouPrompts } from '@/components/voice/presence/VoiceNeedsYouPrompts';
import { VoiceStatusLine } from '@/components/voice/presence/VoiceStatusLine';
import { Typography } from '@/constants/Typography';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { InboxModelBoundary } from '@/hooks/inbox/useInboxModel';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { t } from '@/text';
import { type VoiceBrief, type VoiceBriefItem } from '@/voice/context/buildVoiceBrief';
import { useVoiceBriefRequest } from './useVoiceBriefRequest';

/**
 * Home's quiet "Brief me" (lab `voice-moments` B0): one press turns the greeting into the brief.
 * Closed, it costs nothing — no Inbox subscription, no Voice start.
 */
export const VoiceBriefButton = React.memo(function VoiceBriefButton(props: Readonly<{
    open: boolean;
    onOpen: () => void;
    /** Phone (lab B0p): the button spans the page under the greeting instead of sitting beside it. */
    block?: boolean;
}>): React.ReactElement | null {
    const voiceEnabled = useFeatureEnabled('voice');
    if (voiceEnabled !== true || props.open) return null;
    return <VoiceBriefButtonView onOpen={props.onOpen} block={props.block} />;
});

/** The button as drawn (the dev Home fixture draws it without the server's feature decision). */
export const VoiceBriefButtonView = React.memo(function VoiceBriefButtonView(props: Readonly<{ onOpen: () => void; block?: boolean }>) {
    return (
        <RoundButton
            style={props.block ? stylesheet.block : undefined}
            testID="home-brief-me"
            size="small"
            display="secondary"
            title={t('voiceMoments.briefMe')}
            accessibilityLabel={t('voiceMoments.briefMeA11y')}
            leading={<VoiceMarkArt pose="ready" size={16} still />}
            onPress={props.onOpen}
        />
    );
});

/**
 * The brief, in place (lab B1): what the Inbox already knows — needs you, failed, ready — read aloud
 * by the person's Voice service while the screen keeps the list. Every row leads to its exact
 * destination; a waiting request is the real request card, decided by a tap, never by voice.
 *
 * Opening it mounts the Inbox model (the open-surface owner) and, if Voice is idle, starts the
 * ordinary global conversation; the brief is sent once that conversation is actually connected,
 * through m-core's `voiceHooks.onBriefRequested`. Stop cancels the reply without ending the call.
 */
export const VoiceBriefBlock = React.memo(function VoiceBriefBlock(props: Readonly<{ onClose: () => void }>) {
    return (
        <InboxModelBoundary>
            <VoiceBriefContent onClose={props.onClose} />
        </InboxModelBoundary>
    );
});

function VoiceBriefContent(props: Readonly<{ onClose: () => void }>) {
    const styles = stylesheet;
    const router = useRouter();
    const { brief, voice, delivery, waitingUnavailable, retry, canStopReply, stopReply } = useVoiceBriefRequest();

    const open = React.useCallback((item: VoiceBriefItem) => {
        if (typeof item.route === 'string') {
            router.push(item.route as never);
            return;
        }
        if (item.route) {
            router.push(item.route as never);
            return;
        }
        if (item.destination.kind === 'session') {
            router.push(buildScopedSessionRouteHref({
                sessionId: item.destination.address.sessionId,
                serverId: item.destination.address.serverId,
            }) as never);
        }
    }, [router]);

    const setupAction = voice.primaryAction === 'setup' || voice.primaryAction === 'recover';

    return (
        <View testID="voice-brief" style={styles.root}>
            <View style={styles.head}>
                {voice.live ? <VoiceStatusLine voice={voice} size="island" /> : <View style={styles.grow} />}
                <View style={styles.grow} />
                {canStopReply && stopReply ? (
                    <RoundButton testID="voice-brief.stop" size="small" display="secondary" title={t('voiceMoments.briefStop')} onPress={stopReply} />
                ) : null}
                <IconButton
                    testID="voice-brief.close"
                    iconName="x"
                    variant="plain"
                    size={24}
                    iconSize={13}
                    accessibilityLabel={t('common.close')}
                    tooltip={t('common.close')}
                    onPress={props.onClose}
                />
            </View>
            {delivery === 'refused' && !waitingUnavailable ? <Text style={styles.note}>{t('voiceMoments.briefNotSpoken')}</Text> : null}
            {waitingUnavailable ? (
                <View testID="voice-brief.unavailable" style={styles.root}>
                    <Text style={styles.note}>{t('voiceMoments.briefNotSpoken')}</Text>
                    <Text style={styles.note}>{voice.primaryActionHint ?? voice.captionLabel}</Text>
                    {voice.recoveryAvailable || setupAction ? (
                        <RoundButton
                            testID="voice-brief.recover"
                            size="small"
                            display="secondary"
                            title={(voice.recoveryAvailable ? voice.recoveryLabel : voice.primaryActionLabel) ?? t('common.retry')}
                            onPress={retry}
                        />
                    ) : voice.primaryAction === 'start' ? (
                        <RoundButton testID="voice-brief.retry" size="small" display="secondary" title={t('common.retry')} onPress={retry} />
                    ) : null}
                </View>
            ) : null}
            <VoiceBriefList brief={brief} onOpen={open} />
        </View>
    );
}

/**
 * The brief's list as drawn: Needs you → Failed → Ready, each row one known item with its exact
 * destination; the source's own incomplete / caught-up facts above it. Pure presentation of a
 * `buildVoiceBrief` result (the dev fixture draws it at lab data).
 */
export const VoiceBriefList = React.memo(function VoiceBriefList(props: Readonly<{
    brief: Pick<VoiceBrief, 'items' | 'incomplete' | 'caughtUp'>;
    onOpen: (item: VoiceBriefItem) => void;
}>) {
    const styles = stylesheet;
    const { brief } = props;
    const groups = React.useMemo(() => ([
        ['needs_you', t('voiceMoments.briefNeedsYou')],
        ['failed', t('voiceMoments.briefFailed')],
        ['ready', t('voiceMoments.briefReady')],
    ] as const).map(([category, title]) => ({
        category,
        title,
        items: brief.items.filter((item) => item.category === category),
    })).filter((group) => group.items.length > 0), [brief.items]);
    return (
        <>
            {brief.incomplete ? <Text style={styles.note}>{t('voiceMoments.briefIncomplete')}</Text> : null}
            {brief.caughtUp ? <Text style={styles.note}>{t('voiceMoments.briefCaughtUp')}</Text> : null}
            {groups.length > 0 ? (
                // One sheet in one rhythm (lab B1): the groups are sentence-case headings inside it,
                // not three boxes competing with Home's own sections.
                <ItemGroup>
                    {groups.map((group) => (
                        <React.Fragment key={group.category}>
                            <Text testID={`voice-brief.group.${group.category}`} accessibilityRole="header" style={styles.groupTitle}>
                                {group.title}
                            </Text>
                            {group.items.map((item) => (
                                <VoiceBriefRow key={item.key} item={item} fallbackTitle={group.title} onOpen={props.onOpen} />
                            ))}
                        </React.Fragment>
                    ))}
                </ItemGroup>
            ) : null}
        </>
    );
});

const VoiceBriefRow = React.memo(function VoiceBriefRow(props: Readonly<{
    item: VoiceBriefItem;
    fallbackTitle: string;
    onOpen: (item: VoiceBriefItem) => void;
}>) {
    const { theme } = useUnistyles();
    const { item } = props;
    // One status dot per row, in the tones Home already uses for the same facts (needs you is the
    // warning tone of Home's "1 needs you"). Wrapped: the row restyles a bare icon element.
    const tone = item.category === 'needs_you'
        ? theme.colors.state.warning.foreground
        : item.category === 'failed' ? theme.colors.state.danger.foreground : theme.colors.state.success.foreground;
    const glyph = (
        <View style={stylesheet.dot}>
            <StatusDot color={tone} size={7} />
        </View>
    );
    return (
        <>
            <Item
                testID={`voice-brief.item.${item.key}`}
                title={item.title || props.fallbackTitle}
                subtitle={item.subtitle}
                icon={glyph}
                onPress={() => props.onOpen(item)}
            />
            {item.category === 'needs_you' && item.destination.kind === 'session' ? (
                <View style={stylesheet.prompts}>
                    <VoiceNeedsYouPrompts address={item.destination.address} testID={`voice-brief.prompts.${item.key}`} />
                </View>
            ) : null}
        </>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        gap: 8,
    },
    head: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 4,
    },
    grow: {
        flexGrow: 1,
    },
    note: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.secondary,
        paddingHorizontal: 4,
    },
    block: {
        alignSelf: 'stretch',
    },
    groupTitle: {
        ...Typography.default('semiBold'),
        fontSize: 12.5,
        lineHeight: 16,
        color: theme.colors.text.secondary,
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 2,
    },
    dot: {
        width: 14,
        alignItems: 'center',
        justifyContent: 'center',
    },
    prompts: {
        paddingHorizontal: 12,
        paddingBottom: 10,
    },
}));
