import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { CountedDisclosureItem } from '@/components/ui/lists/CountedDisclosureItem';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { useVoiceAttemptControl, VOICE_ATTEMPT_IDLE_TARGET_GLOBAL } from '@/components/voice/attempt/useVoiceAttemptControl';
import { VoiceMarkArt } from '@/components/voice/presence/VoiceMark';
import { VoiceNeedsYouPrompts } from '@/components/voice/presence/VoiceNeedsYouPrompts';
import { Typography } from '@/constants/Typography';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { InboxModelBoundary } from '@/hooks/inbox/useInboxModel';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { t } from '@/text';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { getVoiceSessionPresentedAttemptId } from '@/voice/session/voiceSessionStore';
import { type VoiceBrief, type VoiceBriefItem } from '@/voice/context/buildVoiceBrief';
import { useVoiceBriefRequest } from './useVoiceBriefRequest';

/**
 * Home's quiet "Brief me" (lab `voice-moments` B0): one press turns the greeting into the brief.
 * Closed, it costs nothing — no Inbox subscription, no Voice start. While Voice is not set up a brief
 * could not be spoken, so the entry is the attempt owner's own "Set up Voice" and opens setup.
 */
export const VoiceBriefButton = React.memo(function VoiceBriefButton(props: Readonly<{
    open: boolean;
    /** Phone (lab B0p): the button spans the page under the greeting instead of sitting beside it. */
    block?: boolean;
}>): React.ReactElement | null {
    const voiceEnabled = useFeatureEnabled('voice');
    const { execute, ready } = useMountedActionExecution(getActiveServerAccountScope());
    const request = React.useCallback(() => {
        const expectedAttemptId = getVoiceSessionPresentedAttemptId();
        return execute('ui.voice_global.brief.request', expectedAttemptId ? { expectedAttemptId } : {});
    }, [execute]);
    const openSetup = React.useCallback(() => {
        void execute('ui.voice_global.setup.open', {});
    }, [execute]);
    const voice = useVoiceAttemptControl(VOICE_ATTEMPT_IDLE_TARGET_GLOBAL);
    if (voiceEnabled !== true || props.open) return null;
    // Setup's own open Action: in place where a host presents it (Home's Get set up), else Settings → Voice open.
    const setup = voice.primaryAction === 'setup' && voice.primaryActionLabel
        ? { label: voice.primaryActionLabel, onPress: openSetup }
        : voice.primaryAction === 'recover' && voice.primaryActionLabel
            ? { label: voice.live ? voice.primaryActionLabel : t('voicePresence.setUp'), onPress: () => { void voice.onPrimaryAction(); } }
        : undefined;
    return <VoiceBriefButtonView onOpen={request} block={props.block} disabled={!setup && !ready} setup={setup} />;
});

/** The button as drawn (the dev Home fixture draws it without the server's feature decision). */
export const VoiceBriefButtonView = React.memo(function VoiceBriefButtonView(props: Readonly<{
    onOpen: () => void;
    block?: boolean;
    disabled?: boolean;
    /** Voice is not set up: the entry names that act instead of opening a brief that cannot be spoken. */
    setup?: Readonly<{ label: string; onPress: () => void }>;
}>) {
    return (
        <RoundButton
            style={props.block ? stylesheet.block : undefined}
            testID="home-brief-me"
            disabled={props.disabled}
            size="small"
            display="secondary"
            title={props.setup?.label ?? t('voiceMoments.briefMe')}
            accessibilityLabel={props.setup?.label ?? t('voiceMoments.briefMeA11y')}
            leading={<VoiceMarkArt pose="ready" size={16} still />}
            onPress={props.setup?.onPress ?? props.onOpen}
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
    const { brief, voice, delivery, waitingUnavailable, actionReady, retry, canStopReply, stopReply, closeBrief } = useVoiceBriefRequest(props.onClose);

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
    // The call's own status lives in the presence (pill, island, Orb); the head carries only what the
    // brief adds: why it is silent, its one next action, Stop and close — one row, never a lone ×.
    const notSpoken = waitingUnavailable || delivery === 'refused';

    return (
        <View testID="voice-brief" style={styles.root}>
            <VoiceBriefList brief={brief} onOpen={open} head={(
                <View testID={waitingUnavailable ? 'voice-brief.unavailable' : undefined} style={styles.head}>
                    {notSpoken ? <Text style={styles.headNote}>{t('voiceMoments.briefNotSpoken')}</Text> : <View style={styles.grow} />}
                    {waitingUnavailable && (voice.recoveryAvailable || setupAction) ? (
                        <RoundButton
                            testID="voice-brief.recover"
                            size="small"
                            title={(voice.recoveryAvailable ? voice.recoveryLabel : voice.primaryActionLabel) ?? t('common.retry')}
                            // The hint is for assistive technology: what the button opens, not body copy.
                            accessibilityHint={voice.primaryActionHint ?? undefined}
                            onPress={retry}
                            disabled={!actionReady}
                        />
                    ) : waitingUnavailable && voice.primaryAction === 'start' ? (
                        <RoundButton testID="voice-brief.retry" size="small" title={t('common.retry')} onPress={retry} disabled={!actionReady} />
                    ) : null}
                    {canStopReply && stopReply ? (
                        <RoundButton testID="voice-brief.stop" size="small" display="secondary" title={t('voiceMoments.briefStop')} onPress={stopReply} disabled={!actionReady} />
                    ) : null}
                    <IconButton
                        testID="voice-brief.close"
                        iconName="x"
                        variant="plain"
                        size={24}
                        iconSize={13}
                        accessibilityLabel={t('common.close')}
                        tooltip={t('common.close')}
                        onPress={closeBrief}
                        disabled={!actionReady}
                    />
                </View>
            )} />
        </View>
    );
}

/**
 * The brief's list as drawn: Needs you → Failed → Ready, each row one known item with its exact
 * destination; the source's own incomplete / caught-up facts above it. Pure presentation of a
 * `buildVoiceBrief` result (the dev fixture draws it at lab data). `head` (the live Brief's status,
 * close and recovery) reads in one block with those facts, so the notes never float apart from it.
 */
export const VoiceBriefList = React.memo(function VoiceBriefList(props: Readonly<{
    brief: Pick<VoiceBrief, 'items' | 'incomplete' | 'caughtUp'>;
    onOpen: (item: VoiceBriefItem) => void;
    head?: React.ReactNode;
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
    })).filter((group) => group.items.length > 0).map((group) => {
        // Occurrences keep their individual destinations. Identical presentation
        // belongs in one counted fold, using the list owner's lazy disclosure.
        const occurrences = new Map<string, VoiceBriefItem[]>();
        for (const item of group.items) {
            const key = JSON.stringify([item.destination.kind, item.title, item.subtitle ?? null]);
            const rows = occurrences.get(key);
            if (rows) rows.push(item);
            else occurrences.set(key, [item]);
        }
        return { ...group, occurrences: [...occurrences.values()] };
    }), [brief.items]);
    return (
        <>
            {/* The head and its notes read in Home's column, on the same edge as the sheet below (lab B1). */}
            {props.head || brief.incomplete || brief.caughtUp ? (
                <ItemGroup surface="none">
                    <View style={styles.root}>
                        {props.head}
                        {brief.incomplete ? <Text style={styles.note}>{t('voiceMoments.briefIncomplete')}</Text> : null}
                        {brief.caughtUp ? <Text style={styles.note}>{t('voiceMoments.briefCaughtUp')}</Text> : null}
                    </View>
                </ItemGroup>
            ) : null}
            {groups.length > 0 ? (
                // One sheet in one rhythm (lab B1): the groups are sentence-case headings inside it,
                // not three boxes competing with Home's own sections.
                <ItemGroup>
                    {groups.map((group) => (
                        <React.Fragment key={group.category}>
                            <Text testID={`voice-brief.group.${group.category}`} accessibilityRole="header" style={styles.groupTitle}>
                                {group.title}
                            </Text>
                            {group.occurrences.map((items) => items.length === 1 ? (
                                <VoiceBriefRow key={items[0].key} item={items[0]} fallbackTitle={group.title} onOpen={props.onOpen} />
                            ) : (
                                <CountedDisclosureItem key={items[0].key}
                                    testID={`voice-brief.occurrences.${items[0].key}`}
                                    title={items[0].title} subtitle={items[0].subtitle} count={items.length}>
                                    {items.map(item => <VoiceBriefRow key={item.key} item={item} fallbackTitle={group.title} onOpen={props.onOpen} />)}
                                </CountedDisclosureItem>
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
                titleLines={1}
                subtitle={item.subtitle}
                icon={glyph}
                onPress={() => props.onOpen(item)}
            />
            {item.hasRequestControls === true && item.destination.kind === 'session' ? (
                <View style={stylesheet.prompts}>
                    <VoiceNeedsYouPrompts address={item.destination.address} testID={`voice-brief.prompts.${item.key}`} />
                </View>
            ) : null}
        </>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        gap: theme.space.s8,
    },
    head: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        paddingHorizontal: theme.space.s4,
    },
    grow: {
        flexGrow: 1,
    },
    // Why the brief is silent, on the head's own line; its action keeps its width beside it.
    headNote: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
        flex: 1,
        minWidth: 0,
    },
    note: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
        paddingHorizontal: theme.space.s4,
    },
    block: {
        alignSelf: 'stretch',
    },
    groupTitle: {
        ...Typography.variant('meta', 'semiBold'),
        color: theme.colors.text.secondary,
        paddingHorizontal: theme.space.s16,
        paddingTop: theme.space.s12,
        paddingBottom: theme.space.s2,
    },
    dot: {
        width: 14,
        alignItems: 'center',
        justifyContent: 'center',
    },
    prompts: {
        paddingHorizontal: theme.space.s12,
        paddingBottom: theme.space.s10,
    },
}));
