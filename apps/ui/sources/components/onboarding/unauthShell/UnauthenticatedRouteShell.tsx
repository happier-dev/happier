import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { UnauthenticatedSplitShell } from './UnauthenticatedSplitShell';

const NOOP = () => {};

/**
 * The shell of every signed-out route that is one step rather than the welcome wizard itself: Team
 * invitation and sign-in, standalone recovery (key, lost access, restore, show QR) and terminal
 * sign-in. Each sits in the welcome split's workflow pane at the top, under the compact mark on a
 * phone, so moving between them changes what sits there and never where it starts; a state card
 * does not drift to the middle of the pane.
 */
export function UnauthenticatedRouteShell(props: Readonly<{
    testID: string;
    /** Identifies the step; a change fades one step into the next. */
    stepId: string;
    onBack?: () => void;
    children: React.ReactNode;
}>) {
    return (
        <UnauthenticatedSplitShell
            testID={props.testID}
            stepId={props.stepId}
            isWelcomeStep={false}
            showMobileWordmark
            allowMobileBrandHero={false}
            onOpenRelayCustomFlow={NOOP}
            onBrandHeroGetStarted={NOOP}
            onBack={props.onBack}
        >
            {/* Natural height: a state's own centering has nothing to centre in, so it sits at the top. */}
            <View style={styles.top}>{props.children}</View>
        </UnauthenticatedSplitShell>
    );
}

const styles = StyleSheet.create(() => ({
    top: {
        width: '100%',
    },
}));
