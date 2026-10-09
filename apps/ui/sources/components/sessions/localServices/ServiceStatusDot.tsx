import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { StatusDot } from '@/components/ui/status/StatusDot';
import { workStatusGlyphColor } from '@/components/work/status/workStatusTreatment';
import type { ServiceRowStatus } from '@/sync/domains/local/services/serviceRow';

const DOT_SIZE = 8;

/**
 * How a service's status reads as a dot.
 *
 * - `running`: the work-status neutral ink on its soft ring, still. Healthy is quiet (DESIGN: colour
 *   means state — amber needs you, rose failed — and no indefinite decorative animation on routine
 *   surfaces), so a server that has been up for three hours neither glows green nor pulses for three hours.
 * - `starting` / `stopping`: the same dot, pulsing, because it is actually in progress; it stops the
 *   moment the supervisor settles. That is what tells them from `running` (H-UX F-11).
 * - `stale`: a neutral dot, no ring. `stopped` / `unavailable`: a tertiary dot, no ring.
 * - `failed`: the danger ink, no ring — the one status that is a failure (colour means state).
 *
 * The dot is always drawn beside the status in words (the row title, the pane's live line), so it is
 * a companion of that text, never the only carrier of the meaning (WCAG 1.4.1 / 1.4.11, F-PLAN-21);
 * callers therefore leave it unnamed and it is hidden from assistive technology rather than announced
 * twice.
 */
type ServiceDotTone = 'live' | 'starting' | 'idle' | 'gone' | 'failed';

/**
 * The dot's tone is a projection of the row's canonical status — never a second reading of the raw
 * `LocalServiceLaunchTarget['state']` (SB-F). `resolveStatus` in the row model is the one owner that
 * turns the daemon's launch-target state into a service status; taking `ServiceRowStatus` here keeps
 * that split unrepresentable (the raw state's `'available'` is not a member of this union).
 */
function serviceDotTone(status: ServiceRowStatus): ServiceDotTone {
    switch (status) {
        case 'running':
            return 'live';
        case 'starting':
        case 'stopping':
            return 'starting';
        case 'failed':
            return 'failed';
        case 'stale':
            return 'idle';
        case 'stopped':
        case 'unavailable':
            return 'gone';
    }
}

export function ServiceStatusDot(props: Readonly<{
    status: ServiceRowStatus;
    animationEnabled?: boolean;
    testID: string;
    /** Only for a dot shown without its status in words; a row that says the status leaves this unset. */
    accessibilityLabel?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const tone = serviceDotTone(props.status);
    const ringed = tone === 'live' || tone === 'starting';
    // Live work takes the shared healthy (neutral) Work-status glyph ink, the same one a running tool
    // group or Work row draws; the ring, not a hue, tells a live service from a stale one.
    const color = ringed
        ? workStatusGlyphColor(theme.colors, 'neutral')
        : tone === 'idle'
            ? theme.colors.state.neutral.foreground
            : tone === 'failed'
                ? theme.colors.state.danger.foreground
                : theme.colors.text.tertiary;
    return (
        <StatusDot
            testID={props.testID}
            color={color}
            halo={ringed ? theme.colors.state.neutral.background : undefined}
            size={DOT_SIZE}
            isPulsing={tone === 'starting'}
            animationEnabled={props.animationEnabled !== false}
            accessibilityLabel={props.accessibilityLabel}
        />
    );
}
