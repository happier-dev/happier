import * as React from 'react';
import { View } from 'react-native';

import { useOptionalAuth } from '@/auth/context/AuthContext';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { FlowSurfaceActions, type FlowSurfaceAction } from '@/components/ui/flowSurface';

import { UnauthenticatedRouteShell } from '../unauthShell/UnauthenticatedRouteShell';
import { UnauthenticatedStep } from '../unauthShell/UnauthenticatedStep';
import { WizardModalShell } from './WizardModalShell';

export type AuthRouteStepAction = Readonly<{
    label: string;
    onPress: () => void;
    disabled?: boolean;
    testID?: string;
}>;

type RouteStepProps = Readonly<{
    testID: string;
    title: string;
    subtitle?: string;
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
    children?: React.ReactNode;
}>;

function toFlowAction(action: AuthRouteStepAction): FlowSurfaceAction {
    return { label: action.label, onPress: action.onPress, disabled: action.disabled, testID: action.testID };
}

/**
 * One standalone step in the welcome split's workflow pane: heading, purpose, body, then its
 * actions, with the shell's back chevron as the only way back. The signed-out standalone routes
 * and the Team invitation and sign-in routes (which keep the split in both auth states) compose
 * through this, so a terminal answer reads like every other step instead of a card or list.
 */
export function UnauthenticatedRouteStep(props: RouteStepProps & Readonly<{
    /** The shell's testID when a route names it; defaults to `unauth-shell-<testID>`. */
    shellTestID?: string;
    /** The shell's step identity when it differs from the step's testID. */
    stepId?: string;
    /** Announce the step as a status (a link's terminal answer arriving after a check). */
    status?: boolean;
}>) {
    // A lone quiet action (Cancel while a sign-in can still be stopped) stays quiet: it is a
    // text action on the column, never promoted to the step's filled primary.
    const actions = props.primary ? (
        <FlowSurfaceActions
            placement="column"
            primary={toFlowAction(props.primary)}
            secondary={props.secondary ? toFlowAction(props.secondary) : undefined}
        />
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
        <UnauthenticatedStep testID={props.testID} title={props.title} subtitle={props.subtitle} context={props.context} footer={footer}>
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
export function AuthRouteStepFrame(props: RouteStepProps & Readonly<{
    /** The signed-in card's step counter, when the route is a step of a longer setup. */
    progress?: Readonly<{ index: number; count: number }>;
    children: React.ReactNode;
}>) {
    const signedIn = useOptionalAuth()?.isAuthenticated === true;

    if (!signedIn) {
        return (
            <UnauthenticatedRouteStep
                testID={props.testID}
                title={props.title}
                subtitle={props.subtitle}
                context={props.context}
                onBack={props.onBack}
                backDisabled={props.backDisabled}
                primary={props.primary}
                secondary={props.secondary}
                footerHint={props.footerHint}
            >
                {props.children}
            </UnauthenticatedRouteStep>
        );
    }

    return (
        <WizardModalShell
            testID={props.testID}
            stepIndex={props.progress?.index ?? 0}
            stepCount={props.progress?.count ?? 1}
            showProgress={props.progress != null}
            title={props.title}
            subtitle={props.subtitle}
            headerHint={props.context}
            onBack={props.onBack}
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
            {props.children}
        </WizardModalShell>
    );
}
