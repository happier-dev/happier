import { useCallback, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';

import type { GlyphSurfaceWarmup } from '@/components/atmosphere/glyph/glyphSurfaceTypes';
import { useStepMotionStage } from '@/components/ui/motion/stepMotion/StepMotionStage';
import { useDesktopMainWindowContentReady } from '@/desktop/window/useDesktopMainWindowContentReady';
import { recordOpeningSeen } from '@/sync/domains/state/onboardingUiState';
import { invokeDesktopHost } from '@/utils/platform/desktopHost';

import { FirstOpenHost } from './FirstOpenHost';
import type { FirstOpenDecision } from './resolveFirstOpen';

type SceneModule = typeof import('./FirstOpenScene');
export type FirstOpenAdmission =
    ({ decision: 'in-app'; scene: SceneModule | null; warmup?: GlyphSurfaceWarmup }
    | { decision: 'overlay-eligible'; acknowledgeContent: ReturnType<typeof useDesktopMainWindowContentReady> }
    | { decision: 'reduced' }) & {
        release: () => void;
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
export function useFirstOpenBoot(isWelcomeDestination: boolean) {
    const stage = useStepMotionStage();
    const acknowledgeContent = useDesktopMainWindowContentReady();
    const [opening, setOpening] = useState<FirstOpenAdmission | null>(null);
    const admitOpening = useCallback((decision: FirstOpenDecision, desktopCandidate?: 'overlay' | 'in-app' | null) => {
        if (desktopCandidate) {
            // Main's decision only selects the host. The native presenter already started warming.
            void invokeDesktopHost('desktop_first_open_decide', { play: decision }).catch(() => {});
        }
        if (decision === 'none') return;

        const recordLayout = createFirstOpenLayoutRecorder();
        const releaseBuild = decision === 'in-app' ? stage?.prepareBuild() : undefined;
        let active = true;
        const release = () => {
            if (!active) return;
            active = false;
            releaseBuild?.();
            setOpening(current => current?.decision === 'in-app' && current.release === release && current.scene
                ? { ...current, scene: null, warmup: undefined }
                : current);
        };
        if (decision === 'in-app') {
            setOpening({ decision, scene: null, release, recordLayout });
            const scene = import('./FirstOpenScene');
            const warmup = import('@/components/atmosphere/glyph/GlyphSurface').then(glyph => active ? glyph.warmGlyphSurface() : undefined);
            void Promise.all([scene, warmup]).then(([module, renderer]) => {
                if (active) setOpening({ decision, scene: module, warmup: renderer, release, recordLayout });
            }, () => {});
        } else if (decision === 'overlay-eligible') {
            setOpening({ decision, acknowledgeContent, release, recordLayout });
        } else {
            setOpening({ decision, release, recordLayout });
        }
        return release;
    }, [acknowledgeContent, stage]);
    // The shell can lay out while its lazy Welcome route is still mounting. Only the
    // admitted Welcome acknowledges that launch; another destination uses the shell.
    const onShellLayout = opening?.decision === 'overlay-eligible' && isWelcomeDestination ? undefined : acknowledgeContent;
    return { opening, Host: FirstOpenHost, admitOpening, onShellLayout };
}
