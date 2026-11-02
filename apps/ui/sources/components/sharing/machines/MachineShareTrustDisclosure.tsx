import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * D24 at the point of choice (lab `m-share`): the operating-system trust fact, said once at the head
 * of the machine's share sheet as one line. Why it holds, what Manage adds and a plain machine's
 * readability sit behind the sheet's one Details disclosure (the adapter's level help and notes).
 */
export function MachineShareTrustDisclosure(props: Readonly<{ lead: string; idPrefix: string;
    /** What the owner can do about it, in the lead's own column (the Linux separate-users offer). */
    children?: React.ReactNode }>) {
    const { theme } = useUnistyles();
    return <View style={styles.line} testID={`${props.idPrefix}machine-share-trusted-os`} accessibilityRole="text">
        <View style={styles.glyph}>
            <Icon name="key" size={16} color={theme.colors.text.secondary} />
        </View>
        <View style={styles.column}>
            <Text style={styles.lead}>{props.lead}</Text>
            {props.children}
        </View>
    </View>;
}

const styles = StyleSheet.create((theme) => ({
    line: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s10,
        paddingVertical: theme.space.s8,
    },
    glyph: {
        paddingTop: 1,
    },
    column: {
        flex: 1,
        minWidth: 0,
        gap: theme.space.s6,
    },
    lead: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.primary,
    },
}));
