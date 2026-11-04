import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { TeamAuthEntrySelection } from './TeamAuthEntrySurface';
import { TeamEntryIdentity } from './TeamEntryIdentity';
import { UnauthenticatedRouteShell } from '@/components/onboarding/unauthShell';

/**
 * The sign-in step a person reaches by choosing a method on a Team entry page.
 * It stays in the same split shell and under the same Team identity as the
 * entry page and the joined card; only the method's own form changes.
 */
export function TeamAuthenticationStep(props: Readonly<{
    selection: TeamAuthEntrySelection;
    onBack: () => void;
    children: React.ReactNode;
}>) {
    const { selection } = props;
    return (
        <UnauthenticatedRouteShell
            testID="team-auth-step-shell"
            stepId={`team-auth-step:${selection.action.methodId}:${selection.action.action}`}
            onBack={props.onBack}
        >
            <View style={styles.content}>
                <TeamEntryIdentity
                    testIDPrefix="team-auth-step"
                    teamId={selection.teamId}
                    teamName={selection.teamName}
                    logo={selection.teamLogo ?? null}
                />
                {props.children}
            </View>
        </UnauthenticatedRouteShell>
    );
}

const styles = StyleSheet.create(() => ({
    content: {
        width: '100%',
        gap: 22,
    },
}));
