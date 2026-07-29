import * as React from 'react';
import { DrawnLinePath } from '@/components/instrument';
import { useEntrancesEnabled } from '../sections/EntranceView';
import { buildSparklinePath } from './sparklinePath';

/**
 * Inline micro-sparkline for the hero (40×14) and per-leader rows (48×12). Wraps
 * the kit `DrawnLinePath` with the pure `buildSparklinePath` geometry and honours
 * the surrounding entrance-once guard so a revisit remount renders the finished
 * stroke immediately. Renders nothing for an empty series.
 */
export type MiniSparklineProps = Readonly<{
    values: readonly number[];
    width: number;
    height: number;
    color: string;
    strokeWidth?: number;
    testID?: string;
}>;

export const MiniSparkline = React.memo(function MiniSparkline(props: MiniSparklineProps) {
    const entrancesEnabled = useEntrancesEnabled();
    const path = React.useMemo(
        () => buildSparklinePath(props.values, { width: props.width, height: props.height }),
        [props.values, props.width, props.height],
    );
    if (!path) {
        return null;
    }
    return (
        <DrawnLinePath
            path={path}
            width={props.width}
            height={props.height}
            color={props.color}
            strokeWidth={props.strokeWidth ?? 1.5}
            animateOnMount={entrancesEnabled}
            testID={props.testID}
        />
    );
});
