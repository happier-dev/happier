import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/**
 * The two ways a roster can be empty, which are not the same thing.
 *
 * A session that has never run an agent is a person who does not yet know what this pane is for;
 * that is worth a sentence and a way in. A session whose agents have simply finished is a person
 * who already knows; repeating the introduction every time work goes quiet turns warmth into
 * chatter. Same absence of rows, two different messages.
 *
 * "We cannot reach the machine" is a third thing and is deliberately not handled here — the list
 * keeps the last known roster and says it is offline rather than claiming there is nothing.
 */

export type AgentActivityEmptyStateVariant = 'firstUse' | 'idle';

export type AgentActivityEmptyStateProps = Readonly<{
    variant: AgentActivityEmptyStateVariant;
    /** The way in. Omitted when the host has no launcher, and then no affordance is offered. */
    onLaunch?: () => void;
    testID?: string;
}>;

export function AgentActivityEmptyState(props: AgentActivityEmptyStateProps): React.ReactElement {
    const { theme } = useUnistyles();

    if (props.variant === 'idle') {
        return (
            <View testID={props.testID} style={styles.idleContainer}>
                <Text style={styles.idleText}>{t('session.agentActivity.empty.idle')}</Text>
            </View>
        );
    }

    return (
        <EmptyState
            testID={props.testID}
            titleTestID={props.testID ? `${props.testID}:title` : undefined}
            icon={<Icon name="robot" size={29} color={theme.colors.text.secondary} />}
            title={t('session.agentActivity.empty.firstUseTitle')}
            subtitle={t('session.agentActivity.empty.firstUseSubtitle')}
            action={props.onLaunch ? (
                <RoundButton
                    testID={props.testID ? `${props.testID}:launch` : undefined}
                    size="normal"
                    title={t('session.agentActivity.empty.firstUseAction')}
                    onPress={props.onLaunch}
                />
            ) : undefined}
        />
    );
}

const styles = StyleSheet.create((theme) => ({
    idleContainer: {
        paddingHorizontal: 16,
        paddingVertical: 16,
    },
    idleText: {
        ...Typography.default(),
        fontSize: 13,
        // Secondary, never tertiary: this line is the only content on screen, so it carries the
        // whole meaning of the pane at that moment.
        color: theme.colors.text.secondary,
    },
}));
