import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/** One line of the disclosure's words; a host sizing its slot by lines counts in this. */
export const RELAY_RETENTION_LINE_PX = Typography.variant('body').lineHeight ?? 0;

/**
 * What the pre-sign-in disclosure can say about a Home's data retention: what it deletes, from a
 * policy that answered, or that it could not be checked (with a retry). It never falls silent on a
 * failed read, since silence would read as "nothing is deleted".
 */
export type RelayRetentionDisclosureModel =
    | Readonly<{ kind: 'summary'; summary: string }>
    | Readonly<{ kind: 'unreadable' }>;

export type RelayRetentionDisclosureState =
    | Extract<RelayRetentionDisclosureModel, { kind: 'summary' }>
    | Readonly<{ kind: 'unreadable'; retry: () => void }>;

export type RelayRetentionDisclosureProps = Readonly<{
    disclosure: RelayRetentionDisclosureModel & Readonly<{ retry?: () => void }>;
    testID?: string;
}>;

export const RelayRetentionDisclosure = React.memo(function RelayRetentionDisclosure(
    props: RelayRetentionDisclosureProps,
) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const testID = props.testID ?? 'relay-retention-disclosure';

    return (
        <View testID={testID} accessibilityRole="text" style={styles.row}>
            <Icon
                testID={`${testID}-icon`}
                name="clock-counter-clockwise"
                size={14}
                color={theme.colors.text.secondary}
                style={styles.icon}
            />
            {props.disclosure.kind === 'summary' ? (
                <Text style={styles.text}>{props.disclosure.summary}</Text>
            ) : (
                <Text style={styles.text}>
                    {t('server.retention.disclosureUnreadable')}
                    {' · '}
                    <Text
                        testID={`${testID}-retry`}
                        accessibilityRole="button"
                        accessibilityState={{ disabled: !props.disclosure.retry }}
                        onPress={props.disclosure.retry}
                        style={styles.retry}
                    >
                        {t('common.retry')}
                    </Text>
                </Text>
            )}
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    row: {
        width: '100%',
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s6,
    },
    text: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.text.secondary,
        ...Typography.variant('body'),
    },
    icon: {
        marginTop: theme.space.s2,
    },
    retry: {
        color: theme.colors.text.primary,
        textDecorationLine: 'underline',
    },
}));
