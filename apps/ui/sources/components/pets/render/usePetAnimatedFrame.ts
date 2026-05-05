import * as React from 'react';

import type { PetAnimationStateV1 } from '@happier-dev/protocol';

import {
    PET_ANIMATION_TICK_MS,
} from '@/components/pets/animation/petAnimationPlaybackConfig';
import {
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

    React.useEffect(() => {
        if (!active || params.reducedMotion) return undefined;

        const interval = setInterval(() => {
            setNowMs(readNowMs());
        }, PET_ANIMATION_TICK_MS);

        return () => clearInterval(interval);
    }, [active, params.reducedMotion, params.state]);

    return React.useMemo(() => resolvePetAnimationTimeline({
        state: params.state,
        elapsedMs: nowMs - stateStartedAtMsRef.current,
        reducedMotion: params.reducedMotion,
    }), [nowMs, params.reducedMotion, params.state]);
}
