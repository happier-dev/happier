import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { WidgetFrame } from '@/components/widgets/frame/WidgetFrame';
import { Typography } from '@/constants/Typography';
import type { VoiceSurfaceViewModel } from '@/components/voice/surface/useVoiceSurfaceModel';
import type { VoiceSurfaceTranscriptEntry } from '@/components/voice/surface/mergeVoiceSurfaceTranscriptEntries';
import { useSession } from '@/sync/domains/state/storage';
import { getSessionName, useSessionStatus } from '@/utils/sessions/sessionUtils';
import { hasAgentIconMark } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { t } from '@/text';

import { VoiceMark } from './VoiceMark';
import { resolveVoicePresenceCaption } from './resolveVoicePresenceCaption';
import { VoiceNeedsYouPrompts } from './VoiceNeedsYouPrompts';
import { VoiceEndedPendingApproval } from './VoiceEndedPendingApproval';
import { presentVoiceContinuation } from '@/voice/transcript/voiceTranscriptNotePresentation';
import { VoiceStatusCell } from './VoiceStatusCell';
import { formatVoiceElapsed, VoiceElapsed, VoiceStatusLine } from './VoiceStatusLine';

/** How many of the latest turns the glance reads back; the full history is the conversation itself. */
const GLANCE_TURNS = 3;

export type VoiceGlancePresentation = 'companion' | 'popover' | 'sheet';

/**
 * The Voice section: one component, three hosts (§4.3) — leading the Companion (WidgetFrame Plain),
 * anchored under the top-bar pill / island / orb as a popover, and as the phone sheet.
 *
 * It renders the canonical surface model: the attempt projection for state and controls, the
 * canonical transcript for the turns, the delegated-work channel for the handoff row. It decides
 * nothing; every press is the model's own handler.
 */
export const VoiceGlance = React.memo(function VoiceGlance(props: Readonly<{
    model: VoiceSurfaceViewModel;
    presentation: VoiceGlancePresentation;
    /** The host's header controls (the Companion item menu, a sheet's collapse). */
    menu?: React.ReactNode;
    /** Replays the frame's one-shot ring when it changes (a container revealed this section). */
    fresh?: number;
    testID?: string;
}>): React.ReactElement {
    const { model } = props;
    const voice = model.attemptControl;
    const testID = props.testID ?? 'voice-glance';
    const target = model.targetLabel ?? t('voicePresence.globalVoice');
    const source = model.providerLabel ? `${target} · ${model.providerLabel}` : target;
    return (
        <WidgetFrame
            testID={testID}
            frameStyle="plain"
            placement="companion"
            title={t('voicePresence.title')}
            source={source}
            menu={props.menu}
            // The call's clock reads with its title ("Voice 2:14"), not across the header.
            titleMeta={voice.live && voice.elapsedStartedAt ? <VoiceElapsed startedAt={voice.elapsedStartedAt} /> : undefined}
            fresh={props.fresh}
            body={{
                kind: 'content',
                children: <VoiceGlanceBody model={model} presentation={props.presentation} testID={testID} />,
            }}
        />
    );
});

/** One helpful line per state (lab ST captions); a failure names what failed instead. */
function resolveVoiceGlanceCaption(model: VoiceSurfaceViewModel): string {
    const voice = model.attemptControl;
    if (voice.recoveryAvailable && model.subtitle) return model.subtitle;
    return resolveVoicePresenceCaption(voice) ?? model.subtitle ?? voice.micStateLabel;
}

const VoiceGlanceBody = React.memo(function VoiceGlanceBody(props: Readonly<{
    model: VoiceSurfaceViewModel;
    presentation: VoiceGlancePresentation;
    testID: string;
}>) {
    const styles = stylesheet;
    const { model } = props;
    const voice = model.attemptControl;
    const sheet = props.presentation === 'sheet';
    const turns = React.useMemo(
        () => model.visibleTranscriptEntries.filter((entry) => entry.kind !== 'note').slice(-GLANCE_TURNS),
        [model.visibleTranscriptEntries],
    );
    if (!voice.live && voice.ended) {
        return <VoiceGlanceEnded model={model} sheet={sheet} testID={props.testID} />;
    }
    const showTurns = model.activityFeedEnabled && model.expanded && turns.length > 0 && voice.canStop;
    // The caption is the call's own fact (what failed, or the state's one helpful line); delegated
    // work keeps its own line below so an agent's status never reads as the call's state.
    const caption = resolveVoiceGlanceCaption(model);
    return (
        <View style={sheet ? styles.bodySheet : styles.body}>
            <View style={sheet ? styles.heroSheet : styles.hero}>
                <VoiceMark voice={voice} size={sheet ? 64 : 44} />
                <View style={styles.heroText}>
                    <VoiceStatusLine voice={voice} size="hero" />
                    {caption ? <Text style={sheet ? styles.captionSheet : styles.caption} numberOfLines={2}>{caption}</Text> : null}
                </View>
            </View>
            {showTurns ? <VoiceGlanceTurns turns={turns} sheet={sheet} /> : null}
            {model.activityFeedEnabled && !model.expanded && voice.canStop ? (
                <Pressable
                    testID={`${props.testID}-show-transcript`}
                    accessibilityRole="button"
                    accessibilityLabel={model.toggleActivityLabel}
                    onPress={model.onToggleExpanded}
                    style={styles.quietLink}
                    hitSlop={8}
                >
                    <Text style={styles.quietLinkLabel}>{t('voicePresence.showConversation')}</Text>
                </Pressable>
            ) : null}
            {voice.statusCell === 'needs_you' && voice.openConversationSessionAddress ? (
                <VoiceNeedsYouPrompts address={voice.openConversationSessionAddress} testID={`${props.testID}-needs-you`} />
            ) : null}
            {model.delegatedWork ? <VoiceGlanceHandoff model={model} testID={`${props.testID}-handoff`} /> : null}
            <VoiceGlanceControls model={model} sheet={sheet} testID={props.testID} />
        </View>
    );
});

/**
 * After a clean End (lab ST "ended"): the dots have regathered into the microphone, the call's
 * length, the reassurance that it is saved, and the two next steps — back to the conversation, or
 * talk again.
 */
const VoiceGlanceEnded = React.memo(function VoiceGlanceEnded(props: Readonly<{
    model: VoiceSurfaceViewModel;
    sheet: boolean;
    testID: string;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const voice = props.model.attemptControl;
    const ended = voice.ended!;
    // Continued on another device (lab C1): the conversation moved; this device only let its own
    // microphone go. Viewer-relative words from the same formatter the transcript note uses.
    const continued = ended.reason.kind === 'continued_elsewhere' ? presentVoiceContinuation(ended.reason.continuation) : null;
    const elapsed = ended.startedAt === null ? null : formatVoiceElapsed(Math.max(0, Math.round((ended.endedAt - ended.startedAt) / 1000)));
    const size = props.sheet ? 'normal' : 'small';
    const iconSize = props.sheet ? 18 : 14;
    return (
        <View testID={`${props.testID}-ended`} style={props.sheet ? styles.bodySheet : styles.body}>
            <View style={props.sheet ? styles.heroSheet : styles.hero}>
                <VoiceMark voice={voice} size={props.sheet ? 64 : 44} />
                <View style={styles.heroText}>
                    <VoiceStatusLine voice={voice} size="hero" />
                    {continued ? (
                        <Text testID={`${props.testID}-continued`} style={props.sheet ? styles.captionSheet : styles.caption}>{continued}</Text>
                    ) : elapsed ? <Text style={props.sheet ? styles.captionSheet : styles.caption}>{t('voicePresence.endedCaption', { elapsed })}</Text> : null}
                </View>
            </View>
            <VoiceEndedPendingApproval ended={ended} testID={`${props.testID}-ended-pending`} />
            {/* One bordered action, the way back to the conversation; Start again is a quiet text
                action beside it — the hero mark above is already the start control. */}
            <View style={[styles.controls, styles.endedControls]}>
                {voice.canOpenConversation ? (
                    <RoundButton
                        testID={`${props.testID}-open-conversation`}
                        display="secondary"
                        size={size}
                        title={t('voicePresence.openConversation')}
                        onPress={voice.onOpenConversation}
                        leading={<Icon name="arrow-right" size={iconSize} color={theme.colors.text.secondary} />}
                    />
                ) : null}
                {voice.canStart ? (
                    <RoundButton
                        testID={`${props.testID}-start-again`}
                        display="inverted"
                        size={size}
                        title={t('voicePresence.startAgain')}
                        textStyle={styles.startAgain}
                        onPress={voice.onPrimaryAction}
                    />
                ) : null}
            </View>
        </View>
    );
});

const VoiceGlanceTurns = React.memo(function VoiceGlanceTurns(props: Readonly<{
    turns: readonly VoiceSurfaceTranscriptEntry[];
    sheet: boolean;
}>) {
    const styles = stylesheet;
    return (
        <View style={[styles.turns, props.sheet ? styles.turnsSheet : null]}>
            {props.turns.map((entry) => entry.kind === 'user' ? (
                <Text key={entry.id} style={[styles.userTurn, props.sheet ? styles.turnSheet : null]}>
                    <Text style={styles.who}>{`${t('voicePresence.you')} · `}</Text>
                    {entry.text}
                </Text>
            ) : (
                <Text
                    key={entry.id}
                    style={[styles.assistantTurn, props.sheet ? styles.turnSheet : null, entry.transcriptState === 'partial' ? styles.partial : null]}
                >
                    {entry.text}
                </Text>
            ))}
        </View>
    );
});

/** The work Voice handed to a session: where it runs and what it is doing now, with its live cell. */
const VoiceGlanceHandoff = React.memo(function VoiceGlanceHandoff(props: Readonly<{ model: VoiceSurfaceViewModel; testID: string }>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const work = props.model.delegatedWork!;
    // Where the work runs, named and marked the way the session list does it, and what it is doing
    // now in the shared session word (lab A: mark · title · cell · "Working"). Without a known session
    // the agent's own status line names the work instead.
    const session = useSession(work.sessionId);
    const sessionStatus = useSessionStatus(session ?? null, { subscribeToSession: false, workingTextMode: 'static' });
    const agentId = session ? readSessionPresentationAgentId(session) : null;
    const title = session ? getSessionName(session) : work.statusText;
    const status = sessionStatus?.statusText ?? (work.thinking || !work.statusText ? t('voiceSurface.delegatedWorking') : null);
    const label = [title, status].filter(Boolean).join(', ');
    // The row leads to the working session through the model's own navigation (teleport for a Voice
    // agent's root session); without one it is information only.
    const onPress = props.model.canTeleportToSessionRoot ? props.model.onTeleport : undefined;
    return (
        <Pressable
            testID={props.testID}
            disabled={!onPress}
            accessibilityRole={onPress ? 'link' : undefined}
            accessibilityLabel={label}
            onPress={onPress}
            style={({ pressed }) => [styles.handoff, pressed ? styles.handoffPressed : null]}
        >
            {agentId && hasAgentIconMark(agentId, theme) ? <AgentIcon agentId={agentId} size={15} /> : null}
            {title ? <Text style={styles.handoffTitle} numberOfLines={1}>{title}</Text> : null}
            {status ? (
                <View style={[styles.handoffStatus, title ? styles.handoffStatusTrailing : null]}>
                    {work.thinking ? <VoiceStatusCell kind="working" size={12} /> : null}
                    <Text style={styles.handoffLabel} numberOfLines={1}>{status}</Text>
                </View>
            ) : null}
            {onPress ? <Icon name="caret-right" size={12} color={theme.colors.text.tertiary} /> : null}
        </Pressable>
    );
});

const VoiceGlanceControls = React.memo(function VoiceGlanceControls(props: Readonly<{
    model: VoiceSurfaceViewModel;
    sheet: boolean;
    testID: string;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const voice = props.model.attemptControl;
    const size = props.sheet ? 'normal' : 'small';
    const iconSize = props.sheet ? 18 : 14;
    const recover = voice.recoveryAvailable && voice.recoveryLabel ? (
        <RoundButton
            testID={`${props.testID}-recover`}
            size={size}
            title={voice.recoveryLabel}
            onPress={voice.onRecover}
            leading={<Icon name="arrow-clockwise" size={iconSize} color={theme.colors.button.primary.tint} />}
        />
    ) : null;
    const mute = voice.canStop && !recover ? (
        <RoundButton
            testID={`${props.testID}-mute`}
            display="secondary"
            size={size}
            disabled={!voice.canMute}
            title={voice.muted ? t('voicePresence.unmute') : t('voicePresence.mute')}
            accessibilityLabel={voice.muted ? t('voiceSurface.a11y.unmute') : t('voiceSurface.a11y.mute')}
            onPress={voice.onToggleMute}
            leading={<Icon name={voice.muted ? 'microphone-slash' : 'microphone'} size={iconSize} color={theme.colors.text.secondary} />}
        />
    ) : null;
    const interrupt = props.model.canBargeIn ? (
        <RoundButton
            testID={`${props.testID}-interrupt`}
            display="secondary"
            size={size}
            title={t('voicePresence.interrupt')}
            onPress={props.model.onBargeIn}
            leading={<Icon name="hand" size={iconSize} color={theme.colors.text.secondary} />}
        />
    ) : null;
    // A reply can be cancelled without ending the call (thinking, or speaking without barge-in).
    const cancelReply = props.model.canCancelTurn && !props.model.canBargeIn ? (
        <RoundButton
            testID={`${props.testID}-cancel-reply`}
            display="secondary"
            size={size}
            title={t('voiceSurface.a11y.cancelTurn')}
            onPress={props.model.onCancelTurn}
            leading={<Icon name="stop" size={iconSize} color={theme.colors.text.secondary} />}
        />
    ) : null;
    const end = voice.canStop ? (
        <RoundButton
            testID={`${props.testID}-end`}
            display="destructive"
            size={size}
            title={t('voicePresence.end')}
            accessibilityLabel={t('voiceAssistant.endVoice')}
            onPress={voice.onToggle}
            leading={<Icon name="phone-hang-up" size={iconSize} color={theme.colors.state.danger.foreground} weight="fill" />}
        />
    ) : null;
    return (
        <View style={[styles.controls, props.sheet ? styles.controlsSheet : null]}>
            {recover ?? mute}
            {interrupt}
            {cancelReply}
            {props.sheet ? null : <View style={styles.grow} />}
            {end}
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    body: { gap: 12, paddingBottom: 4 },
    bodySheet: { gap: 16, paddingBottom: 8 },
    hero: { flexDirection: 'row', alignItems: 'center', gap: 18, paddingLeft: 10, marginTop: 2 },
    heroSheet: { flexDirection: 'row', alignItems: 'center', gap: 24, paddingLeft: 16, marginTop: 6 },
    heroText: { flex: 1, minWidth: 0, gap: 2 },
    caption: { ...Typography.default(), fontSize: 12.5, lineHeight: 17, color: theme.colors.text.secondary },
    captionSheet: { ...Typography.default(), fontSize: 14, lineHeight: 19, color: theme.colors.text.secondary },
    turns: { gap: 8 },
    turnsSheet: { gap: 10 },
    userTurn: { ...Typography.default(), fontSize: 13, lineHeight: 18.5, color: theme.colors.text.secondary },
    assistantTurn: { ...Typography.default(), fontSize: 13, lineHeight: 18.5, color: theme.colors.text.primary },
    turnSheet: { fontSize: 15, lineHeight: 21 },
    partial: { color: theme.colors.text.secondary },
    who: { color: theme.colors.text.tertiary },
    quietLink: { alignSelf: 'flex-start' },
    quietLinkLabel: { ...Typography.default(), fontSize: 12.5, color: theme.colors.text.secondary },
    handoff: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        paddingVertical: 7,
        paddingHorizontal: 9,
        borderRadius: 10,
        backgroundColor: theme.colors.surface.inset,
    },
    handoffPressed: { opacity: 0.7 },
    handoffTitle: { ...Typography.default('semiBold'), flexShrink: 1, fontSize: 12.5, lineHeight: 16, color: theme.colors.text.primary },
    handoffStatus: { flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1 },
    handoffStatusTrailing: { marginLeft: 'auto', flexShrink: 0, maxWidth: '60%' },
    handoffLabel: { ...Typography.default(), flexShrink: 1, fontSize: 12.5, lineHeight: 16, color: theme.colors.text.secondary },
    controls: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    controlsSheet: { gap: 8 },
    endedControls: { gap: 8, justifyContent: 'flex-start' },
    startAgain: { color: theme.colors.text.secondary },
    grow: { flex: 1 },
}));
