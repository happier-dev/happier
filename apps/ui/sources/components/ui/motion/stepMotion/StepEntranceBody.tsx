import * as React from 'react';
import { Animated, Platform, type View, type ViewProps } from 'react-native';

export const StepEntranceBodyContext = React.createContext<Readonly<{
    targets: readonly Set<HTMLElement>[];
    opacity: Animated.AnimatedInterpolation<number> | ReturnType<typeof Animated.multiply>;
}> | null>(null);

/** The body follows a step's title by one short beat when the capture-free entrance runs. */
export function StepEntranceBody({ style, followHeading = true, ...props }: ViewProps & { followHeading?: boolean }) {
    const entrance = React.useContext(StepEntranceBodyContext);
    const mounted = React.useRef<HTMLElement | null>(null);
    const register = React.useCallback((view: View | null) => {
        if (Platform.OS !== 'web' || !entrance) return;
        if (mounted.current) for (const targets of entrance.targets) targets.delete(mounted.current);
        mounted.current = view instanceof HTMLElement ? view : null;
        if (mounted.current && followHeading) for (const targets of entrance.targets) targets.add(mounted.current);
    }, [entrance, followHeading]);
    return <Animated.View {...props} ref={register} style={[style,
        Platform.OS !== 'web' && entrance && followHeading ? { opacity: entrance.opacity } : undefined]} />;
}
