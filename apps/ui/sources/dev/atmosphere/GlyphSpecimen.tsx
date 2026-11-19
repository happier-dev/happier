import * as React from 'react';
import { PixelRatio, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { fieldDotLayer, frontGlyphLayer, markGlyphLayer, planetGlyphLayer, travellerGlyphLayer } from '@happier-dev/brand/glyph-scene';
import { horizonPlanetGeometry } from '@happier-dev/brand/planet-placement';

import { GlyphSurface } from '@/components/atmosphere/glyph/GlyphSurface';

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
    const { theme, opaque, cycles: requested } = useLocalSearchParams<{ theme?: string; opaque?: string; cycles?: string }>();
    const dark = theme === 'dark';
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
        <GlyphSurface key={key} width={pane.width} height={pane.height} theme={dark ? 'dark' : 'light'} scene={scene} onReady={onReady} testID="glyph-specimen-surface" />
    </View>;
}
