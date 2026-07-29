import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { CapacityRing } from '@/components/ui/progress/CapacityRing';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { resolveQuotaToneColor } from '@/sync/domains/connectedServices/resolveQuotaToneColor';

import type { CapacityRingDatum } from './account/accountBlockModel';

/**
 * Capacity gauge for connected-service rows (account + pool) INSIDE a single
 * service detail. Renders one concentric ring per usage limit (most-constrained
 * outermost) with the overall capacity % in the center. ONE gauge so account rows
 * and pool rows never drift.
 *
 * It deliberately carries NO brand glyph or status dot: every row inside a given
 * service detail is the same provider, so the logo would be noise — the brand is
 * only shown on the top-level connected-services (service-type) list. Health reads
 * from the ring colors (resolved here from each limit's tone).
 */
export type ConnectedServiceCapacityAvatarProps = Readonly<{
    /** Concentric capacity rings (one per limit), OUTERMOST first. Empty → faint track. */
    rings: ReadonlyArray<CapacityRingDatum>;
    /** Center number (overall/most-constrained capacity %), or null to hide it. */
    centerLabel?: string | null;
    /**
     * True while the underlying snapshot is still loading. Renders a centered
     * spinner over faint tracks and suppresses `centerLabel`, so a slow load reads
     * as "loading" rather than an empty "no usage" gauge. Distinct from a resolved
     * empty gauge (loading false) and from an error (surfaced by the caller).
     */
    loading?: boolean;
    size?: number;
    testID?: string;
    accessibilityLabel?: string;
}>;

/** Default gauge diameter (px). */
export const CONNECTED_SERVICE_GAUGE_SIZE = 42;
/**
 * The `Item` `iconBoxSize` to allocate for the gauge: a touch larger than the
 * gauge so the fixed icon slot fits it without clipping its left edge and leaves a
 * comfortable gap to the row's title/subtitle.
 */
export const CONNECTED_SERVICE_GAUGE_BOX = 48;

export function ConnectedServiceCapacityAvatar(props: ConnectedServiceCapacityAvatarProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const size = props.size ?? CONNECTED_SERVICE_GAUGE_SIZE;
    const loading = props.loading ?? false;
    const arcs = props.rings.map((ring) => ({ ratio: ring.ratio, color: resolveQuotaToneColor(theme, ring.tone) }));
    // Neutral high-contrast center number so it stays readable regardless of ring
    // count/tone (the rings already carry the health color; a tone-matched number
    // disappears against same-colored rings, e.g. a Claude account with 3 green rings).
    const centerColor = theme.colors.text.primary;

    return (
        <CapacityRing
            testID={props.testID}
            rings={arcs}
            size={size}
            strokeWidth={3}
            accessibilityLabel={props.accessibilityLabel}
        >
            {loading ? (
                <ActivitySpinner
                    testID={props.testID ? `${props.testID}:loading` : undefined}
                    size={Math.round(size * 0.42)}
                />
            ) : props.centerLabel != null ? (
                <Text
                    testID={props.testID ? `${props.testID}:capacity` : undefined}
                    style={[styles.pct, { color: centerColor }]}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    minimumFontScale={0.55}
                >
                    {props.centerLabel}
                </Text>
            ) : null}
        </CapacityRing>
    );
}

const stylesheet = StyleSheet.create(() => ({
    pct: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 15,
        fontWeight: '700',
        textAlign: 'center',
    },
}));
