import { HAPPIER_BALANCED_TEXT_WRAP, HappierBodyEdgeContext } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { StepTransitionFrame } from '@/components/ui/motion/StepTransitionFrame';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { WELCOME_ACTION_TEXT_INSET, WelcomeActionCard } from './WelcomeActionCard';
import { WelcomeActionList, type WelcomeActionAdmission } from './WelcomeActionList';
import type { WelcomeEntryViewModel } from './welcomeEntryViewModel';

export type { WelcomeEntryViewModel } from './welcomeEntryViewModel';

export type WelcomeEntryViewInteraction = Readonly<{
    admission: WelcomeActionAdmission;
    onAction: (index: number) => Promise<void> | void;
    onRetry: (testID: string) => void;
    onSelfHosting: () => void;
    policyNotice?: React.ReactNode;
}>;

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
    const renderAction = ({ index, display }: WelcomeEntryViewModel['doors'][number]) => (
        <WelcomeActionCard key={index} {...display} actionId={`welcome-action-${index}`}
            disabled={!interaction} onPress={interaction ? () => interaction.onAction(index) : noAction} />
    );
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
                    {model.heading.title}
                </Text>
                <Text accessibilityRole="header" style={[styles.subtitleTitle, compact ? styles.headlineCompact : null]}>
                    {model.heading.subtitle}
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
                        {model.quietWays.length > 0 ? (
                            <View testID="welcome-quiet-ways" style={styles.quietWays}>
                                {model.quietWaysTitle ? (
                                    <Text accessibilityRole="header" style={styles.quietWaysTitle}>{model.quietWaysTitle}</Text>
                                ) : null}
                                {model.quietWays.map(renderAction)}
                            </View>
                        ) : null}
                    </View>
                    {model.selfHosting ? (
                        <View style={styles.selfHosting}>
                            <Text style={styles.selfHostingLabel}>{model.selfHosting.label}</Text>
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
    root: {
        flex: 1,
        justifyContent: 'center',
        width: '100%',
        maxWidth: 520,
        alignSelf: 'center',
        gap: theme.space.s24,
    },
    rootCompact: {
        gap: theme.space.s16,
    },
    headingBlock: {
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
        color: theme.colors.text.primary,
        // Two short lines split evenly: no word alone on the last line (web; native has no balance).
        ...HAPPIER_BALANCED_TEXT_WRAP,
    },
    subtitleTitle: {
        ...Typography.default('semiBold'),
        fontSize: 44,
        lineHeight: 44,
        letterSpacing: -1.54,
        color: theme.colors.text.secondary,
        ...HAPPIER_BALANCED_TEXT_WRAP,
    },
    actionStack: {
        gap: theme.space.s12,
        width: '100%',
    },
    ways: {
        width: '100%',
    },
    doors: {
        gap: theme.space.s12,
        width: '100%',
    },
    // The cards' own text edge, so the quiet ways line up under the doors.
    quietWays: {
        marginTop: theme.space.s8,
        gap: theme.space.s2,
    },
    intro: {
        ...Typography.variant('reading'),
        color: theme.colors.text.secondary,
        marginTop: theme.space.s16,
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
        paddingHorizontal: WELCOME_ACTION_TEXT_INSET,
        marginTop: theme.space.s8,
    },
    selfHostingLabel: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    quietWaysTitle: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
        paddingHorizontal: WELCOME_ACTION_TEXT_INSET,
        paddingBottom: theme.space.s4,
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
