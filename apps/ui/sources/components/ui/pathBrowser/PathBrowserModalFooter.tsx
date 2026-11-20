import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

const styles = StyleSheet.create((theme) => ({
    footer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space.s10,
    },
    selectionText: {
        flex: 1,
        // A path: the mono face at the meta step (the page header's path convention).
        ...Typography.mono(),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.secondary,
    },
}));

/** The folder chooser's footer: the chosen path at the start, then its buttons (Cancel · Use, or Cancel · Try again). */
export function PathBrowserModalFooter(props: Readonly<{ label: string | null; children: React.ReactNode }>) {
    return (
        <View style={styles.footer}>
            <Text numberOfLines={1} style={styles.selectionText}>{props.label ?? ''}</Text>
            {props.children}
        </View>
    );
}
