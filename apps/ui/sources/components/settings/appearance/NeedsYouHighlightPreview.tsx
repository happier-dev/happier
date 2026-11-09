import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_COLLECTION_ROW_METRICS } from '@happier-dev/plugin-ui/presentation';

import { CollectionRowNeedsYouLayer } from '@/components/ui/lists/collection/CollectionRowNeedsYouHighlight';
import type { HappierNeedsYouHighlightPreference } from '@happier-dev/plugin-ui/presentation';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { workStatusGlyphColor } from '@/components/work/status/workStatusTreatment';
import { resolveAttentionStateColors } from '@/components/ui/status/StatusPill';

const styles = StyleSheet.create((theme) => ({
    frame: { flex: 1, justifyContent: 'center', gap: 4, paddingHorizontal: 6 },
    row: {
        height: 22,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 6,
        borderRadius: HAPPIER_COLLECTION_ROW_METRICS.radius,
    },
    title: { flex: 1, height: 6, borderRadius: 3, backgroundColor: theme.colors.text.primary, opacity: 0.55 },
    quietTitle: { flex: 1, height: 6, borderRadius: 3, backgroundColor: theme.colors.text.tertiary, opacity: 0.45 },
    age: { width: 12, height: 5, borderRadius: 2.5, backgroundColor: theme.colors.text.tertiary, opacity: 0.45 },
}));

/**
 * The real needs-you treatment for one highlight choice (Appearance → Sessions tiles): a calm row, the row that
 * needs you with the chosen layer, and a calm row. Motion choices are drawn still, mid-sweep or mid-breath.
 */
export const NeedsYouHighlightPreview = React.memo(function NeedsYouHighlightPreview(props: Readonly<{ highlight: HappierNeedsYouHighlightPreference }>) {
    const { theme } = useUnistyles();
    const leading = props.highlight === 'dot' || props.highlight === 'pulse' ? null : props.highlight;
    const amber = workStatusGlyphColor(theme.colors, 'attention');
    return (
        <View style={styles.frame}>
            <View style={styles.row}><View style={styles.quietTitle} /><View style={styles.age} /></View>
            <View style={styles.row}>
                <CollectionRowNeedsYouLayer leading={leading} still />
                <View style={styles.title} />
                <StatusDot color={amber} size={7}
                    halo={props.highlight === 'pulse' ? resolveAttentionStateColors(theme.colors.state).background : undefined} />
            </View>
            <View style={styles.row}><View style={styles.quietTitle} /><View style={styles.age} /></View>
        </View>
    );
});

/** The working row in one indicator style (Appearance → Sessions tiles), drawn still: the spinner, or the pulsing dot. */
export const WorkingIndicatorPreview = React.memo(function WorkingIndicatorPreview(props: Readonly<{ style: 'spinner' | 'pulse' }>) {
    const { theme } = useUnistyles();
    const ink = workStatusGlyphColor(theme.colors, 'neutral');
    return (
        <View style={styles.frame}>
            <View style={styles.row}><View style={styles.quietTitle} /><View style={styles.age} /></View>
            <View style={styles.row}>
                <View style={styles.title} />
                {props.style === 'pulse'
                    ? <StatusDot color={ink} size={6} />
                    : <ActivitySpinner size={12} color={ink} animationEnabled={false} />}
            </View>
            <View style={styles.row}><View style={styles.quietTitle} /><View style={styles.age} /></View>
        </View>
    );
});
