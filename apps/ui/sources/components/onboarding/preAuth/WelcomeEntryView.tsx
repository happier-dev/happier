import { HAPPIER_BALANCED_TEXT_WRAP, HappierBodyEdgeContext } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { Platform, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useLaunchCurtainState } from '@/boot/launchCurtain';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { StepMotionLayer, useFirstRunWorkflowMotion } from '@/components/ui/motion/stepMotion/StepMotionLayer';
import { runStepMove } from '@/components/ui/motion/stepMotion/StepMotionStage';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { STEP_DOOR_WIDTH_PX, StepOrDivider } from '@/components/onboarding/unauthShell/StepFormParts';
import { RelayRetentionDisclosure } from '@/components/onboarding/unauthShell/RelayRetentionDisclosure';
import { ShellHeaderClearanceContext, ShellWelcomeOverflowContext, useShellCornerDoor, useShellCornerNote } from '@/components/onboarding/unauthShell/shellCorner';
import { OrganizationPolicyInvalidHelp, OrganizationPolicyManagedLine } from '@/components/organizationPolicy/OrganizationPolicyFieldNotice';
import { HomeContextLine } from '@/components/onboarding/ui/ActiveRelaySummary';
import { t } from '@/text';

import { WelcomeActionCard, WelcomeWayButton } from './WelcomeActionCard';
import { WelcomeActionList, type WelcomeActionAdmission } from './WelcomeActionList';
import { WelcomeHeadline } from './WelcomeHeadline';
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
    // The shell places the disclosure outside the main column.
    const retentionInCorner = useShellCornerNote(model.retention
        ? { disclosure: model.retention, onRetry: interaction?.onRetryRetention }
        : null);
    const hasWays = model.quietWays.length > 0 || waysLeading != null;
    const noticeAction = interaction?.onNoticeAction;
    const firstRun = useFirstRunWorkflowMotion();
    const curtainState = useLaunchCurtainState();
    const animateNotices = firstRun && noticeAction != null && curtainState !== 'up';
    const noticeKey = JSON.stringify(model.notices);
    const [shown, setShown] = React.useState(() => ({ key: noticeKey, notices: model.notices }));
    React.useLayoutEffect(() => {
        if (shown.key === noticeKey) return;
        const commit = () => setShown({ key: noticeKey, notices: model.notices });
        if (animateNotices) runStepMove({ layer: WELCOME_NOTICE_LAYER, kind: 'notice', commit });
        else commit();
    }, [animateNotices, model.notices, noticeKey, shown.key]);
    const visible = animateNotices ? shown.notices : model.notices;
    const [measuredNoticeHeight, setNoticeHeight] = React.useState(0);
    const noticeHeight = visible.length > 0 ? measuredNoticeHeight : 0;
    const headerClearance = React.useContext(ShellHeaderClearanceContext);
    const setOverflow = React.useContext(ShellWelcomeOverflowContext);
    // A top-aligned Home sign-in step uses the same tail without a centering spacer.
    const separateNotices = model.heading != null || model.policy != null;
    const above = setOverflow !== null && separateNotices && noticeHeight <= headerClearance;
    React.useLayoutEffect(() => {
        setOverflow?.(separateNotices && !above ? noticeHeight : 0);
    }, [above, noticeHeight, separateNotices, setOverflow]);
    React.useLayoutEffect(() => () => setOverflow?.(0), [setOverflow]);
    const notices = <WelcomeNotices notices={visible} onAction={noticeAction}
        placement={above ? 'header' : separateNotices ? 'tail' : 'inline'} compact={compact}
        motionKey={animateNotices ? shown.key : undefined} onMeasure={setNoticeHeight} />;
    return (
        <View testID="welcome-decision-panel" style={[styles.root, compact ? styles.rootCompact : null]}
            pointerEvents={interaction ? 'auto' : 'none'} accessibilityElementsHidden={!interaction}
            aria-hidden={!interaction}
            importantForAccessibility={interaction ? 'auto' : 'no-hide-descendants'}>
            {model.heading || model.policy ? <View style={[styles.aboveDoors, compact ? styles.aboveDoorsCompact : null]}>
                {model.heading ? <View style={styles.headingBlock}>
                    {model.context ? <View style={styles.context}>
                        <HomeContextLine testID="welcome-home-context" {...model.context} />
                    </View> : null}
                    {model.heading.rotation && !(compact && model.heading.compact) ? (
                        <WelcomeHeadline headline={model.heading.rotation} interactive={interaction != null}
                            lineStyle={[styles.title, compact ? styles.headlineCompact : null]}
                            line2Style={[styles.subtitleTitle, compact ? styles.headlineCompact : null]} />
                    ) : <>
                        <Text accessibilityRole="header" style={[styles.title, compact ? styles.headlineCompact : null]}>
                            {compact && model.heading.compact ? model.heading.compact.title : model.heading.title}
                        </Text>
                        <Text accessibilityRole="header" style={[styles.subtitleTitle, compact ? styles.headlineCompact : null]}>
                            {compact && model.heading.compact ? model.heading.compact.subtitle : model.heading.subtitle}
                        </Text>
                    </>}
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
                    {!separateNotices ? notices : null}
                    <View style={styles.ways}>
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
                            {model.retention && !retentionInCorner ? (
                                <View style={styles.retention}>
                                    <RelayRetentionDisclosure testID="welcome-retention"
                                        disclosure={{ ...model.retention, retry: interaction?.onRetryRetention }} />
                                </View>
                            ) : null}
                        </View>
                    ) : null}
                    {model.selfHosting && !selfHostingInCorner ? (
                        <View style={styles.selfHosting}>
                            <WelcomeActionCard {...model.selfHosting.display} disabled={!interaction}
                                onPress={interaction?.onSelfHosting ?? noAction} />
                        </View>
                    ) : null}
                </View>
            </WelcomeActionList>
            {separateNotices ? notices : null}
        </View>
    );
});

/** A disabled primary door holds the same box as the admitted action while the catalog is loading. */
function PendingPrimaryDoor() {
    return (
        <View testID="welcome-primary-door-pending">
            <WelcomeActionCard actionId="welcome-primary-door-pending" testID="welcome-primary-door-pending-card"
                title={t('welcome.welcomePrimaryButton')} subtitle={t('welcome.welcomePrimarySubtitle')} primary disabled
                onPress={noAction} />
        </View>
    );
}

const WELCOME_NOTICE_LAYER = 'welcome-notices';

function WelcomeNotices({ notices, onAction, placement, compact, motionKey, onMeasure }: Readonly<{
    notices: WelcomeEntryViewModel['notices'];
    onAction?: (testID: string) => void;
    placement: 'header' | 'tail' | 'inline';
    compact: boolean;
    motionKey?: string;
    /** Reports the measured slot, including the gap above the doors. */
    onMeasure: (height: number) => void;
}>) {
    const box = React.useRef<View>(null);
    const empty = notices.length === 0;
    React.useLayoutEffect(() => {
        // Web measures before paint, so the lines above never overlap a newly arrived notice for a frame.
        const node = box.current as unknown as HTMLElement | null;
        if (empty) onMeasure(0);
        else if (Platform.OS === 'web' && node?.getBoundingClientRect) onMeasure(node.getBoundingClientRect().height);
    }, [empty, notices, onMeasure]);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => onMeasure(event.nativeEvent.layout.height), [onMeasure]);
    return (
        <View ref={box} testID={empty ? undefined : 'welcome-notice-slot'} onLayout={onLayout}
            pointerEvents={empty ? 'none' : undefined}
            style={empty ? stylesheet.emptyNoticeSlot : placement === 'header' ? stylesheet.noticeAboveHeading
                : placement === 'tail'
                    ? [stylesheet.noticeTail, compact ? stylesheet.noticeTailCompact : null]
                    : stylesheet.noticeInColumn}>
            <StepMotionLayer layerKey={WELCOME_NOTICE_LAYER} stepKey={motionKey} active={motionKey !== undefined}
                warmOnMount={false} retainContent style={stylesheet.noticeLines}>
                {notices.map(notice => <WelcomeNotice key={notice.slot} notice={notice} onAction={onAction} />)}
            </StepMotionLayer>
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
        // The column's width, so the headline's fixed line can fit itself to it (its parts stand by transform).
        alignSelf: 'stretch',
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
    // The heading block shares the reserved top of the column with startup policy copy.
    aboveDoors: {
        alignSelf: 'stretch',
        alignItems: 'center',
        gap: theme.space.s24,
    },
    aboveDoorsCompact: {
        gap: theme.space.s16,
    },
    emptyNoticeSlot: {
        position: 'absolute',
    },
    noticeAboveHeading: {
        position: 'absolute',
        bottom: '100%',
        width: '100%',
        maxWidth: STEP_DOOR_WIDTH_PX,
        alignSelf: 'center',
        paddingBottom: theme.space.s12,
    },
    noticeTail: {
        width: '100%',
        maxWidth: STEP_DOOR_WIDTH_PX,
        marginTop: -theme.space.s24,
        paddingTop: theme.space.s12,
    },
    noticeTailCompact: {
        marginTop: -theme.space.s16,
    },
    noticeInColumn: {
        marginBottom: -theme.space.s12,
        paddingBottom: theme.space.s12,
    },
    noticeLines: {
        gap: theme.space.s12,
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
    retention: {
        width: '100%',
        paddingTop: theme.space.s16,
    },
}));
