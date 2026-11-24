import * as React from 'react';
import { View, StyleSheet } from 'react-native';

import { E2eePasswordRecoveryScreen } from '@/components/account/auth/emailPassword/E2eePasswordRecoveryScreen';
import { FIRST_RUN_WORKFLOW_LAYER } from '@/components/ui/motion/stepMotion/StepMotionLayer';
import { runStepMove } from '@/components/ui/motion/stepMotion/StepMotionStage';

import { PreAuthOnboardingWizardEntry } from './PreAuthOnboardingWizardEntry';

export const PASSWORD_RECOVERY_ROUTE = '/auth/password/recover';

export const HostedSignedOutRouteContext = React.createContext<typeof PASSWORD_RECOVERY_ROUTE | '/' | null>(null);

/** A public, cold recovery can go back to Welcome without changing the workflow's shell. */
export function SignedOutRecoveryWorkflow(props: Readonly<{
    children: React.ReactNode;
    pathname: string;
    homeTarget: string | null;
    signedIn: boolean;
    navigation: Readonly<{ replace: (href: '/') => void }>;
}>) {
    const [enteredSignedOutRecovery, setEnteredSignedOutRecovery] = React.useState(false);
    const [returning, setReturning] = React.useState(false);
    const recoveryRoute = props.pathname === PASSWORD_RECOVERY_ROUTE;
    const recoveryHosted = recoveryRoute && (!props.signedIn || enteredSignedOutRecovery);
    const welcomeHosted = props.pathname === '/' && returning && !props.signedIn;

    React.useLayoutEffect(() => {
        if (recoveryRoute) {
            if (!props.signedIn) setEnteredSignedOutRecovery(true);
            setReturning(false);
        } else {
            setEnteredSignedOutRecovery(false);
            if (!welcomeHosted) setReturning(false);
        }
    }, [props.signedIn, recoveryRoute, welcomeHosted]);

    const navigation = props.navigation;
    const returnToWelcome = React.useCallback(() => runStepMove({
        layer: FIRST_RUN_WORKFLOW_LAYER,
        kind: 'back',
        toWelcome: true,
        commit: () => {
            setReturning(true);
            navigation.replace('/');
        },
    }), [navigation]);

    const hosted = recoveryHosted ? PASSWORD_RECOVERY_ROUTE : welcomeHosted ? '/' : null;
    return (
        <HostedSignedOutRouteContext.Provider value={hosted}>
            {props.children}
            {hosted !== null ? (
                <View style={StyleSheet.absoluteFill}>
                    <PreAuthOnboardingWizardEntry
                        recovery={hosted === PASSWORD_RECOVERY_ROUTE ? (
                            <E2eePasswordRecoveryScreen homeTarget={props.homeTarget} returnToWelcome={returnToWelcome} />
                        ) : undefined}
                        onRecoveryBack={returnToWelcome}
                    />
                </View>
            ) : null}
        </HostedSignedOutRouteContext.Provider>
    );
}
