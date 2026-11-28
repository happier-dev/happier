import * as React from 'react';

import type { PetAnimationStateV1 } from '@happier-dev/protocol/pets/constants';

import {
    resolvePetAnimationNextFrameDelayMs,
    resolvePetAnimationTimeline,
    type ResolvedPetAnimationFrame,
} from '@/components/pets/animation/resolvePetAnimationTimeline';

function readNowMs(): number {
    return Date.now();
}

export function usePetAnimatedFrame(params: {
    state: PetAnimationStateV1;
    reducedMotion: boolean;
    active?: boolean;
}): ResolvedPetAnimationFrame {
    const active = params.active !== false;
    const stateStartedAtMsRef = React.useRef(readNowMs());
    const [nowMs, setNowMs] = React.useState(() => stateStartedAtMsRef.current);

    React.useEffect(() => {
        const now = readNowMs();
        stateStartedAtMsRef.current = now;
        setNowMs(now);
    }, [active, params.state, params.reducedMotion]);

    // One render per visible frame: wake at the next frame boundary rather than
    // on a fixed tick, and stop once the frame is fixed (reduced motion or a
    // settled action).
    React.useEffect(() => {
        if (!active || params.reducedMotion) return undefined;
        const delayMs = resolvePetAnimationNextFrameDelayMs({
            state: params.state,
            elapsedMs: nowMs - stateStartedAtMsRef.current,
            reducedMotion: params.reducedMotion,
        });
        if (delayMs === null) return undefined;

        const timeout = setTimeout(() => {
            setNowMs(readNowMs());
        }, delayMs);

        return () => clearTimeout(timeout);
    }, [active, nowMs, params.reducedMotion, params.state]);

    return React.useMemo(() => resolvePetAnimationTimeline({
        state: params.state,
        elapsedMs: nowMs - stateStartedAtMsRef.current,
        reducedMotion: params.reducedMotion,
    }), [nowMs, params.reducedMotion, params.state]);
}
