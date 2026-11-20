import * as React from 'react';
import { PixelRatio, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { createLoadingPlanetScene, fieldDotLayer, frontGlyphLayer, markGlyphLayer, planetGlyphLayer, travellerGlyphLayer } from '@happier-dev/brand/glyph-scene';
import { horizonPlanetGeometry } from '@happier-dev/brand/planet-placement';
import { createThemeHorizonGlyphSampler, themeHorizonGlyphCell } from '@happier-dev/brand/planet-moments';

import { PairingQrMomentCanvas } from '@/components/auth/pairing/PairingQrMoment';
import { GlyphSurface } from '@/components/atmosphere/glyph/GlyphSurface';
import { sessionRippleLayer } from '@/components/atmosphere/sessionRipple';
import { loadingPlanetLayers, loadingPlanetOrigin, loadingPlanetPhase } from '@/components/atmosphere/moments/planetMomentTimeline';
import { homeRiseFootFade } from '@/components/atmosphere/homePlanetPlacement';

const pane = { width: 390, height: 520 };
const centre = { x: 195, y: 108 };
const travellers = new Float32Array([195, 108, 310, 390, 0, 1, 30, 0.7]);
const scene = [
    fieldDotLayer({ mode: 'still' }),
    planetGlyphLayer({ geometry: horizonPlanetGeometry(pane, { phone: true }), intensity: 'quiet', digits: true }),
    markGlyphLayer({ centre, size: 108, ink: 'sunrise' }),
    travellerGlyphLayer({ particles: travellers, ink: 'sunrise', small: true }),
    frontGlyphLayer({ shape: 'roundRect', rect: { x: 20, y: 260, width: 350, height: 140 },
        front: 0.6, band: 0.16, ragged: 0.2, alpha: 0.6, ink: 'sunrise', mode: 'decode' }),
] as const;

export default function GlyphSpecimen() {
    const { theme, opaque, cycles: requested, moment, at } = useLocalSearchParams<{
        theme?: string; opaque?: string; cycles?: string; moment?: string; at?: string;
    }>();
    const dark = theme === 'dark';
    const palette = dark ? 'dark' : 'light';
    const themeFrame = React.useMemo(createThemeHorizonGlyphSampler, []);
    const loadingFrame = React.useMemo(createLoadingPlanetScene, []);
    const layers = React.useMemo(() => {
        const geometry = horizonPlanetGeometry(pane, { phone: true });
        const options = { geometry, intensity: 'quiet', digits: true } as const;
        const seconds = Number(at ?? '0.5') || 0;
        if (moment === 'horizon') {
            const fade = homeRiseFootFade({ aboveBottom: pane.height * 0.66, nextTop: pane.height * 0.87, phone: true });
            return [planetGlyphLayer({ ...options, geometry: horizonPlanetGeometry(pane, { phone: true, composerTop: pane.height * 0.43 }), fade })];
        }
        if (moment === 'theme') return [themeFrame(seconds, { w: pane.width, h: pane.height, dir: dark ? 'night' : 'sunrise', kind: 'horizon' },
            dark ? [239, 237, 237] : [26, 26, 26]).glyphs];
        if (moment === 'ripple') return [sessionRippleLayer(options, seconds * 1000, {
            width: pane.width, theme: palette, reducedMotion: false,
        })];
        if (moment === 'loading') {
            const target = { kind: 'planet', layer: planetGlyphLayer(options), pane } as const;
            const phase = loadingPlanetPhase(seconds, seconds < 1 ? null : 1, { reducedMotion: false, toPlanet: true });
            return loadingPlanetLayers(loadingFrame, phase, loadingPlanetOrigin(pane), target);
        }
        return scene;
    }, [at, dark, loadingFrame, moment, palette, themeFrame]);
    const cycles = requested === '20' ? 20 : 1;
    const [draws, setDraws] = React.useState(0);
    const [status, setStatus] = React.useState('warming');
    const onReady = React.useCallback((result: 'ready' | 'still') => {
        setStatus(result);
        if (result === 'ready') setDraws(count => count + 1);
    }, []);
    const key = Math.min(cycles - 1, draws);
    return <View
        testID={`glyph-specimen-${status}-${draws}-${PixelRatio.get()}`}
        style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: opaque === '1' ? dark ? '#141214' : '#fbf7f4' : 'transparent' }}
    >
        {moment === 'pairing' ? <PairingQrMomentCanvas size={224} theme={palette} pairing reducedMotion machines={['Desktop']}
            scene={{ kind: 'pairing', device: 'Laptop', scan: null, joinedAtMs: 0 }} />
            : <GlyphSurface key={key} width={pane.width} height={pane.height} theme={palette} scene={layers}
                cell={moment === 'theme' ? themeHorizonGlyphCell : undefined} onReady={onReady} testID="glyph-specimen-surface" />}
    </View>;
}
