import { useLayoutEffect, useRef, type ComponentType, type CSSProperties } from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { WelcomeEntryView, type WelcomeEntryViewModel } from '@/components/onboarding/preAuth/WelcomeEntryView';
import { UnauthenticatedSplitShell } from '@/components/onboarding/unauthShell/UnauthenticatedSplitShell';
import { visualAt } from '@/components/ui/motion/stepMotion/stepMotionChoreography';
import { stepMotionTiming } from '@/components/ui/motion/stepMotion/stepMotionTiming';
import { resolveViewportClass } from '@/utils/platform/viewportClass';
import type { StepBuildResult } from '@/components/ui/motion/stepMotion/stepMotionTypes';

import { FirstOpenOwnsWelcomePaint, FirstOpenWelcomeEpoch } from './FirstOpenWelcomeModelContext';
import { buildFirstOpenDestination, type FirstOpenPlacement } from './FirstOpenScene';
import { openingClimbSeconds } from './openingTimeline';

export { FirstOpenScene } from './FirstOpenScene';
export { skipFirstOpenDestination } from './FirstOpenScene';

const fadeBand = stepMotionTiming.band;
const replicaPaint = {};
const cornerRadius = 10;

export const FirstOpenOverlayReplica: ComponentType<Readonly<{
    windowRect: FirstOpenPlacement['windowRect'];
    epoch: number;
    welcome: WelcomeEntryViewModel;
    onSettled: (outcome: StepBuildResult) => void;
}>> = function FirstOpenOverlayReplica({ windowRect, epoch, welcome, onSettled }) {
    const { x, y, width, height } = windowRect;
    const frame = useRef<HTMLDivElement>(null);
    const backdrop = useRef<HTMLDivElement>(null);
    const { theme } = useUnistyles();
    const compact = resolveViewportClass(windowRect) === 'compact';
    const maskedFrame: CSSProperties = {
        position: 'absolute', left: x, top: y, width, height,
        borderRadius: cornerRadius, overflow: 'hidden', pointerEvents: 'none',
        maskImage: `linear-gradient(to bottom, transparent, black ${fadeBand}px)`,
        maskSize: `100% ${height + fadeBand}px`, maskRepeat: 'no-repeat', maskPosition: `0 -${fadeBand}px`,
    };

    useLayoutEffect(() => {
        // Move the shell's feathered edge along the same climb as its controls.
        const duration = stepMotionTiming.openingS * 1000;
        const intervals = Math.ceil(stepMotionTiming.openingS * 60);
        const maskTravel = height + fadeBand;
        const masks = Array.from({ length: intervals + 1 }, (_, index) => {
            const front = visualAt('opening', index / intervals).arriveFront;
            return { maskPosition: `0 ${height - maskTravel * front}px` };
        });
        const timing = {
            duration, delay: epoch + openingClimbSeconds * 1000 - performance.now(), fill: 'both',
        } satisfies KeyframeAnimationOptions;
        const canvasWipe = backdrop.current?.animate?.(masks, timing);
        const contentWipe = frame.current?.animate?.(masks, timing);
        let mounted = true;
        const cancelWipes = () => {
            canvasWipe?.cancel();
            contentWipe?.cancel();
        };
        const finish = (outcome: StepBuildResult) => {
            cancelWipes();
            if (mounted) onSettled(outcome);
        };
        void buildFirstOpenDestination(epoch).then(finish, () => finish('skipped'));
        return () => {
            mounted = false;
            cancelWipes();
        };
    }, [epoch, height, onSettled]);

    return (
        <>
            {/* The full-screen glyph scene sits between the window canvas and its controls, as in Welcome. */}
            <div ref={backdrop} aria-hidden="true" style={{ ...maskedFrame, backgroundColor: theme.colors.background.canvas }} />
            <div ref={frame} inert aria-hidden="true"
                style={{ ...maskedFrame, zIndex: 1, display: 'flex', flexDirection: 'column' }}>
                <FirstOpenWelcomeEpoch.Provider value={epoch}>
                    <FirstOpenOwnsWelcomePaint.Provider value={replicaPaint}>
                        <UnauthenticatedSplitShell frameWidth={width} transparentCanvas stepId="welcome" isWelcomeStep warmStepMotion={false}>
                            <WelcomeEntryView model={welcome} compact={compact} />
                        </UnauthenticatedSplitShell>
                    </FirstOpenOwnsWelcomePaint.Provider>
                </FirstOpenWelcomeEpoch.Provider>
            </div>
        </>
    );
};
