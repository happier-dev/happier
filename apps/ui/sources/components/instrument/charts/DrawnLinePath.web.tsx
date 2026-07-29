import * as React from 'react';

import { useMotionPreferences } from '../motion/useMotionPreferences';
import { LineFade } from './LineFade';

/**
 * Web build of `DrawnLinePath`: opacity fade only (tier-2 web policy, L4 T1.3),
 * keeping `@shopify/react-native-skia` out of the web bundle.
 */

export type DrawnLinePathProps = Readonly<{
    path: string;
    width: number;
    height: number;
    color: string;
    strokeWidth?: number;
    /**
     * False → render the finished stroke immediately (no draw-in). Additive,
     * default `true`; consumers with an entrance-once contract pass their
     * played-state guard here so a revisit remount does not replay.
     */
    animateOnMount?: boolean;
    testID?: string;
}>;

export const DrawnLinePath = React.memo(function DrawnLinePath(props: DrawnLinePathProps) {
    const motion = useMotionPreferences();
    return (
        <LineFade
            path={props.path}
            width={props.width}
            height={props.height}
            color={props.color}
            strokeWidth={props.strokeWidth}
            animateEntrance={motion.level !== 'minimal' && (props.animateOnMount ?? true)}
            durationMs={motion.entrance.durationMs}
            testID={props.testID}
        />
    );
});
