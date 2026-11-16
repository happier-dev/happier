import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ExactHomeDestinationNotice } from '@/components/account/auth/ExactHomeDestinationNotice';
import { useExactHomeArrival } from '@/components/account/auth/useExactHomeDestination';

import { EmailPasswordAuthPanel, type EmailPasswordAuthOutcome, type EmailPasswordAuthPanelProps } from './EmailPasswordAuthPanel';

export type EmailPasswordAuthStepRequest = Omit<EmailPasswordAuthPanelProps, 'onBack'> & Readonly<{
    /**
     * Activation of the exact Home this step just authenticated against, when
     * the host has one. Returning `false` means the device did not get there, and
     * this step is the only surface still mounted — so it keeps the shared
     * blocked state and its focus-only retry instead of leaving a completed
     * login whose destination never opened.
     */
    reachExactHome?: () => Promise<boolean>;
}>;

export type EmailPasswordAuthStepProps = EmailPasswordAuthStepRequest & Readonly<{
    /** Leaves the step: Back, a completed login, or the recovery-key escape. */
    onClose: () => void;
}>;

/**
 * The shared native email/password controller as one signed-out step. Welcome
 * hosts it in its workflow pane like every other sign-in step; the controller,
 * its clients and its recovery states are the same ones the shared auth-entry
 * surface embeds — only the host differs.
 */
export const EmailPasswordAuthStep = React.memo(function EmailPasswordAuthStep(props: EmailPasswordAuthStepProps) {
    const { onClose, onAuthenticated, reachExactHome, ...panelProps } = props;
    const arrival = useExactHomeArrival();
    // Leaving belongs to the arrival itself so the retry path settles the same
    // way the first attempt does; nothing here re-runs the login.
    const reach = React.useCallback(async (): Promise<boolean> => {
        const reached = await reachExactHome!();
        if (reached) onClose();
        return reached;
    }, [onClose, reachExactHome]);

    if (arrival.state.kind !== 'idle') {
        return (
            <View style={styles.arrival}>
                <ExactHomeDestinationNotice
                    testID="email-password-modal-destination-home"
                    state={arrival.state}
                />
            </View>
        );
    }

    return (
        <EmailPasswordAuthPanel
            {...panelProps}
            presentation="step"
            onAuthenticated={async (outcome) => {
                const completion = await onAuthenticated(outcome);
                if (completion === 'retired') return;
                if (!reachExactHome) {
                    onClose();
                    return;
                }
                await arrival.continueThrough(reach);
            }}
            onBack={onClose}
        />
    );
});

const styles = StyleSheet.create((theme) => ({
    arrival: { gap: theme.space.s12, width: '100%' },
}));

export type { EmailPasswordAuthOutcome };
