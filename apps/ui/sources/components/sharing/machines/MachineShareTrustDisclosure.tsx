import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * D24 at the point of choice (lab `m-share`): the operating-system trust fact, said once at the head
 * of the machine's share sheet, with a key glyph so it reads as the one thing to know before adding
 * someone. Further facts (what Manage adds, a plain machine's readability) follow as quieter lines.
 */
export function MachineShareTrustDisclosure(props: Readonly<{
    disclosure: string;
    notes: readonly string[];
    idPrefix: string;
}>) {
    const { theme } = useUnistyles();
    return (
        <View style={styles.row} accessibilityRole="text">
            <View style={styles.glyph}>
                <Icon name="key" size={16} color={theme.colors.text.secondary} />
            </View>
            <View style={styles.text}>
                <Text testID={`${props.idPrefix}machine-share-trusted-os`} style={styles.disclosure}>{props.disclosure}</Text>
                {props.notes.map((note, index) => (
                    <Text key={index} testID={index === 0 ? `${props.idPrefix}machine-share-manage-consequence` : undefined} style={styles.note}>
                        {note}
                    </Text>
                ))}
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
        paddingVertical: 2,
    },
    glyph: {
        paddingTop: 1,
    },
    text: {
        flex: 1,
        minWidth: 0,
        gap: 6,
    },
    disclosure: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.primary,
    },
    note: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.secondary,
    },
}));
