import * as React from 'react';
import { Animated, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { useDetailsTabHeaderActionsCompact } from '@/components/appShell/panes/details/header/DetailsTabHeader';

import { usePendingNavigationOverview } from '@/activity/source/usePendingNavigationOverview';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { PendingNavigationCandidate } from '@/activity/source/buildPendingNavigationFromSource';
import { invokeNextPendingRequest, usePendingNavigationLanding, useSessionPendingAnswerToken } from '@/activity/source/pendingNavigationRuntime';
import { SessionNavigationPill } from '@/components/navigation/SessionNavigationPill';
import { KeyHint } from '@/components/ui/keyboard/KeyHint';
import { Text } from '@/components/ui/text/Text';
import { Icon } from '@/components/ui/icons/Icon';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { resolveOverlayMotionPreset, useOverlayMotionAnimation, useOverlayPresence } from '@/components/ui/overlays/motion/overlayMotion';
import { Typography } from '@/constants/Typography';
import { splitKeybindingLabel, useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { ComposerTextStore } from '@/components/sessions/agentInput/composerTextStore';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';

export type PendingNavigationPillProps = Readonly<{
    address: SessionAddress | null;
    presentation: 'header' | 'composer' | 'phone';
    /** The composer the Next capsule stands on: typing there means you stayed, so the offer leaves. */
    composerText?: ComposerTextStore;
}>;

/** The Next pill rises off the composer edge it stands on (the docked-capsule motion). */
const RISE_MOTION = resolveOverlayMotionPreset({ kind: 'popover', direction: 'top' });

export type NextTarget = Readonly<{ title: string; reason: string | null; address?: SessionAddress }>;

/**
 * What the composer pill can truthfully name before Next runs: with one session waiting it is that
 * session and what it waits on; with several, the oldest request is only known once Next hydrates them,
 * so the pill names the count instead of guessing.
 */
function describeNextTarget(candidates: readonly PendingNavigationCandidate[]): NextTarget {
    if (candidates.length !== 1) return { title: t('pendingNavigation.sessionsWaiting', { count: candidates.length }), reason: null };
    const only = candidates[0]!;
    return {
        title: getSessionName(only.session, only.address.serverId),
        reason: only.waitsFor === 'permission' ? t('pendingNavigation.waitsForPermission') : t('pendingNavigation.waitsForInput'),
        address: only.address,
    };
}

/**
 * Next (⌘⇧J) in its three places (Find lab `fnext`):
 * - `header`: "● 2 need you ⌘⇧J", an amber pill in the session header, only while another session waits;
 * - `phone`: the amber count capsule in the session nav;
 * - `composer`: after you answer, the Next capsule rises above the composer, naming where Next goes.
 */
export const PendingNavigationPill = React.memo(function PendingNavigationPill(props: PendingNavigationPillProps) {
    // Behind another tab the pill shows nothing the person can see: its pending projection parks until shown.
    const presented = useLayoutPresentationActive();
    const { candidates, count } = usePendingNavigationOverview(props.address, props.presentation === 'composer', presented);
    const serverId = props.address?.serverId;
    const sessionId = props.address?.sessionId;
    const answerToken = useSessionPendingAnswerToken(props.address);
    const landing = usePendingNavigationLanding(props.address);
    const shortcut = useKeyboardShortcutLabel('session.pending.next');
    const phoneDevice = useDeviceType() === 'phone';
    // A tight session header keeps the title readable: the pill says only its count there.
    const compactHeader = useDetailsTabHeaderActionsCompact() && props.presentation === 'header';
    const onPress = React.useCallback(() => {
        if (!serverId || !sessionId) return;
        return invokeNextPendingRequest({ excluding: { serverId, sessionId } });
    }, [serverId, sessionId]);

    const offered = props.presentation === 'composer' && count > 0 && (answerToken !== null || landing?.state === 'settled');
    const target = React.useMemo(() => (offered ? describeNextTarget(candidates) : null), [offered, candidates]);

    if (!serverId || !sessionId) return null;
    if (props.presentation === 'composer') {
        return (
            <NextComposerPill
                // The pill belongs to one answer: a later answer (or a settled landing) offers Next again.
                key={`${answerToken ?? 'none'}:${landing?.state === 'settled' ? landing.token : 'open'}`}
                target={target}
                shortcut={shortcut}
                onGo={onPress}
                composerText={props.composerText}
            />
        );
    }
    // One count on a phone: the session nav capsule says it, so the header does not repeat it.
    if (count === 0 || (props.presentation === 'header' && phoneDevice)) return null;
    return <PendingAttentionPill count={count} phone={props.presentation === 'phone'} compact={compactHeader}
        shortcut={shortcut} onPress={onPress} />;
});

const PHONE_CAPSULE_HIT_REACH = { left: 0, right: 0 } as const;

/** "● 2 need you ⌘⇧J" in the header; "● 2" in the phone session nav. */
export function PendingAttentionPill(props: Readonly<{ count: number; phone: boolean; compact?: boolean; shortcut: string | undefined; onPress: () => unknown }>) {
    const { theme } = useUnistyles();
    const { count, phone } = props;
    // Compact (a tight header) draws the phone capsule's count, keeping the header's identity and full label for assistive tech.
    const countOnly = phone || props.compact === true;
    const shortcut = countOnly ? undefined : props.shortcut;
    const ink = theme.colors.state.attention.foreground;
    const testID = `pending-navigation-${phone ? 'phone' : 'header'}`;
    const label = t('pendingNavigation.nextWithCount', { count });
    return (
        <HappierPressable
            testID={testID}
            accessibilityRole="button"
            accessibilityLabel={`${t('pendingNavigation.next')}: ${label}`}
            onPress={props.onPress}
            // The phone capsule sits flush between two session nav tabs: its hit area grows up and down, never into them.
            {...(phone ? { hitReach: PHONE_CAPSULE_HIT_REACH } : {})}
            style={({ hovered, pressed }) => [
                styles.attention,
                countOnly ? styles.attentionPhone : shortcut ? styles.attentionWithKeys : null,
                { backgroundColor: theme.colors.state.attention.background, opacity: pressed ? 0.8 : hovered ? 0.92 : 1 },
            ]}
        >
            <StatusDot color={ink} size={countOnly ? 6 : 7} />
            <Text testID={`${testID}-count`} style={[styles.attentionLabel, { color: theme.colors.state.attention.textForeground }]} numberOfLines={1}>
                {countOnly ? String(count) : label}
            </Text>
            {!countOnly && shortcut ? (
                <View style={styles.keys}>
                    {splitKeybindingLabel(shortcut).map((key, index) => (
                        <KeyHint key={`${key}-${index}`} label={key} tone="attention" />
                    ))}
                </View>
            ) : null}
        </HappierPressable>
    );
}

/** The post-answer capsule: "● Next  Craft pass lab  wants your permission  [Go ⌘⇧J]  ×" (phone: two lines + Go). */
export function NextComposerPill(props: Readonly<{
    /** Where Next goes, or null when nothing is offered. */
    target: NextTarget | null;
    shortcut: string | undefined;
    onGo: () => unknown;
    composerText?: ComposerTextStore;
}>) {
    const { theme } = useUnistyles();
    const isSessionVisible = useSessionRecordingVisibility();
    const phone = useDeviceType() === 'phone';
    const [dismissed, setDismissed] = React.useState(false);
    const visible = props.target !== null && !dismissed;
    // Typing here means you stayed: the offer leaves by itself (Find lab `fnext` N1a). The subscription lives
    // only while the capsule is offered and renders nothing per keystroke; it dismisses once.
    const composerText = props.composerText;
    React.useEffect(() => {
        if (!visible || !composerText) return undefined;
        const offeredWith = composerText.getPrompt();
        return composerText.subscribe(() => {
            if (composerText.getPrompt() !== offeredWith) setDismissed(true);
        });
    }, [composerText, visible]);
    const elementRef = React.useRef<React.ComponentRef<typeof View>>(null);
    const motion = useOverlayMotionAnimation({ visible, preset: RISE_MOTION, elementRef });
    const { present } = useOverlayPresence(visible, motion.exitMs);
    // A leaving capsule keeps its last words while it settles out.
    const lastTargetRef = React.useRef<NextTarget | null>(null);
    if (props.target && visible) lastTargetRef.current = props.target;
    const heldTarget = lastTargetRef.current;
    const target = heldTarget?.address && !isSessionVisible(heldTarget.address)
        ? { ...heldTarget, title: t('message.provenanceSession') } : heldTarget;
    if (!present || !target) return null;

    const ink = theme.colors.state.attention.foreground;
    const go = () => {
        setDismissed(true);
        return props.onGo();
    };
    // A leaving capsule is no longer an offer: it keeps its look for the exit but drops its handles.
    const leaving = !visible;
    const goLabel = `${t('pendingNavigation.next')}: ${target.title}`;

    return (
        <Animated.View
            ref={elementRef}
            style={[styles.composer, phone ? styles.composerPhone : null, motion.style]}
            pointerEvents={leaving ? 'none' : 'box-none'}
            aria-hidden={leaving ? true : undefined}
        >
            {phone ? (
                <HappierPressable testID={leaving ? undefined : 'pending-navigation-composer'} accessibilityRole="button" accessibilityLabel={goLabel} onPress={go}>
                    <SessionNavigationPill radius={18} shadowLevel={3} rowStyle={styles.phoneRow}>
                        <StatusDot color={ink} size={8} />
                        <View style={styles.phoneText}>
                            <Text style={styles.title} numberOfLines={1}>{`${t('pendingNavigation.next')} · ${target.title}`}</Text>
                            {target.reason ? <Text style={styles.reasonPhone} numberOfLines={1}>{target.reason}</Text> : null}
                        </View>
                        <View style={[styles.go, styles.goPhone, { backgroundColor: ink }]}>
                            <Text style={[styles.goLabel, styles.goLabelPhone]}>{t('pendingNavigation.go')}</Text>
                        </View>
                    </SessionNavigationPill>
                </HappierPressable>
            ) : (
                <SessionNavigationPill radius={22} shadowLevel={3} rowStyle={styles.row} frameStyle={styles.frame}>
                    <StatusDot color={ink} size={8} />
                    <Text style={styles.kicker}>{t('pendingNavigation.next')}</Text>
                    <Text style={[styles.title, target.reason ? styles.titleBesideReason : null]} numberOfLines={1}>{target.title}</Text>
                    {target.reason ? <Text style={styles.reason} numberOfLines={1}>{target.reason}</Text> : null}
                    <HappierPressable
                        testID={leaving ? undefined : 'pending-navigation-composer'}
                        accessibilityRole="button"
                        accessibilityLabel={goLabel}
                        onPress={go}
                        style={({ hovered, pressed }) => [styles.go, { backgroundColor: ink, opacity: pressed ? 0.8 : hovered ? 0.92 : 1 }]}
                    >
                        <Text style={styles.goLabel}>{t('pendingNavigation.go')}</Text>
                        {props.shortcut ? <View style={styles.keys}>{splitKeybindingLabel(props.shortcut).map((key, index) => (
                            <KeyHint key={`${key}-${index}`} label={key} tone="onFill" />
                        ))}</View> : null}
                    </HappierPressable>
                    <HappierPressable
                        testID="pending-navigation-composer-dismiss"
                        accessibilityRole="button"
                        accessibilityLabel={t('pendingNavigation.dismiss')}
                        onPress={() => setDismissed(true)}
                        style={({ hovered }) => [styles.dismiss, hovered ? { backgroundColor: theme.colors.surface.selected } : null]}
                    >
                        <Icon name="x" size={14} color={theme.colors.text.tertiary} />
                    </HappierPressable>
                </SessionNavigationPill>
            )}
        </Animated.View>
    );
}

const styles = StyleSheet.create((theme) => ({
    // Header and phone: the amber attention pill (Find lab `.fd-ny`, `.fd-pnav-ny`).
    attention: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        height: 28,
        borderRadius: 14,
        paddingLeft: theme.space.s8,
        paddingRight: theme.space.s10,
    },
    attentionWithKeys: { paddingRight: theme.space.s6 },
    attentionPhone: { height: 26, borderRadius: 13, gap: theme.space.s4, paddingLeft: theme.space.s8, paddingRight: theme.space.s8 },
    attentionLabel: { ...Typography.variant('meta'), ...Typography.default('semiBold'), ...Typography.tabular() },
    keys: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s2 },
    // Composer: the Next capsule (Find lab `.fd-next`, phone `.fd-pnext`).
    composer: { alignItems: 'center', paddingBottom: theme.space.s12, paddingHorizontal: theme.space.s12 },
    composerPhone: { alignItems: 'stretch', paddingHorizontal: theme.space.s12 },
    // The capsule hugs its words up to the column; a long title or reason gives way first, never Go.
    frame: { maxWidth: '100%' },
    row: { minHeight: 44, gap: theme.space.s10, paddingLeft: 14, paddingRight: theme.space.s6, justifyContent: 'flex-start', maxWidth: 640, minWidth: 0 },
    phoneRow: { minHeight: 52, gap: theme.space.s10, paddingLeft: 14, paddingRight: theme.space.s6, paddingVertical: theme.space.s6, justifyContent: 'flex-start' },
    phoneText: { flex: 1, minWidth: 0 },
    kicker: { ...Typography.variant('meta'), color: theme.colors.text.tertiary },
    title: { ...Typography.variant('meta'), flexShrink: 1, color: theme.colors.text.primary, ...Typography.default('semiBold') },
    // The session's name keeps its width (up to a cap); the reason gives way first.
    titleBesideReason: { flexShrink: 0, maxWidth: 260 },
    reason: { ...Typography.variant('meta'), flexShrink: 1, maxWidth: 300, color: theme.colors.text.secondary },
    reasonPhone: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
    go: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6, height: 32, borderRadius: 16, paddingHorizontal: theme.space.s12, flexShrink: 0 },
    goPhone: { height: 38, borderRadius: 19, paddingHorizontal: 14 },
    // The fill is the attention ink; its label is knocked out in the surface colour (AA in every profile).
    goLabel: { ...Typography.variant('meta'), color: theme.colors.surface.base, ...Typography.default('semiBold') },
    goLabelPhone: { ...Typography.variant('label', 'semiBold') },
    dismiss: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
}));
