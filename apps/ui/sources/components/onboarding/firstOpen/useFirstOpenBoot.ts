import { useCallback, useState } from 'react';

import type { GlyphSurfaceWarmup } from '@/components/atmosphere/glyph/glyphSurfaceTypes';
import { useStepMotionStage } from '@/components/ui/motion/stepMotion/StepMotionStage';

import type { FirstOpenDecision } from './resolveFirstOpen';

type SceneModule = typeof import('./FirstOpenScene');
export type FirstOpenAdmission =
    | { decision: 'in-app'; scene: SceneModule | null; warmup?: GlyphSurfaceWarmup; release: () => void }
    | { decision: Exclude<FirstOpenDecision, 'in-app' | 'none'> };

/** Start optional work with the resolved boot decision while the app continues to its first layout. */
export function useFirstOpenBoot() {
    const stage = useStepMotionStage();
    const [opening, setOpening] = useState<FirstOpenAdmission | null>(null);
    const admitOpening = useCallback((decision: FirstOpenDecision) => {
        if (decision === 'none') return;
        if (decision !== 'in-app') {
            setOpening({ decision });
            return;
        }
        const releaseBuild = stage?.prepareBuild();
        let active = true;
        const release = () => {
            if (!active) return;
            active = false;
            releaseBuild?.();
            setOpening(current => current?.decision === 'in-app' && current.release === release && current.scene
                ? { decision, scene: null, release }
                : current);
        };
        const scene = import('./FirstOpenScene');
        const warmup = import('@/components/atmosphere/glyph/GlyphSurface').then(glyph => active ? glyph.warmGlyphSurface() : undefined);
        setOpening({ decision, scene: null, release });
        void Promise.all([scene, warmup]).then(([module, renderer]) => {
            if (active) setOpening({ decision, scene: module, warmup: renderer, release });
        }, () => {
            // The first layout uses Still if any preparation is unavailable.
        });
        return release;
    }, [stage]);
    return { opening, admitOpening };
}
