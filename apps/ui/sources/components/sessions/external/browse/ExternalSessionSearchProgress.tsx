import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { MeterBar } from '@/components/ui/lists/MeterBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/** The browser and palette share one top-edge progress band and one Stop. */
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
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" {...({ 'aria-hidden': true } as Record<string, unknown>)}>
            <MeterBar tone="neutral" fillFraction={fraction ?? 0} height={2} fillColor={theme.colors.text.secondary} trackColor={theme.colors.border.default} />
        </View>
        <View style={styles.status}>
            <View testID={props.testID} style={styles.region} accessibilityRole="progressbar" accessibilityLabel={props.label}
                accessibilityValue={props.total === undefined ? undefined : { min: 0, max: props.total, now: props.scanned ?? 0 }}
                {...({ role: 'progressbar' } as Record<string, unknown>)}>
                {props.total === undefined ? <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" {...({ 'aria-hidden': true } as Record<string, unknown>)}><ActivitySpinner size="small" color={theme.colors.text.secondary} /></View> : null}
                <Text style={[styles.label, Typography.tabular()]} numberOfLines={1}>{props.label}</Text>
            </View>
            {props.onStop ? <RoundButton testID={props.stopTestID} size="small" display="inverted" title={t('externalSessions.browseIndexingStop')} onPress={props.onStop} /> : null}
        </View>
    </View>;
}

const styles = StyleSheet.create(theme => ({
    status: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 6 },
    region: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
    label: { ...Typography.rowMeta(), color: theme.colors.text.secondary, flexShrink: 1 },
}));
