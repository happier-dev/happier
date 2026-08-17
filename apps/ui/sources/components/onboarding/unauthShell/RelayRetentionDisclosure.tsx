import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

export type RelayRetentionDisclosureProps = Readonly<{
    summary: string;
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
            <Text style={styles.text}>{props.summary}</Text>
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    row: {
        width: '100%',
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 7,
    },
    text: {
        ...Typography.default(),
        flex: 1,
        minWidth: 0,
        color: theme.colors.text.secondary,
        fontSize: 13,
        lineHeight: 18,
    },
    icon: {
        marginTop: 2,
    },
}));
