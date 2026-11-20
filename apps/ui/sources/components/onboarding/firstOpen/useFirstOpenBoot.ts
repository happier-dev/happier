import { useCallback, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';

import type { GlyphSurfaceWarmup } from '@/components/atmosphere/glyph/glyphSurfaceTypes';
import { useStepMotionStage } from '@/components/ui/motion/stepMotion/StepMotionStage';
import { recordOpeningSeen } from '@/sync/domains/state/onboardingUiState';

import type { FirstOpenDecision } from './resolveFirstOpen';

type SceneModule = typeof import('./FirstOpenScene');
type Host = typeof import('./FirstOpenHost')['FirstOpenHost'];
export type FirstOpenAdmission =
    ({ decision: 'in-app'; scene: SceneModule | null; warmup?: GlyphSurfaceWarmup; release: () => void }
    | { decision: Exclude<FirstOpenDecision, 'in-app' | 'none'> }) & {
        recordLayout: (event: LayoutChangeEvent) => boolean;
    };

export function createFirstOpenLayoutRecorder() {
    let seen = false;
    return ({ nativeEvent: { layout } }: LayoutChangeEvent) => {
        if (seen || layout.width <= 0 || layout.height <= 0) return false;
        seen = true;
        recordOpeningSeen(Date.now());
        return true;
    };
}

/** Start optional work with the resolved boot decision while the app continues to its first layout. */
export function useFirstOpenBoot() {
    const stage = useStepMotionStage();
    const [opening, setOpening] = useState<FirstOpenAdmission | null>(null);
    const [Host, setHost] = useState<Host | null>(null);
    const admitOpening = useCallback((decision: FirstOpenDecision) => {
        if (decision === 'none') return;

        const recordLayout = createFirstOpenLayoutRecorder();
        const releaseBuild = decision === 'in-app' ? stage?.prepareBuild() : undefined;
        let active = true;
        let hostLoaded = false;
        const release = () => {
            if (!active) return;
            active = false;
            releaseBuild?.();
            setOpening(current => current?.decision === 'in-app' && current.release === release && current.scene
                ? { ...current, scene: null, warmup: undefined }
                : current);
        };
        void import('./FirstOpenHost').then(module => {
            if (!active) return;
            hostLoaded = true;
            setHost(() => module.FirstOpenHost);
        }, () => {});
        if (decision === 'in-app') {
            setOpening({ decision, scene: null, release, recordLayout });
            const scene = import('./FirstOpenScene');
            const warmup = import('@/components/atmosphere/glyph/GlyphSurface').then(glyph => active ? glyph.warmGlyphSurface() : undefined);
            void Promise.all([scene, warmup]).then(([module, renderer]) => {
                if (active) setOpening({ decision, scene: module, warmup: renderer, release, recordLayout });
            }, () => {});
        } else {
            setOpening({ decision, recordLayout });
        }
        return {
            release,
            // The route can mount as soon as boot is ready. A host arriving
            // after this boundary would remount the usable destination.
            ready: () => { if (!hostLoaded) release(); },
        };
    }, [stage]);
    return { opening, Host, admitOpening };
}
