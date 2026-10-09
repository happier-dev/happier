import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/** The quiet tabular count after a section title ("On it now 2", "Made from this preset 2"). */
export function ManagedSectionCount(props: Readonly<{ count: number }>) {
    return <Text style={styles.count}>{String(props.count)}</Text>;
}

const styles = StyleSheet.create((theme) => ({
    count: {
        ...Typography.default(),
        ...Typography.tabular(),
        ...happierPageTextMetrics('sectionTitle'),
        color: theme.colors.text.tertiary,
    },
}));
