import { HappierStatusDot, type HappierStatusDotProps } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

export type StatusDotProps = Omit<HappierStatusDotProps, 'reducedMotion'>;

/**
 * Happier core's status-dot adapter.
 *
 * The implementation is the shared presentation owner (UI-T27); this adapter
 * only supplies the app-wide reduced-motion preference (§3.10.2), and only on
 * the pulsing path. Status dots mount by the hundred in virtualized lists, so a
 * preference read on the static path would make every row subscribe to a value
 * it cannot use.
 */
export const StatusDot = React.memo((props: StatusDotProps) => {
    if (!props.isPulsing || props.animationEnabled === false) {
        return <HappierStatusDot {...props} />;
    }
    return <MotionAwareStatusDot {...props} />;
});

StatusDot.displayName = 'StatusDot';

function MotionAwareStatusDot(props: StatusDotProps) {
    const reducedMotion = useReducedMotionPreference();

    return <HappierStatusDot {...props} reducedMotion={reducedMotion} />;
}
