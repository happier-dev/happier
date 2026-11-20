import { HAPPIER_BALANCED_TEXT_WRAP, HappierBodyEdgeContext } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { StepTransitionFrame } from '@/components/ui/motion/StepTransitionFrame';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { StepOrDivider } from '@/components/onboarding/unauthShell/StepFormParts';
import { RelayRetentionDisclosure, type RelayRetentionDisclosureState } from '@/components/onboarding/unauthShell/RelayRetentionDisclosure';
import { useShellCornerDoor } from '@/components/onboarding/unauthShell/shellCorner';
import { t } from '@/text';

import { WelcomeActionCard, WelcomeWayButton } from './WelcomeActionCard';
import { WelcomeActionList, type WelcomeActionAdmission } from './WelcomeActionList';
import type { WelcomeEntryViewModel } from './welcomeEntryViewModel';

export type { WelcomeEntryViewModel } from './welcomeEntryViewModel';

export type WelcomeEntryViewInteraction = Readonly<{
    admission: WelcomeActionAdmission;
    getActionId: (index: number) => string | undefined;
    onAction: (index: number) => Promise<void> | void;
    onRetry: (testID: string) => void;
    onSelfHosting: () => void;
    policyNotice?: React.ReactNode;
    /** Marks the host puts first on the ways row (Approve: Back on a computer, then the recovery key). */
    waysLeading?: React.ReactNode;
    /** The Home's retention summary, under the trust line; it fades in later and never moves the doors. */
    retention?: RelayRetentionDisclosureState | null;
}>;

/** The doors' column (lab direction A: 380 px), narrower than the headline above it. */
const WELCOME_DOOR_WIDTH_PX = 380;
/** The subline wraps to two short balanced lines under the headline. */
const WELCOME_INTRO_WIDTH_PX = 300;

const noAction = () => {};
const inertAdmission: WelcomeActionAdmission = { pendingActionId: null, run: async () => {} };

/** The live Welcome and the opening replica share this presentation. */
export const WelcomeEntryView = React.memo(function WelcomeEntryView({
    model, compact, interaction,
}: Readonly<{
    model: WelcomeEntryViewModel;
    compact: boolean;
    interaction?: WelcomeEntryViewInteraction;
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
    const waysLeading = interaction?.waysLeading;
    // A computer's shell takes the self-hosting door to its top-right corner; a phone keeps it under the column.
    const selfHostingInCorner = useShellCornerDoor(interaction && model.selfHosting ? {
        testID: model.selfHosting.display.testID, label: model.selfHosting.display.title, onPress: interaction.onSelfHosting,
    } : null);
    const hasWays = model.quietWays.length > 0 || waysLeading != null;
    const renderNotice = (notice: WelcomeEntryViewModel['notices'][number]) => (
        <WelcomeNotice key={notice.slot} notice={notice} onRetry={interaction?.onRetry} />
    );
    return (
        <View testID="welcome-decision-panel" style={[styles.root, compact ? styles.rootCompact : null]}
            pointerEvents={interaction ? 'auto' : 'none'} accessibilityElementsHidden={!interaction}
            aria-hidden={!interaction}
            importantForAccessibility={interaction ? 'auto' : 'no-hide-descendants'}>
            {model.heading ? <View style={styles.headingBlock}>
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
            {interaction?.policyNotice}
            {model.signupNotice ? (
                <Text testID="welcome-signup-disabled" style={[styles.statusText, styles.signupDisabledNotice]}>
                    {model.signupNotice}
                </Text>
            ) : null}
            <WelcomeActionList admission={interaction?.admission ?? inertAdmission}>
                <View style={styles.actionStack}>
                    {model.notices.map(renderNotice)}
                    <View style={styles.ways}>
                        <View style={styles.doors}>{model.doors.map(renderAction)}</View>
                        {hasWays ? (
                            // The ways row (owner 2026-11-19): a centred "or", then round marks without captions.
                            <View testID="welcome-quiet-ways" style={styles.quietWays}>
                                <StepOrDivider label={t('common.or')} />
                                <View role="group" aria-label={model.quietWaysTitle} style={styles.waysRow}>
                                    {waysLeading}
                                    {model.quietWays.map(renderWay)}
                                </View>
                            </View>
                        ) : null}
                    </View>
                    {model.trust ? (
                        <View style={styles.trust}>
                            <Text testID="welcome-trust" style={styles.trustText}>{model.trust}</Text>
                            {interaction ? (
                                <View style={styles.retention}>
                                    {interaction.retention ? (
                                        <RelayRetentionDisclosure testID="welcome-retention" disclosure={interaction.retention} />
                                    ) : null}
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
                    {model.closingNotice ? renderNotice(model.closingNotice) : null}
                </View>
            </WelcomeActionList>
        </View>
    );
});

function WelcomeNotice({ notice, onRetry }: Readonly<{
    notice: WelcomeEntryViewModel['notices'][number];
    onRetry?: (testID: string) => void;
}>) {
    const { retry } = notice;
    return (
        <HappierBodyEdgeContext.Provider value>
            <StepTransitionFrame transitionKey={notice.testID} direction="replace" notice>
                <SurfaceStateCard
                    testID={notice.testID}
                    size="line"
                    lineLayout="notice"
                    kind={notice.kind}
                    title={notice.title}
                    reason={notice.reason}
                    accessibilitySemantics="status"
                    actionGlyph="retry"
                    action={retry ? { ...retry, disabled: !onRetry, onPress: onRetry ? () => onRetry(retry.testID) : noAction } : undefined}
                />
            </StepTransitionFrame>
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
    headingBlock: {
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
        maxWidth: WELCOME_DOOR_WIDTH_PX,
        alignSelf: 'center',
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
    statusText: {
        ...Typography.default(),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text.secondary,
    },
    signupDisabledNotice: {
        textAlign: 'center',
        maxWidth: 440,
        alignSelf: 'center',
    },
}));
