import { useLayoutEffect, useRef, type ComponentType } from 'react';

import { WelcomeEntryView, type WelcomeEntryViewModel } from '@/components/onboarding/preAuth/WelcomeEntryView';
import { UnauthenticatedSplitShell } from '@/components/onboarding/unauthShell/UnauthenticatedSplitShell';
import { useUnauthShellLayout } from '@/components/onboarding/unauthShell/useUnauthShellLayout';
import { visualAt } from '@/components/ui/motion/stepMotion/stepMotionChoreography';
import { stepMotionTiming } from '@/components/ui/motion/stepMotion/stepMotionTiming';
import type { StepBuildResult } from '@/components/ui/motion/stepMotion/stepMotionTypes';

import { FirstOpenWelcomeEpoch } from './FirstOpenWelcomeModelContext';
import { buildFirstOpenDestination, type FirstOpenPlacement } from './FirstOpenScene';
import { openingClimbSeconds } from './openingTimeline';

export { FirstOpenScene } from './FirstOpenScene';
export { skipFirstOpenDestination } from './FirstOpenScene';

const fadeBand = stepMotionTiming.band;
const cornerRadius = 10;

export const FirstOpenOverlayReplica: ComponentType<Readonly<{
    windowRect: FirstOpenPlacement['windowRect'];
    epoch: number;
    welcome: WelcomeEntryViewModel;
    onSettled: (outcome: StepBuildResult) => void;
}>> = function FirstOpenOverlayReplica({ windowRect, epoch, welcome, onSettled }) {
    const { x, y, width, height } = windowRect;
    const frame = useRef<HTMLDivElement>(null);
    const compact = useUnauthShellLayout(width) === 'compact';

    useLayoutEffect(() => {
        // Move the shell's feathered edge along the same climb as its controls.
        const duration = stepMotionTiming.openingS * 1000;
        const intervals = Math.ceil(stepMotionTiming.openingS * 60);
        const maskTravel = height + fadeBand;
        const masks = Array.from({ length: intervals + 1 }, (_, index) => {
            const front = visualAt('opening', index / intervals).arriveFront;
            return { maskPosition: `0 ${height - maskTravel * front}px` };
        });
        const wipe = frame.current?.animate?.(masks, {
            duration, delay: epoch + openingClimbSeconds * 1000 - performance.now(), fill: 'both',
        });
        let mounted = true;
        const finish = (outcome: StepBuildResult) => {
            wipe?.cancel();
            if (mounted) onSettled(outcome);
        };
        void buildFirstOpenDestination(epoch).then(finish, () => finish('skipped'));
        return () => {
            mounted = false;
            wipe?.cancel();
        };
    }, [epoch, height, onSettled]);

    return (
        <div ref={frame} inert aria-hidden="true" style={{
            position: 'absolute', left: x, top: y, width, height, display: 'flex', flexDirection: 'column',
            borderRadius: cornerRadius, overflow: 'hidden', pointerEvents: 'none',
            maskImage: `linear-gradient(to bottom, transparent, black ${fadeBand}px)`,
            maskSize: `100% ${height + fadeBand}px`, maskRepeat: 'no-repeat', maskPosition: `0 -${fadeBand}px`,
        }}>
            <FirstOpenWelcomeEpoch.Provider value={epoch}>
                <UnauthenticatedSplitShell frameWidth={width} stepId="welcome" isWelcomeStep>
                    <WelcomeEntryView model={welcome} compact={compact} />
                </UnauthenticatedSplitShell>
            </FirstOpenWelcomeEpoch.Provider>
        </div>
    );
};
