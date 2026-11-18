import * as React from 'react';
import { View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { machinePageHref } from '@/components/machines/page/machinePageHref';
import { useMachineServicesList } from '@/components/machines/services/useMachineServicesList';
import { MachineCliGlyphs } from '@/components/sessions/new/components/MachineCliGlyphs';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceCard } from '@/components/ui/cards/SurfaceCard';
import { Icon } from '@/components/ui/icons/Icon';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { InlineStatus } from '@/components/ui/status/InlineStatus';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { PlanChecklistCard } from '@/components/systemTasks/planChecklist/PlanChecklistCard';
import { projectReportedSteps } from '@/components/systemTasks/planChecklist/projectReportedSteps';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { hapticsSuccess } from '@/components/ui/theme/haptics';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';
import type { MachineAddArrivalNext } from './useMachineAddFlow';

/** A pushed way's page (lab add/sshp, phone-system-1109 p5-pair): its page header names the way and shows its lead. */
export type MachineAddPageLead = Readonly<{ publish: (lead: string | null) => void }>;

const MachineAddPageLeadContext = React.createContext<MachineAddPageLead | null>(null);

/** Inside a pushed way's page the pane hands its lead to the page header instead of drawing its own. */
export const MachineAddPageLeadProvider = MachineAddPageLeadContext.Provider;

/** The pane's title and one-paragraph lead (what this way does, in the person's words). */
export function MachineAddPaneHeader(props: Readonly<{ title: string; lead: string; testID?: string }>) {
    const styles = stylesheet;
    const page = React.useContext(MachineAddPageLeadContext);
    const publish = page?.publish;
    // Before paint, so the page header's description never arrives late and pushes the page down.
    React.useLayoutEffect(() => {
        if (!publish) return undefined;
        publish(props.lead);
        return () => publish(null);
    }, [publish, props.lead]);
    if (page) return null;
    return (
        <View testID={props.testID} style={styles.header}>
            <Text accessibilityRole="header" style={styles.title}>{props.title}</Text>
            <Text style={styles.lead}>{props.lead}</Text>
        </View>
    );
}

function formatElapsed(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** The elapsed time of a wait, ticking in its own leaf so nothing else re-renders each second. */
function Elapsed(props: Readonly<{ sinceMs: number }>) {
    const styles = stylesheet;
    const [now, setNow] = React.useState(() => Date.now());
    React.useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, []);
    return <Text style={styles.elapsed}>{formatElapsed(now - props.sinceMs)}</Text>;
}

/**
 * "Watching for devbox on Personal Home… 0:42": the one live line while the flow waits for a machine
 * to join (lab MX 1). The watch itself is the arrival owner's; this only says it is happening.
 */
export const MachineWatchLine = React.memo(function MachineWatchLine(props: Readonly<{
    testID: string;
    subject: string;
    homeName: string;
    startedAtMs: number | null;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    return (
        <View testID={props.testID} style={styles.watch} accessibilityRole="text" accessibilityLiveRegion="polite">
            <StatusDot color={theme.colors.status.connecting} isPulsing size={8} />
            <Text style={styles.watchText}>
                {t('addFlows.machineWatching', { subject: props.subject })}
                <Text style={styles.watchHome}>{props.homeName}</Text>
                {'…'}
            </Text>
            {props.startedAtMs !== null ? <Elapsed sinceMs={props.startedAtMs} /> : null}
        </View>
    );
});

/** After a long quiet wait (the flow's timer): the likely causes, while watching goes on (lab MX "Not seeing it"). */
export const MachineNotSeeingNotice = React.memo(function MachineNotSeeingNotice(props: Readonly<{
    testID: string;
    subject: string;
    homeName: string;
}>) {
    return (
        <AttentionBanner
            testID={props.testID}
            tone="warning"
            title={t('addFlows.machineNotSeeingTitle', { subject: props.subject })}
            description={t('addFlows.machineNotSeeingBody', { home: props.homeName })}
            accessibilityLiveRegion="polite"
        />
    );
});

export type MachineAddStep = Readonly<{
    id: string;
    label: string;
    state: 'done' | 'running' | 'pending' | 'failed';
    elapsedMs: number | null;
}>;

/**
 * A running setup's steps, as the system task reports them (lab MS "setting up", MS2 "running"). Over SSH the
 * card opens with the server it is setting up and, on a phone, closes with the hold line (lab af-ssh Ip).
 */
export const MachineAddStepList = React.memo(function MachineAddStepList(props: Readonly<{
    testID: string;
    steps: readonly MachineAddStep[];
    identity?: Readonly<{ title: string; subtitle: string }> | null;
    hold?: string | null;
}>) {
    const steps = React.useMemo(() => projectReportedSteps(props.steps.map((step) => {
        const state = step.state === 'pending' ? 'upcoming' : step.state;
        return {
            key: step.id,
            title: step.label,
            state,
            ...(step.elapsedMs !== null && step.state !== 'pending' ? { meta: formatElapsed(step.elapsedMs) } : {}),
        };
    })), [props.steps]);
    const styles = stylesheet;
    const { theme } = useUnistyles();
    return (
        <View style={styles.steps}>
            {props.identity ? (
                <View testID={`${props.testID}.identity`} style={styles.identity}>
                    <Icon name="hard-drives" size={22} color={theme.colors.text.secondary} />
                    <View style={styles.cardCopy}>
                        <Text style={styles.cardName} numberOfLines={1}>{props.identity.title}</Text>
                        <Text style={styles.cardFact} numberOfLines={1}>{props.identity.subtitle}</Text>
                    </View>
                </View>
            ) : null}
            <PlanChecklistCard testID={props.testID} phase="execute" {...steps} />
            {props.hold ? (
                <View testID={`${props.testID}.hold`} style={styles.hold}>
                    <Icon name="device-mobile" size={16} color={theme.colors.text.secondary} />
                    <Text style={styles.holdText}>{props.hold}</Text>
                </View>
            ) : null}
        </View>
    );
});

export type MachineAddFailure = Readonly<{
    title: string;
    body: string;
    details: string | null;
}>;

/**
 * A setup that stopped: the cause and one recovery, where the eye already is; the inputs stay as they
 * were (lab MS "failed", MX "sign-in refused"). Same notice as every other failure in the app.
 */
export const MachineAddFailureNotice = React.memo(function MachineAddFailureNotice(props: Readonly<{
    testID: string;
    failure: MachineAddFailure;
    onRetry?: () => void;
    secondary?: Readonly<{ label: string; onPress: () => void }> | null;
}>) {
    return (
        <AttentionBanner
            testID={props.testID}
            tone="warning"
            title={props.failure.title}
            description={props.failure.body}
            details={props.failure.details ? [props.failure.details] : undefined}
            announce="alert"
            action={props.onRetry ? { label: t('common.retry'), onPress: props.onRetry, testID: `${props.testID}.retry` } : null}
            secondaryAction={props.secondary ? { ...props.secondary, testID: `${props.testID}.secondary` } : null}
        />
    );
});

/**
 * The machine that just joined (lab MX 3, the Git SX grammar): one quiet success line, the machine's card
 * with one soft ring, and the next step. Phones get one light success haptic.
 */
export const MachineArrivedCard = React.memo(function MachineArrivedCard(props: Readonly<{
    testID: string;
    machineId: string;
    serverId: string;
    name: string;
    facts: string;
    /** Where continuing takes the person (the add flow decides from where they started); absent, Start a session. */
    next?: MachineAddArrivalNext;
    onStartSession: () => void;
    onAddAnother: () => void;
}>) {
    const styles = stylesheet;
    const router = useRouter();
    // The arrival line (ruling 08:07Z): what the first successful read of this Machine found, said here and nowhere else.
    const { firstInventoryCount } = useMachineServicesList({ serverId: props.serverId, machineId: props.machineId, active: true });
    const next = props.next ?? 'session';
    const { machineId, serverId, onStartSession } = props;
    const openMachine = React.useCallback(() => {
        router.push(machinePageHref({ door: 'settings', target: { machineId, serverId } }) as never);
    }, [machineId, router, serverId]);
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const ring = useSharedValue(reducedMotion ? 0 : 1);
    React.useEffect(() => {
        void hapticsSuccess();
        if (!reducedMotion) ring.value = withTiming(0, { duration: 900 });
    }, [reducedMotion, ring]);
    const ringStyle = useAnimatedStyle(() => ({ opacity: ring.value * 0.6 }));

    return (
        <View testID={props.testID} style={styles.arrived}>
            <SurfaceStateCard
                testID={`${props.testID}.line`}
                kind="success"
                size="line"
                title={t('addFlows.machineArrived', { machine: props.name })}
                reason={firstInventoryCount === null ? undefined : t('addFlows.machineFoundServices', { count: firstInventoryCount })}
                accessibilitySemantics="status"
            />
            <View style={styles.cardFrame}>
                <Animated.View pointerEvents="none" style={[styles.ring, { borderColor: theme.colors.status.connected }, ringStyle]} />
                <SurfaceCard testID={`${props.testID}.card`} padding="sm">
                    <View style={styles.cardRow}>
                        <Icon name="desktop" size={22} color={theme.colors.text.secondary} />
                        <View style={styles.cardCopy}>
                            <Text style={styles.cardName} numberOfLines={1}>{props.name}</Text>
                            {/* The arrived Machine is online: its facts through the one inline Status (UI refinements 2026-11-15). */}
                            <InlineStatus tone="success" label={props.facts} />
                        </View>
                        <MachineCliGlyphs machineId={props.machineId} serverId={props.serverId} isOnline />
                    </View>
                </SurfaceCard>
            </View>
            <View style={styles.actions}>
                {next === 'session' ? <RoundButton
                    testID={`${props.testID}.startSession`}
                    size="small"
                    title={t('addFlows.machineStartSession', { machine: props.name })}
                    onPress={onStartSession}
                /> : <RoundButton
                    testID={`${props.testID}.continue`}
                    size="small"
                    title={t(next === 'picker' ? 'addFlows.machineUse' : 'addFlows.machineOpen', { machine: props.name })}
                    onPress={next === 'picker' ? onStartSession : openMachine}
                />}
                <RoundButton
                    testID={`${props.testID}.addAnother`}
                    size="small"
                    display="inverted"
                    title={t('addFlows.machineAddAnother')}
                    leading={<Icon name="plus" size={14} color={theme.colors.text.primary} />}
                    onPress={props.onAddAnother}
                />
            </View>
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    header: {
        gap: theme.space.s6,
        paddingRight: 28,
    },
    title: {
        ...Typography.variant('heading'),
        lineHeight: 24,
        color: theme.colors.text.primary,
    },
    lead: {
        ...Typography.default(),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text.secondary,
    },
    watch: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s10,
        paddingTop: theme.space.s12,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    watchText: {
        flex: 1,
        minWidth: 0,
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
    },
    watchHome: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    elapsed: {
        ...Typography.variant('meta'),
        fontVariant: ['tabular-nums'],
        color: theme.colors.text.tertiary,
    },
    steps: {
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        overflow: 'hidden',
        paddingHorizontal: theme.space.s12,
    },
    identity: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s12,
        paddingTop: theme.space.s12,
        paddingBottom: theme.space.s4,
    },
    hold: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s10,
        marginBottom: theme.space.s12,
        padding: theme.space.s12,
        borderRadius: theme.borderRadius.md,
        backgroundColor: theme.colors.surface.inset,
    },
    holdText: {
        flex: 1,
        minWidth: 0,
        ...Typography.variant('body', 'medium'),
        color: theme.colors.text.primary,
    },
    arrived: {
        gap: theme.space.s12,
    },
    cardFrame: {
        position: 'relative',
    },
    ring: {
        position: 'absolute',
        top: -3,
        left: -3,
        right: -3,
        bottom: -3,
        borderRadius: 14,
        borderWidth: 3,
    },
    cardRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s12,
    },
    cardCopy: {
        flex: 1,
        minWidth: 0,
        gap: theme.space.s2,
    },
    cardName: {
        ...Typography.variant('heading'),
        color: theme.colors.text.primary,
    },
    cardFact: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    actions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: theme.space.s8,
    },
}));
