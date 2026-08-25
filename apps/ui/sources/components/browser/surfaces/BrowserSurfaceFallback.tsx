import * as React from 'react';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';

export type BrowserSurfaceUnavailableReason =
    | 'disabled'
    | 'view_targets_disabled'
    | 'host_lost'
    | 'adapter_recovering'
    | 'live_state_lost'
    | 'unsupported_target';

/**
 * `adapter_recovering` is the one reason that is not terminal — the host is coming back, so the
 * surface says so with the loading card rather than an unavailable one. Every other reason is a
 * settled state the user has to act on elsewhere.
 */
const RECOVERING_REASON: BrowserSurfaceUnavailableReason = 'adapter_recovering';

/**
 * The browser surface's unavailable state (U-5).
 *
 * It used to hand-roll a centred icon + grey caption with its own inline layout — a sixth private
 * spelling of a state the app already has ONE card for. `SurfaceStateCard` brings the shared tile,
 * the per-kind glyph, the live region (this state appears asynchronously when a host drops, so it
 * has to announce), and the `diagnosticCode` channel that keeps the raw reason code out of visible
 * text while leaving it addressable for QA.
 *
 * Both strings come from `resolveReasonCopy`, which already owns a translated per-kind title and
 * body for `browserSurface`. No new key: the copy owner had the title the card needed all along.
 */
export function BrowserSurfaceFallback(props: Readonly<{
    reason: BrowserSurfaceUnavailableReason;
    testID?: string;
}>): React.ReactElement {
    const recovering = props.reason === RECOVERING_REASON;
    const copy = resolveReasonCopy({ reasonCode: props.reason, kind: 'browserSurface' });
    return (
        <SurfaceStateCard
            testID={props.testID ?? `browser-surface-unavailable-${props.reason}`}
            kind={recovering ? 'loading' : 'unavailable'}
            iconName="globe"
            title={copy.title}
            reason={copy.message}
            diagnosticCode={props.reason}
            accessibilitySemantics="status"
        />
    );
}
