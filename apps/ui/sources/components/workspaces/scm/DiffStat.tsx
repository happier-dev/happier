import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * Lines added and removed as one tabular readout ("+53 −5"), in the version-control inks. A side
 * with nothing to say is left out; with neither, nothing is drawn.
 */
export const DiffStat = React.memo(function DiffStat(props: Readonly<{
    testID?: string;
    added: number;
    removed: number;
}>) {
    if (props.added <= 0 && props.removed <= 0) return null;
    return (
        <Text testID={props.testID} numberOfLines={1} style={styles.stat}>
            {props.added > 0 ? <Text style={[styles.stat, styles.added]}>{`+${props.added.toLocaleString()}`}</Text> : null}
            {props.added > 0 && props.removed > 0 ? ' ' : null}
            {props.removed > 0 ? <Text style={[styles.stat, styles.removed]}>{`−${props.removed.toLocaleString()}`}</Text> : null}
        </Text>
    );
});

const styles = StyleSheet.create((theme) => ({
    stat: {
        ...Typography.rowMeta(),
        ...Typography.tabular(),
        flexShrink: 0,
    },
    added: {
        color: theme.colors.versionControl.added.foreground,
    },
    removed: {
        color: theme.colors.versionControl.removed.foreground,
    },
}));
