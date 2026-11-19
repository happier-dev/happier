import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { HomePlanet, homePlanetFootFade, useHomePlanetOptions, type HomePlanetLook } from '@/components/atmosphere/HomePlanet';
import type { HomePlanetPlacement } from '@/components/atmosphere/homePlanetPlacement';
import { useHomeLoadingMoment } from '@/components/atmosphere/moments/homeLoadingMoment';

/**
 * U8 harness: the product's Loading moment on a Home pane in a real browser, driven by the
 * page clock so a still can be taken at any moment time, beside the lab's own stills. A plain page and a
 * mocked hero stand in for Home's content; the moment, hand-off and Home planet are the product's.
 */
const PAGE = { light: '#F5F5F5', dark: '#131111' } as const;
const INK = { light: '#1a1a1a', dark: '#efefef' } as const;
type Theme = 'light' | 'dark';
type Case = Readonly<{ theme: Theme; width: number; height: number; placement: HomePlanetPlacement; readyAt?: number | null; reducedMotion?: boolean; holdHandOff?: boolean }>;

const mount = document.getElementById('product');
if (!mount) throw new Error('Missing harness mount');
const root = createRoot(mount);

function hero(placement: HomePlanetPlacement, height: number) {
    // Rise stands on the composer (lab Home: headline at the seam, composer under it, widgets below).
    return placement === 'rise' ? { composerTop: Math.round(height * 0.43), aboveBottom: Math.round(height * 0.66), nextTop: Math.round(height * 0.82) } : null;
}

function HomeContent(props: Readonly<{ theme: Theme; width: number; height: number }>) {
    const ink = INK[props.theme];
    const top = Math.round(Math.max(220, Math.min(500, props.height * 0.5)) - 92);
    return (
        <div style={{ position: 'absolute', left: 0, top, width: props.width, display: 'flex', flexDirection: 'column', alignItems: 'center', fontFamily: 'Inter-SemiBold' }}>
            <div style={{ width: 704, color: ink }}>
                <div style={{ fontSize: 34, letterSpacing: -0.6 }}>Good evening, Leeroy</div>
                <div style={{ marginTop: 28, height: 104, borderRadius: 22, background: props.theme === 'dark' ? 'rgba(40,38,38,0.86)' : 'rgba(255,255,255,0.9)',
                    boxShadow: '0 1px 0 rgba(0,0,0,0.04)', padding: 18, boxSizing: 'border-box', font: '400 16px Inter-Regular', opacity: 0.9 }}>
                    <span style={{ opacity: 0.45 }}>What should we work on?</span>
                </div>
            </div>
        </div>
    );
}

function LoadingHome(props: Case) {
    const pane = React.useMemo(() => ({ width: props.width, height: props.height }), [props.height, props.width]);
    const [ready, setReady] = React.useState(false);
    React.useEffect(() => {
        if (props.readyAt == null) return;
        const id = setTimeout(() => setReady(true), props.readyAt * 1000);
        return () => clearTimeout(id);
    }, [props.readyAt]);
    const look: HomePlanetLook = { pane, placement: props.placement, style: 'balanced', digits: true, theme: props.theme, phone: false, hero: hero(props.placement, props.height) };
    const options = useHomePlanetOptions(look);
    const fade = homePlanetFootFade(look);
    const [drawn, setDrawn] = React.useState(false);
    // `holdHandOff` keeps the landed moment up (Home's planet never reports drawn) for the identity still.
    const hold = props.holdHandOff === true;
    const onDrawn = React.useCallback(() => { if (!hold) setDrawn(true); }, [hold]);
    const home = React.useMemo(() => ({
        waiting: !ready, drawn, orientation: { rotate: options?.rotate ?? -1.5, mirror: false },
        target: ready && options ? { kind: 'planet' as const, options, fade } : null,
    }), [drawn, fade, options, ready]);
    const moment = useHomeLoadingMoment({
        waiting: !ready, start: 'mount', paused: false, reducedMotion: props.reducedMotion ?? false, theme: props.theme, pane, home,
        cover: <div style={{ position: 'absolute', inset: 0, background: PAGE[props.theme] }} />,
    });
    return (
        <div data-theme={props.theme} style={{ position: 'relative', width: props.width, height: props.height, overflow: 'hidden', background: PAGE[props.theme] }}>
            {ready ? (
                <HomePlanet {...look} hidden={moment.hold.held} arrive={moment.hold.arrive} leave="fade" reducedMotion={props.reducedMotion ?? false} onDrawn={onDrawn} />
            ) : null}
            {ready ? <HomeContent theme={props.theme} width={props.width} height={props.height} /> : null}
            {moment.layer}
        </div>
    );
}

let generation = 0;
const harness = {
    loading(input: Case) { root.render(<LoadingHome key={++generation} {...input} />); },
    clear() { root.render(null); },
    /** Canvas pixels by test id, for the hand-off identity check. */
    pixels(testID: string) {
        const canvas = document.querySelector(`[data-testid="${testID}"]`);
        if (!(canvas instanceof HTMLCanvasElement)) return null;
        return Array.from(canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data);
    },
};
(window as unknown as { U8: typeof harness }).U8 = harness;
