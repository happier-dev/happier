import * as React from 'react';

const REST_DIGIT_RATE = 0.5;
const REST_DIGIT_STEP_S = 2;
import type { PlanetCanvasProps } from './planetCanvas.types';

/** Only the drawing leaf advances Welcome's resting digits; its scene owner stays still. */
export function usePlanetDigits(props: PlanetCanvasProps): PlanetCanvasProps {
    const [time, setTime] = React.useState(0);
    const running = props.options !== undefined && props.retype !== undefined && !props.retype.paused;
    React.useEffect(() => {
        if (!running) return;
        const timer = setInterval(() => setTime(current => current + REST_DIGIT_STEP_S),
            REST_DIGIT_STEP_S * 1000);
        return () => clearInterval(timer);
    }, [running]);
    return props.options && props.retype
        ? { ...props, options: { ...props.options, time, rate: REST_DIGIT_RATE } }
        : props;
}
