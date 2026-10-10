import * as React from 'react';
import { Animated, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { useMountedActivityOverviewSummary } from '@/activity/source/useActivityOverview';
import { buildPendingNavigationFromSource, type PendingNavigationCandidate } from '@/activity/source/buildPendingNavigationFromSource';
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

export type PendingNavigationPillProps = Readonly<{
    address: SessionAddress | null;
    presentation: 'header' | 'composer' | 'phone';
}>;

/** The Next pill rises off the composer edge it stands on (the docked-capsule motion). */
const RISE_MOTION = resolveOverlayMotionPreset({ kind: 'popover', direction: 'top' });

export type NextTarget = Readonly<{ title: string; reason: string | null }>;

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
    };
}

/**
 * Next (⌘⇧J) in its three places (Find lab `fnext`):
 * - `header`: "● 2 need you ⌘⇧J", an amber pill in the session header, only while another session waits;
 * - `phone`: the amber count capsule in the session nav;
 * - `composer`: after you answer, the Next capsule rises above the composer, naming where Next goes.
 */
export const PendingNavigationPill = React.memo(function PendingNavigationPill(props: PendingNavigationPillProps) {
    const { source, nowMs } = useMountedActivityOverviewSummary();
    const serverId = props.address?.serverId;
    const sessionId = props.address?.sessionId;
    const candidates = React.useMemo(() => buildPendingNavigationFromSource({
        source, nowMs, excluding: serverId && sessionId ? { serverId, sessionId } : null,
    }), [source, nowMs, serverId, sessionId]);
    const count = candidates.length;
    const answerToken = useSessionPendingAnswerToken(props.address);
    const landing = usePendingNavigationLanding(props.address);
    const shortcut = useKeyboardShortcutLabel('session.pending.next');
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
            />
        );
    }
    if (count === 0) return null;
    return <PendingAttentionPill count={count} phone={props.presentation === 'phone'} shortcut={shortcut} onPress={onPress} />;
});

/** "● 2 need you ⌘⇧J" in the header; "● 2" in the phone session nav. */
export function PendingAttentionPill(props: Readonly<{ count: number; phone: boolean; shortcut: string | undefined; onPress: () => unknown }>) {
    const { theme } = useUnistyles();
    const { count, phone, shortcut } = props;
    const ink = theme.colors.state.attention.foreground;
    const testID = `pending-navigation-${phone ? 'phone' : 'header'}`;
    const label = t('pendingNavigation.nextWithCount', { count });
    return (
        <HappierPressable
            testID={testID}
            accessibilityRole="button"
            accessibilityLabel={`${t('pendingNavigation.next')}: ${label}`}
            onPress={props.onPress}
            style={({ hovered, pressed }) => [
                styles.attention,
                phone ? styles.attentionPhone : shortcut ? styles.attentionWithKeys : null,
                { backgroundColor: theme.colors.state.attention.background, opacity: pressed ? 0.8 : hovered ? 0.92 : 1 },
            ]}
        >
            <StatusDot color={ink} size={phone ? 6 : 7} />
            <Text testID={`${testID}-count`} style={[styles.attentionLabel, { color: ink }]} numberOfLines={1}>
                {phone ? String(count) : label}
            </Text>
            {!phone && shortcut ? (
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
}>) {
    const { theme } = useUnistyles();
    const phone = useDeviceType() === 'phone';
    const [dismissed, setDismissed] = React.useState(false);
    const visible = props.target !== null && !dismissed;
    const elementRef = React.useRef<React.ComponentRef<typeof View>>(null);
    const motion = useOverlayMotionAnimation({ visible, preset: RISE_MOTION, elementRef });
    const { present } = useOverlayPresence(visible, motion.exitMs);
    // A leaving capsule keeps its last words while it settles out.
    const lastTargetRef = React.useRef<NextTarget | null>(null);
    if (props.target && visible) lastTargetRef.current = props.target;
    const target = lastTargetRef.current;
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
        gap: 6,
        height: 28,
        borderRadius: 14,
        paddingLeft: 9,
        paddingRight: 10,
    },
    attentionWithKeys: { paddingRight: 6 },
    attentionPhone: { height: 26, borderRadius: 13, gap: 5, paddingLeft: 9, paddingRight: 9 },
    attentionLabel: { ...Typography.rowMeta(), ...Typography.default('semiBold'), ...Typography.tabular() },
    keys: { flexDirection: 'row', alignItems: 'center', gap: 2 },
    // Composer: the Next capsule (Find lab `.fd-next`, phone `.fd-pnext`).
    composer: { alignItems: 'center', paddingBottom: 12, paddingHorizontal: 12 },
    composerPhone: { alignItems: 'stretch', paddingHorizontal: 12 },
    // The capsule hugs its words up to the column; a long title or reason gives way first, never Go.
    frame: { maxWidth: '100%' },
    row: { minHeight: 44, gap: 10, paddingLeft: 14, paddingRight: 6, justifyContent: 'flex-start', maxWidth: 640, minWidth: 0 },
    phoneRow: { minHeight: 52, gap: 10, paddingLeft: 14, paddingRight: 6, paddingVertical: 6, justifyContent: 'flex-start' },
    phoneText: { flex: 1, minWidth: 0 },
    kicker: { ...Typography.rowMeta(), color: theme.colors.text.tertiary },
    title: { ...Typography.rowMeta(), flexShrink: 1, color: theme.colors.text.primary, ...Typography.default('semiBold') },
    // The session's name keeps its width (up to a cap); the reason gives way first.
    titleBesideReason: { flexShrink: 0, maxWidth: 260 },
    reason: { ...Typography.rowMeta(), flexShrink: 1, maxWidth: 300, color: theme.colors.text.secondary },
    reasonPhone: { ...Typography.rowMeta(), color: theme.colors.text.secondary },
    go: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 32, borderRadius: 16, paddingHorizontal: 12, flexShrink: 0 },
    goPhone: { height: 38, borderRadius: 19, paddingHorizontal: 14 },
    // The fill is the attention ink; its label is knocked out in the surface colour (AA in every profile).
    goLabel: { ...Typography.rowMeta(), color: theme.colors.surface.base, ...Typography.default('semiBold') },
    goLabelPhone: { ...Typography.rowTitle() },
    dismiss: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
}));
