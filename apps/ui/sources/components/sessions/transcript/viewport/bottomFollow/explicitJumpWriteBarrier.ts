import * as React from 'react';

import {
    planBottomFollowWriteSchedulerEvent,
    type BottomFollowWriteSchedulerEffect,
    type BottomFollowWriteSchedulerState,
} from '@/components/sessions/transcript/viewport/bottomFollow/writeScheduler';

export function useExplicitJumpWriteBarrier<PreviousWebMetrics>(params: Readonly<{
    applyEffects: (effects: readonly BottomFollowWriteSchedulerEffect<PreviousWebMetrics>[]) => void;
    schedulerStateRef: React.MutableRefObject<BottomFollowWriteSchedulerState<PreviousWebMetrics>>;
}>): readonly [begin: () => void, end: () => void] {
    const depthRef = React.useRef(0);
    const setActive = React.useCallback((active: boolean) => {
        const plan = planBottomFollowWriteSchedulerEvent(params.schedulerStateRef.current, {
            active,
            type: 'set-explicit-jump-active',
        });
        params.schedulerStateRef.current = plan.state;
        params.applyEffects(plan.effects);
    }, [params]);
    const begin = React.useCallback(() => {
        depthRef.current += 1;
        if (depthRef.current === 1) setActive(true);
    }, [setActive]);
    const end = React.useCallback(() => {
        depthRef.current = Math.max(0, depthRef.current - 1);
        if (depthRef.current === 0) setActive(false);
    }, [setActive]);
    return [begin, end];
}
