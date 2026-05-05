import { type ReactNode } from 'react';
import { handoffScenario } from './scenarios/handoff';
import type { Scenario } from './timeline/types';
import type { DemoSurfaceView } from './timeline/scenarioTypes';
import type { MediaDescriptor } from './frames/MediaSurface';
import { MediaSurface } from './frames/MediaSurface';
import { useScenarioStage, type DemoInstanceId } from './stage/useScenarioStage';
import { SingleCinematicStage } from './stage/variants/SingleCinematicStage';

type DeviceStageProps = {
    demoId?: DemoInstanceId;
    scenario?: Scenario;
    /** Override the phone surface — defaults to the active beat's media. */
    phoneScreen?: ReactNode;
    /** Override the desktop surface — defaults to the active beat's media. */
    desktopScreen?: ReactNode;
    phoneView?: DemoSurfaceView;
    desktopView?: DemoSurfaceView;
};

const fallbackMediaByView: Record<DemoSurfaceView, MediaDescriptor> = {
    'phone-session': {
        kind: 'image',
        src: '/images/demo/sessions/phone-session-list.png',
        alt: 'Happier session list on phone',
    },
    'phone-new-session': {
        kind: 'image',
        src: '/images/demo/sim/phone-new-session.png',
        alt: 'New session composer on phone',
    },
    'desktop-session': {
        kind: 'image',
        src: '/images/demo/sessions/desktop-patio-settings.png',
        alt: 'Happier session on desktop',
    },
    'desktop-new-session': {
        kind: 'image',
        src: '/images/demo/sessions/desktop-session-list.png',
        alt: 'New session surface on desktop',
    },
    'direct-browse': {
        kind: 'image',
        src: '/images/demo/sessions/desktop-session-list.png',
        alt: 'Direct session browser on desktop',
    },
    voice: {
        kind: 'image',
        src: '/images/demo/sim/phone-composer-keyboard.png',
        alt: 'Voice control on phone',
    },
};

/**
 * The cinematic stage.
 *
 * The earlier architecture mounted a separate `apps/demo` Web Component
 * to render real apps/ui components. That whole package is gone. Each
 * device frame now displays a real screenshot or short recording of the
 * live Happier app, supplied per-beat via `activeBeat.media`. The stage
 * still moves device frames around (scale, opacity, blur, slide) — the
 * media inside cross-fades between beats via MediaSurface.
 */
export function DeviceStage({
    demoId,
    scenario = handoffScenario,
    phoneScreen,
    desktopScreen,
    phoneView = 'phone-session',
    desktopView = 'desktop-session',
}: DeviceStageProps = {}) {
    const prep = useScenarioStage({
        demoId,
        scenario,
        layout: scenario.id === 'parallel' ? 'triple-parallel' : 'terminal-phone-desktop',
        phoneView,
        desktopView,
        phoneScreen,
        desktopScreen,
    });

    const phoneMedia = prep.activeBeat.media?.phone ?? null;
    const desktopMedia = prep.activeBeat.media?.desktop ?? null;

    const resolvedPhoneSurface =
        phoneScreen ?? renderMediaOrFallback(phoneMedia, prep.surfaceVisibility.resolvedPhoneView);
    const resolvedDesktopSurface =
        desktopScreen ??
        renderMediaOrFallback(desktopMedia, prep.surfaceVisibility.resolvedDesktopView);

    // Parallel scenario used to mount a separate ParallelStage; until we
    // re-author it as a media-driven composition, fall back to the cinematic
    // stage. Pillar sections that referenced parallel still render but as
    // a simpler hero-at-a-time arrangement.
    return (
        <SingleCinematicStage
            prep={prep}
            phoneSurface={resolvedPhoneSurface}
            desktopSurface={resolvedDesktopSurface}
        />
    );
}

function renderMediaOrFallback(media: MediaDescriptor | null, view: DemoSurfaceView): ReactNode {
    return <MediaSurface media={media ?? fallbackMediaByView[view]} />;
}
