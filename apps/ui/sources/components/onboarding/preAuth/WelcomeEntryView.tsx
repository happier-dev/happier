import { HAPPIER_BALANCED_TEXT_WRAP, HappierBodyEdgeContext } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { Platform, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { StepMotionLayer, useFirstRunWorkflowMotion } from '@/components/ui/motion/stepMotion/StepMotionLayer';
import { runStepMove } from '@/components/ui/motion/stepMotion/StepMotionStage';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { STEP_DOOR_WIDTH_PX, StepOrDivider } from '@/components/onboarding/unauthShell/StepFormParts';
import { RelayRetentionDisclosure } from '@/components/onboarding/unauthShell/RelayRetentionDisclosure';
import { ShellHeaderClearanceContext, useShellCornerDoor, useShellCornerNote } from '@/components/onboarding/unauthShell/shellCorner';
import { OrganizationPolicyInvalidHelp, OrganizationPolicyManagedLine } from '@/components/organizationPolicy/OrganizationPolicyFieldNotice';
import { HomeContextLine } from '@/components/onboarding/ui/ActiveRelaySummary';
import { t } from '@/text';

import { WelcomeActionCard, WelcomeWayButton } from './WelcomeActionCard';
import { WelcomeActionList, type WelcomeActionAdmission } from './WelcomeActionList';
import type { WelcomeEntryViewModel } from './welcomeEntryViewModel';

export type { WelcomeEntryViewModel } from './welcomeEntryViewModel';

export type WelcomeEntryViewInteraction = Readonly<{
    admission: WelcomeActionAdmission;
    getActionId: (index: number) => string | undefined;
    onAction: (index: number) => Promise<void> | void;
    /** A notice's one way on (Try again, or the alternative choice), by its test id. */
    onNoticeAction: (testID: string) => void;
    onSelfHosting: () => void;
    onRetryRetention?: () => void;
    policySupportUrl?: string;
}>;

/** The subline wraps to two short balanced lines under the headline. */
const WELCOME_INTRO_WIDTH_PX = 300;

const noAction = () => {};
const inertAdmission: WelcomeActionAdmission = { pendingActionId: null, run: async () => {} };

/** The live Welcome and the opening replica share this presentation. */
export const WelcomeEntryView = React.memo(function WelcomeEntryView({
    model, compact, interaction, waysLeading,
}: Readonly<{
    model: WelcomeEntryViewModel;
    compact: boolean;
    interaction?: WelcomeEntryViewInteraction;
    /** Marks the host puts first on the ways row. They can remain visible during approval. */
    waysLeading?: React.ReactNode;
}>) {
    useUnistyles();
    const styles = stylesheet;
    const actionIdAt = (index: number) => interaction?.getActionId(index) ?? `welcome-action-${index}`;
    const renderAction = ({ index, display }: WelcomeEntryViewModel['doors'][number]) => {
        const actionId = actionIdAt(index);
        return <WelcomeActionCard key={actionId} {...display} actionId={actionId}
            disabled={!interaction} onPress={interaction ? () => interaction.onAction(index) : noAction} />;
    };
    const renderWay = ({ index, display }: WelcomeEntryViewModel['quietWays'][number]) => {
        const actionId = actionIdAt(index);
        return <WelcomeWayButton key={actionId} testID={display.testID} actionId={actionId} title={display.title}
            subtitle={display.subtitle} iconName={display.iconName} disabled={!interaction}
            onPress={interaction ? () => interaction.onAction(index) : noAction} />;
    };
    // A computer's shell takes the self-hosting door to its top-right corner; a phone keeps it under the column.
    const selfHostingInCorner = useShellCornerDoor(model.selfHosting ? {
        testID: model.selfHosting.display.testID, label: model.selfHosting.display.title, onPress: interaction?.onSelfHosting,
    } : null);
    // A computer's shell stands the retention line in its bottom-right corner; a phone keeps it under the trust line.
    const retentionInCorner = useShellCornerNote(model.retention
        ? { disclosure: model.retention, onRetry: interaction?.onRetryRetention }
        : null);
    const hasWays = model.quietWays.length > 0 || waysLeading != null;
    // A greeting says "Loading" as one quiet line in the reserved place under the trust line, where the retention
    // summary later stands; only a notice that asks for something takes the slot above the doors.
    const loadingInRetentionSlot = Boolean(model.trust);
    const quietLoading = loadingInRetentionSlot ? model.notices.filter((notice) => notice.kind === 'loading') : [];
    const slotNotices = loadingInRetentionSlot ? model.notices.filter((notice) => notice.kind !== 'loading') : model.notices;
    const noticeAction = interaction?.onNoticeAction;
    // The column grows up into the space below the shell header. Any remaining notice height takes its place
    // above the doors in normal layout. The restore ways under Approve have no heading to lift.
    const anchoredNotices = model.heading != null || model.policy != null;
    const [noticeHeight, setNoticeHeight] = React.useState(0);
    const headerClearance = React.useContext(ShellHeaderClearanceContext);
    const lift = anchoredNotices ? Math.min(noticeHeight, headerClearance) : 0;
    return (
        <View testID="welcome-decision-panel" style={[styles.root, compact ? styles.rootCompact : null]}
            pointerEvents={interaction ? 'auto' : 'none'} accessibilityElementsHidden={!interaction}
            aria-hidden={!interaction}
            importantForAccessibility={interaction ? 'auto' : 'no-hide-descendants'}>
            {model.heading || model.policy ? <View style={[styles.aboveDoors, compact ? styles.aboveDoorsCompact : null,
                lift > 0 ? { transform: [{ translateY: -lift }] } : null]}>
                {model.heading ? <View style={styles.headingBlock}>
                    {model.context ? <View style={styles.context}>
                        <HomeContextLine testID="welcome-home-context" {...model.context} />
                    </View> : null}
                    <Text accessibilityRole="header" style={[styles.title, compact ? styles.headlineCompact : null]}>
                        {compact && model.heading.compact ? model.heading.compact.title : model.heading.title}
                    </Text>
                    <Text accessibilityRole="header" style={[styles.subtitleTitle, compact ? styles.headlineCompact : null]}>
                        {compact && model.heading.compact ? model.heading.compact.subtitle : model.heading.subtitle}
                    </Text>
                    {model.heading.intro ? (
                        <Text testID="welcome-intro" style={[styles.intro, compact ? styles.introCompact : null]}>
                            {model.heading.intro}
                        </Text>
                    ) : null}
                </View> : null}
                {model.policy?.kind === 'managed' ? <OrganizationPolicyManagedLine display={model.policy.display}
                    testID={`organization-policy-${model.policy.field}`} supportUrl={interaction?.policySupportUrl} /> :
                    model.policy?.kind === 'invalid' ? <OrganizationPolicyInvalidHelp interactive={Boolean(interaction)} /> : null}
            </View> : null}
            <WelcomeActionList admission={interaction?.admission ?? inertAdmission}>
                <View style={styles.actionStack}>
                    {!anchoredNotices && slotNotices.length > 0 ? (
                        <WelcomeNotices layer="welcome-notices" notices={slotNotices} onAction={noticeAction} />
                    ) : null}
                    <View style={styles.ways}>
                        {anchoredNotices ? (
                            <WelcomeNotices layer="welcome-notices" notices={slotNotices} onAction={noticeAction}
                                lift={lift} onHeight={setNoticeHeight} />
                        ) : null}
                        <View testID="welcome-doors" style={styles.doors}>
                            {model.primaryDoorPending ? <PendingPrimaryDoor /> : null}
                            {model.doors.map(renderAction)}
                        </View>
                        {hasWays ? (
                            // The ways row (owner 2026-11-19): a centred "or", then round marks without captions.
                            <View testID="welcome-quiet-ways" style={styles.quietWays}>
                                <StepOrDivider label={t('common.or')} />
                                <View role="group" aria-label={model.quietWaysTitle} style={[styles.waysRow, compact ? styles.waysRowCompact : null]}>
                                    {waysLeading}
                                    {model.quietWays.map(renderWay)}
                                </View>
                            </View>
                        ) : null}
                    </View>
                    {model.trust ? (
                        <View style={styles.trust}>
                            <Text testID="welcome-trust" style={styles.trustText}>{model.trust}</Text>
                            <View style={styles.retention}>
                                {quietLoading.length > 0 ? (
                                    <WelcomeNotices layer="welcome-loading" notices={quietLoading} onAction={noticeAction} />
                                ) : model.retention && !retentionInCorner ? (
                                    <RelayRetentionDisclosure testID="welcome-retention"
                                        disclosure={{ ...model.retention, retry: interaction?.onRetryRetention }} />
                                ) : null}
                            </View>
                        </View>
                    ) : null}
                    {model.selfHosting && !selfHostingInCorner ? (
                        <View style={styles.selfHosting}>
                            <WelcomeActionCard {...model.selfHosting.display} disabled={!interaction}
                                onPress={interaction?.onSelfHosting ?? noAction} />
                        </View>
                    ) : null}
                    {model.closingNotice ? (
                        <WelcomeNotices layer="welcome-closing-notice" notices={[model.closingNotice]} onAction={noticeAction} />
                    ) : null}
                </View>
            </WelcomeActionList>
        </View>
    );
});

/** Holds the primary door's box, unseen, so the doors below it never move when the catalog settles. */
function PendingPrimaryDoor() {
    return (
        <View testID="welcome-primary-door-pending" style={stylesheet.pendingDoor} pointerEvents="none"
            aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <WelcomeActionCard actionId="welcome-primary-door-pending" testID="welcome-primary-door-pending-card"
                title={t('welcome.welcomePrimaryButton')} subtitle={t('welcome.welcomePrimarySubtitle')} primary disabled
                onPress={noAction} />
        </View>
    );
}

function WelcomeNotices({ layer, notices, onAction, lift = 0, onHeight }: Readonly<{
    layer: string;
    notices: WelcomeEntryViewModel['notices'];
    onAction?: (testID: string) => void;
    lift?: number;
    /** Reports the notice's natural height, including the gap above the doors. */
    onHeight?: (height: number) => void;
}>) {
    const firstRun = useFirstRunWorkflowMotion();
    const animate = firstRun && onAction != null;
    const key = JSON.stringify(notices);
    const [shown, setShown] = React.useState(() => ({ key, notices }));
    React.useLayoutEffect(() => {
        if (!animate || shown.key === key) return;
        runStepMove({ layer, kind: 'notice', commit: () => setShown({ key, notices }) });
    }, [animate, key, layer, notices, shown.key]);
    const visible = animate ? shown.notices : notices;
    const box = React.useRef<View>(null);
    const empty = visible.length === 0;
    const report = React.useCallback((height: number) => onHeight?.(empty ? 0 : Math.ceil(height)), [empty, onHeight]);
    React.useLayoutEffect(() => {
        // Web measures before paint, so the lines above never overlap a newly arrived notice for a frame.
        const node = box.current as unknown as { getBoundingClientRect?: () => { height: number } } | null;
        if (Platform.OS === 'web' && node?.getBoundingClientRect) report(node.getBoundingClientRect().height);
    }, [report, shown.key, key]);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => report(event.nativeEvent.layout.height), [report]);
    const layerElement = (
        <StepMotionLayer layerKey={layer} stepKey={animate ? shown.key : undefined} active={animate}
            warmOnMount={false} retainContent style={stylesheet.noticeLines}>
            {visible.map(notice => <WelcomeNotice key={notice.slot} notice={notice} onAction={onAction} />)}
        </StepMotionLayer>
    );
    if (!onHeight) return layerElement;
    return (
        <View ref={box} testID="welcome-notice-slot" onLayout={onLayout}
            style={[empty ? null : stylesheet.noticeSlotFilled, lift === 0 ? null : { marginTop: -lift }]}>
            {layerElement}
        </View>
    );
}

function WelcomeNotice({ notice, onAction }: Readonly<{
    notice: WelcomeEntryViewModel['notices'][number];
    onAction?: (testID: string) => void;
}>) {
    const { action } = notice;
    return (
        <HappierBodyEdgeContext.Provider value>
            <SurfaceStateCard
                testID={notice.testID}
                size="line"
                lineLayout="notice"
                kind={notice.kind}
                title={notice.title}
                reason={notice.reason}
                accessibilitySemantics="status"
                actionGlyph={action?.glyph}
                action={action ? {
                    testID: action.testID, label: action.label, disabled: !onAction,
                    onPress: onAction ? () => onAction(action.testID) : noAction,
                } : undefined}
            />
        </HappierBodyEdgeContext.Provider>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    // Direction A: one centred column over the planet; the headline is art-directed, the doors narrower than it.
    root: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        width: '100%',
        maxWidth: 520,
        alignSelf: 'center',
        gap: theme.space.s24,
    },
    rootCompact: {
        gap: theme.space.s16,
    },
    context: {
        maxWidth: '100%',
        marginBottom: theme.space.s12,
    },
    headingBlock: {
        maxWidth: '100%',
        alignItems: 'center',
        // No vertical gap between the two title lines — matches the brand
        // tagline's `Start coding anywhere. / Continue everywhere.` rhythm, where
        // line-height == font-size and the lines sit flush against each other.
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 44,
        // line-height == font-size mirrors the brand tagline (48/48). At 44px
        // this gives the same tight, deliberate vertical spacing the planet
        // tagline uses on the left pane.
        lineHeight: 44,
        letterSpacing: -1.54,
        textAlign: 'center',
        color: theme.colors.text.primary,
        // Two short lines split evenly: no word alone on the last line (web; native has no balance).
        ...HAPPIER_BALANCED_TEXT_WRAP,
    },
    subtitleTitle: {
        ...Typography.default('semiBold'),
        fontSize: 44,
        lineHeight: 44,
        letterSpacing: -1.54,
        textAlign: 'center',
        color: theme.colors.text.secondary,
        ...HAPPIER_BALANCED_TEXT_WRAP,
    },
    actionStack: {
        gap: theme.space.s12,
        width: '100%',
        maxWidth: STEP_DOOR_WIDTH_PX,
        alignSelf: 'center',
    },
    // The heading block and any policy line, lifted together when a notice stands above the doors.
    aboveDoors: {
        alignSelf: 'stretch',
        alignItems: 'center',
        gap: theme.space.s24,
    },
    aboveDoorsCompact: {
        gap: theme.space.s16,
    },
    noticeSlotFilled: {
        paddingBottom: theme.space.s12,
    },
    noticeLines: {
        gap: theme.space.s12,
    },
    pendingDoor: {
        opacity: 0,
    },
    ways: {
        width: '100%',
    },
    doors: {
        gap: theme.space.s12,
        width: '100%',
    },
    quietWays: {
        marginTop: theme.space.s8,
        gap: theme.space.s16,
    },
    // Lab Approve: 44 px wells 20 px apart on one line, centred under the "or" (a longer row reaches past the doors'
    // width evenly on both sides rather than wrapping under itself).
    waysRow: {
        flexDirection: 'row',
        alignSelf: 'center',
        justifyContent: 'center',
        gap: theme.space.s20,
    },
    // A phone spreads the row across the column (lab phone Approve), so every way fits on the one line.
    waysRowCompact: {
        alignSelf: 'stretch',
        justifyContent: 'space-between',
        gap: 0,
    },
    intro: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
        textAlign: 'center',
        maxWidth: WELCOME_INTRO_WIDTH_PX,
        marginTop: theme.space.s16,
        ...HAPPIER_BALANCED_TEXT_WRAP,
    },
    introCompact: {
        ...Typography.variant('body'),
        marginTop: theme.space.s10,
    },
    headlineCompact: {
        fontSize: 40,
        lineHeight: 40,
        letterSpacing: -1.4,
    },
    selfHosting: {
        marginTop: theme.space.s8,
        alignItems: 'center',
    },
    trust: {
        marginTop: theme.space.s4,
        alignItems: 'center',
    },
    trustText: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
        textAlign: 'center',
    },
    // Two lines are kept for the summary, so it arrives after the doors without moving them.
    retention: {
        width: '100%',
        // The gap above plus two body lines.
        minHeight: 56,
        paddingTop: theme.space.s16,
    },
}));
