import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Avatar } from '@/components/ui/avatar/Avatar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

export const TEAM_ENTRY_LOGO_SIZE = 52;

export type TeamEntryLogo = Readonly<{ url?: string | null; thumbhash?: string | null }> | null;

/**
 * The Team's identity at the top of every Team entry step: its logo, then
 * "Continue to <Team>", which names the Team once. The entry page and the chosen
 * sign-in step render this one header, so moving between them only swaps what
 * sits beneath it.
 */
export function TeamEntryIdentity(props: Readonly<{
    testIDPrefix: string;
    teamId: string;
    teamName: string;
    logo: TeamEntryLogo;
    /** Context lines under the heading (Home, Account, sign-in service). */
    children?: React.ReactNode;
}>) {
    const { testIDPrefix, teamName } = props;
    const heading = t('teams.entry.heading', { team: teamName });
    return (
        <>
            <View testID={`${testIDPrefix}-lockup`} style={styles.lockup}>
                <View
                    testID={`${testIDPrefix}-logo`}
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                >
                    <Avatar
                        id={props.teamId}
                        square
                        size={TEAM_ENTRY_LOGO_SIZE}
                        imageUrl={props.logo?.url ?? null}
                        thumbhash={props.logo?.thumbhash ?? null}
                        monogram={teamName}
                    />
                </View>
            </View>
            <View>
                <Text
                    testID={`${testIDPrefix}-heading`}
                    accessibilityRole="header"
                    accessibilityLabel={heading}
                    numberOfLines={2}
                    role="heading"
                    style={styles.heading}
                >
                    {heading}
                </Text>
                {props.children}
            </View>
        </>
    );
}

const styles = StyleSheet.create((theme) => ({
    lockup: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        minWidth: 0,
    },
    heading: {
        ...Typography.variant('display'),
        color: theme.colors.text.primary,
    },
}));
