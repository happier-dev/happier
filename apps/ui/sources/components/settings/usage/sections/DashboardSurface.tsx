import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { InstrumentCard } from '@/components/instrument';
import { EntranceView } from './EntranceView';

/**
 * The usage dashboard is ONE continuous card-like surface (DASHBOARD-VISION
 * "global rules"): hairline-separated bands on a single `InstrumentCard`, not
 * stacked floating cards. `DashboardSurface` is the outer surface; `Band` is one
 * section within it — header INSIDE the surface (15px semibold title-case + an
 * optional 13px secondary subtitle, never an ALL-CAPS eyebrow), 20px padding, a
 * full-bleed hairline divider above every band after the first, and a staggered
 * fade+rise entrance (once per session) via `EntranceView`.
 */

export type DashboardSurfaceProps = Readonly<{
    children: React.ReactNode;
    testID?: string;
}>;

export function DashboardSurface(props: DashboardSurfaceProps): React.ReactElement {
    return (
        <View style={styles.outer}>
            <InstrumentCard testID={props.testID}>
                {props.children}
            </InstrumentCard>
        </View>
    );
}

export type BandProps = Readonly<{
    entranceId: string;
    index: number;
    title?: string;
    subtitle?: string;
    /** Suppresses the top divider — pass on the first band only. */
    first?: boolean;
    headerAccessory?: React.ReactNode;
    contentStyle?: StyleProp<ViewStyle>;
    testID?: string;
    children: React.ReactNode;
}>;

export function Band(props: BandProps): React.ReactElement {
    const hasHeader = Boolean(props.title || props.subtitle || props.headerAccessory);
    return (
        <View testID={props.testID}>
            {props.first ? null : <View style={styles.divider} />}
            <EntranceView entranceId={props.entranceId} index={props.index} style={styles.band}>
                {hasHeader ? (
                    <View style={styles.header}>
                        <View style={styles.headerText}>
                            {props.title ? (
                                <Text style={styles.title} numberOfLines={1}>{props.title}</Text>
                            ) : null}
                            {props.subtitle ? (
                                <Text style={styles.subtitle} numberOfLines={2}>{props.subtitle}</Text>
                            ) : null}
                        </View>
                        {props.headerAccessory}
                    </View>
                ) : null}
                <View style={props.contentStyle}>{props.children}</View>
            </EntranceView>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    outer: {
        paddingHorizontal: 16,
    },
    divider: {
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.border.default,
        opacity: 0.5,
    },
    band: {
        paddingHorizontal: 20,
        paddingVertical: 20,
        gap: 16,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 12,
    },
    headerText: {
        flex: 1,
        gap: 2,
        minWidth: 0,
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 15,
        lineHeight: 20,
        letterSpacing: -0.2,
        color: theme.colors.text.primary,
    },
    subtitle: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.secondary,
    },
}));
