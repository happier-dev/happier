import * as React from 'react';
import { View } from 'react-native';

import { runStepMove } from '@/components/ui/motion/stepMotion/StepMotionStage';
import { FIRST_RUN_WORKFLOW_LAYER } from '@/components/ui/motion/stepMotion/StepMotionLayer';
import { useOptionalAuth } from '@/auth/context/AuthContext';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import type { IconName } from '@/components/ui/icons/Icon';
import { t } from '@/text';

import { UnauthenticatedRouteShell } from '../unauthShell/UnauthenticatedRouteShell';
import { UnauthenticatedStep } from '../unauthShell/UnauthenticatedStep';
import { StepQuietAction } from '../unauthShell/StepFormParts';
import { StepBackContext, StepPrimaryButton, useStepBackSlot } from '../unauthShell/stepBack';
import { WizardModalShell } from './WizardModalShell';

export type AuthRouteStepAction = Readonly<{
    label: string;
    onPress: () => void;
    disabled?: boolean;
    testID?: string;
    /** The primary's mark after its words: the forward arrow by default, another glyph, or `null` for none. */
    iconName?: IconName | null;
}>;

type RouteStepProps = Readonly<{
    testID: string;
    title: string;
    subtitle?: string;
    /** The subtitle's test id when it is the state's own sentence (signed out). */
    subtitleTestID?: string;
    /** One quiet line naming what the step acts on (the Home being recovered), above the heading. */
    context?: React.ReactNode;
    /** Omitted when the step has no way back (an OAuth return finishing its sign-in). */
    onBack?: () => void;
    /** An in-flight request that has crossed its authority boundary: no way out until it settles. */
    backDisabled?: boolean;
    /** The step's one action, when its body does not carry its own. */
    primary?: AuthRouteStepAction;
    /** A quiet second action (Cancel while a sign-in can still be stopped). */
    secondary?: AuthRouteStepAction;
    /** One line under the actions saying what they do. */
    footerHint?: React.ReactNode;
    /** The round mark over the heading naming what the step is about ({@link StepMark}). */
    mark?: React.ReactNode;
    children?: React.ReactNode;
}>;

/**
 * One standalone step in the welcome split's workflow pane: heading, purpose, body, then its
 * actions, with the shell's back chevron as the only way back. The signed-out standalone routes
 * and the Team invitation and sign-in routes (which keep the split in both auth states) compose
 * through this, so a terminal answer reads like every other step instead of a card or list.
 */
export function UnauthenticatedRouteStep(props: Omit<RouteStepProps, 'title'> & Readonly<{
    /** Omitted when the body titles itself (its heading changes with its own sub-views). */
    title?: string;
    /** The shell's testID when a route names it; defaults to `unauth-shell-<testID>`. */
    shellTestID?: string;
    /** The shell's step identity when it differs from the step's testID. */
    stepId?: string;
    /**
     * A link's terminal answer arriving after a check: announced as a status and drawn as a problem step (lower over
     * the planet, its mark over the heading, Back drawn as the "Back to Happier" pill).
     */
    status?: boolean;
    /** A status step's own way out ("Back to Happier" to the root); defaults to the shell's Back under that label. */
    leave?: Readonly<{ onPress: () => void; testID?: string }>;
}>) {
    // A lone quiet action (Cancel while a sign-in can still be stopped) stays quiet: it is a
    // text action on the column, never promoted to the step's filled primary.
    const actions = props.primary ? (
        <>
            <StepPrimaryButton
                testID={props.primary.testID}
                title={props.primary.label}
                onPress={props.primary.onPress}
                disabled={props.primary.disabled}
                iconName={props.primary.iconName}
            />
            {props.secondary ? (
                <StepQuietAction
                    testID={props.secondary.testID}
                    label={props.secondary.label}
                    onPress={props.secondary.onPress}
                    disabled={props.secondary.disabled}
                />
            ) : null}
        </>
    ) : props.secondary ? (
        <TextLinkButton
            testID={props.secondary.testID}
            label={props.secondary.label}
            onPress={props.secondary.onPress}
            disabled={props.secondary.disabled}
        />
    ) : null;
    const footer = actions || props.footerHint ? (
        <>
            {actions}
            {props.footerHint ?? null}
        </>
    ) : undefined;
    const step = (
        <UnauthenticatedStep
            testID={props.testID}
            title={props.title}
            subtitle={props.subtitle}
            subtitleTestID={props.subtitleTestID}
            context={props.context}
            mark={props.mark}
            // A dead end with nothing left to do here leaves through the pill; one with its own action keeps Back,
            // unless the step names its own exit.
            problem={props.status ? {
                leave: props.primary && !props.leave ? undefined : { label: t('teams.entry.returnToHappier'), ...props.leave },
            } : undefined}
            footer={footer}
        >
            {props.children}
        </UnauthenticatedStep>
    );
    return (
        <UnauthenticatedRouteShell
            testID={props.shellTestID ?? `unauth-shell-${props.testID}`}
            stepId={props.stepId ?? props.testID}
            onBack={props.backDisabled ? undefined : props.onBack}
        >
            {props.status ? (
                <View accessibilityRole="text" accessibilityLiveRegion="polite" aria-live="polite" role="status">
                    {step}
                </View>
            ) : step}
        </UnauthenticatedRouteShell>
    );
}

/**
 * The frame of a standalone sign-in or recovery route (`/restore`, `/restore/manual`,
 * `/restore/lost-access`, `/auth/password/recover`, the OAuth return). Signed out, the step is one
 * more step of the welcome split: its heading, body and actions sit in the workflow pane beside the
 * brand. Signed in (Settings, token repair and Account reach the same routes), it keeps the focused
 * wizard card it has always had.
 */
type AuthRouteStepFrameProps = RouteStepProps & Readonly<{
    /** Back from a standalone restore route to another first-run screen. */
    routeBack?: boolean;
    /** The signed-out frame's current step when the route hosts more than one. */
    stepId?: string;
    /** The signed-in card's step counter, when the route is a step of a longer setup. */
    progress?: Readonly<{ index: number; count: number }>;
    /** A terminal answer (a failed sign-in): announced, and drawn signed out as a problem step under its mark. */
    status?: boolean;
    /**
     * Signed out, the body titles itself (each of its ways has its own heading, as the welcome wizard's
     * `bodyOwnsHeading` steps do); the signed-in card keeps the route's title.
     */
    bodyOwnsHeading?: boolean;
    children: React.ReactNode;
}>;

export function AuthRouteStepFrame(props: AuthRouteStepFrameProps) {
    const signedIn = useOptionalAuth()?.isAuthenticated === true;
    // Credential publication can precede navigation. Keep the live outgoing step until that commit.
    const [enteredSignedOut] = React.useState(!signedIn);

    if (enteredSignedOut || !signedIn) {
        const back = props.onBack;
        const onBack = props.routeBack && back
            ? () => runStepMove({ layer: FIRST_RUN_WORKFLOW_LAYER, kind: 'back', commit: back })
            : back;
        return (
            <UnauthenticatedRouteStep
                testID={props.testID}
                stepId={props.stepId}
                title={props.bodyOwnsHeading ? undefined : props.title}
                subtitle={props.bodyOwnsHeading ? undefined : props.subtitle}
                subtitleTestID={props.subtitleTestID}
                context={props.context}
                onBack={onBack}
                backDisabled={props.backDisabled}
                primary={props.primary}
                secondary={props.secondary}
                footerHint={props.footerHint}
                mark={props.mark}
                status={props.status}
            >
                {props.children}
            </UnauthenticatedRouteStep>
        );
    }

    return <RoutineAuthRouteStepFrame {...props} />;
}

function RoutineAuthRouteStepFrame(props: AuthRouteStepFrameProps) {
    const { slot } = useStepBackSlot(props.backDisabled ? undefined : props.onBack, 'platform');
    return (
        <WizardModalShell
            testID={props.testID}
            titleLeading={props.mark}
            stepIndex={props.progress?.index ?? 0}
            stepCount={props.progress?.count ?? 1}
            showProgress={props.progress != null}
            title={props.title}
            subtitle={props.subtitle}
            headerHint={props.context}
            onBack={slot?.onBack ?? props.onBack}
            showBack={props.onBack != null}
            backDisabled={props.backDisabled}
            showSkip={false}
            onPrimary={props.primary?.onPress}
            primaryLabel={props.primary?.label}
            primaryDisabled={props.primary?.disabled}
            onSecondary={props.secondary?.onPress}
            secondaryLabel={props.secondary?.label}
            secondaryDisabled={props.secondary?.disabled}
            footerHint={props.footerHint}
        >
            <StepBackContext.Provider value={slot}>{props.children}</StepBackContext.Provider>
        </WizardModalShell>
    );
}
