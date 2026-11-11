import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { MeterBar } from '@/components/ui/lists/MeterBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/**
 * The browser and palette share one progress status line and one Stop. A known total adds a 2px fill
 * along the line's bottom edge, over the region's own separator: the fill never draws a track of its own,
 * so the status line never adds a second border. Without a total the spinner carries the activity.
 */
export function ExternalSessionSearchProgress(props: Readonly<{
    label: string;
    scanned?: number;
    total?: number;
    onStop?: () => void;
    testID?: string;
    stopTestID?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const fraction = props.total !== undefined && props.total > 0 && props.scanned !== undefined
        ? Math.max(0, Math.min(1, props.scanned / props.total)) : null;
    return <View style={{ width: '100%' }}>
        <View style={styles.status}>
            <View testID={props.testID} style={styles.region} accessibilityRole="progressbar" accessibilityLabel={props.label}
                accessibilityValue={props.total === undefined ? undefined : { min: 0, max: props.total, now: props.scanned ?? 0 }}
                {...({ role: 'progressbar' } as Record<string, unknown>)}>
                {props.total === undefined ? <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" {...({ 'aria-hidden': true } as Record<string, unknown>)}><ActivitySpinner size="small" color={theme.colors.text.secondary} /></View> : null}
                <Text style={[styles.label, Typography.tabular()]} numberOfLines={1}>{props.label}</Text>
            </View>
            {/* Stop ends the status line as words (lab ST "1,184 of 3,102 · Stop"), not as a second pill. */}
            {props.onStop ? <TextLinkButton testID={props.stopTestID} size="meta" tone="strong" label={t('externalSessions.browseIndexingStop')} onPress={props.onStop} /> : null}
        </View>
        {fraction === null ? null : (
            <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" {...({ 'aria-hidden': true } as Record<string, unknown>)}>
                <MeterBar tone="neutral" fillFraction={fraction} height={2} fillColor={theme.colors.text.secondary} trackColor="transparent" />
            </View>
        )}
    </View>;
}

const styles = StyleSheet.create(theme => ({
    status: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s12, paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s6 },
    region: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
    label: { ...Typography.variant('meta'), color: theme.colors.text.secondary, flexShrink: 1 },
}));
