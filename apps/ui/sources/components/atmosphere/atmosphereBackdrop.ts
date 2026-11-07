import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { PLANET_PALETTES } from '@happier-dev/brand/planet';

import { useGlassBlurSetting } from '@/components/ui/glass/useGlassBlurSetting';
import type { FloatingBackdropPicture } from '@/components/ui/overlays/createBackdropLayerStyle';

import type { AtmosphereBackdrop } from './atmosphereBandBoundary';
import { usePictureUri } from './look/usePictureBytes';
import type { useAtmosphere } from './useAtmosphere';

const PLANET_BACKDROP: AtmosphereBackdrop = { kind: 'planet' };

/** The surface's own picture (no second read or decode: the record the resolver already holds), or the planet. */
export function useAtmosphereBackdrop(atmosphere: ReturnType<typeof useAtmosphere>): AtmosphereBackdrop | null {
    const soft = atmosphere.shown && !atmosphere.reduceTransparency;
    const record = soft && atmosphere.source === 'picture' ? atmosphere.pictureRecord : null;
    const bytes = record ? record.thumb ?? record.data : null;
    const planet = soft && atmosphere.source === 'planet';
    return React.useMemo(() => bytes ? { kind: 'picture', bytes } : planet ? PLANET_BACKDROP : null, [bytes, planet]);
}

/** The planet's warm key, rose and cool rim, faint, for the glow that stands in for a picture. */
function planetGlowColors(dark: boolean): readonly [string, string, string] {
    const orb = PLANET_PALETTES[dark ? 'dark' : 'light'].orb;
    const faint = (color: string, share: number) => `color-mix(in srgb, ${color} ${share}%, transparent)`;
    return dark
        ? [faint(orb.gold, 30), faint(orb.ember, 22), faint(orb.azure, 34)]
        : [faint(orb.gold, 55), faint(orb.plum, 50), faint(orb.azure, 34)];
}

/**
 * What a floating backdrop carries softly in its frost: the picture, or a planet-colour glow when the planet
 * is the source. Solid glass keeps the plain frost.
 */
export function useFloatingBackdropPicture(backdrop: AtmosphereBackdrop | null): FloatingBackdropPicture | null {
    const { theme } = useUnistyles();
    const { blurEnabled } = useGlassBlurSetting();
    const uri = usePictureUri(blurEnabled && backdrop?.kind === 'picture' ? backdrop.bytes : null);
    return uri ? { kind: 'picture', uri }
        : blurEnabled && backdrop?.kind === 'planet' ? { kind: 'glow', colors: planetGlowColors(theme.dark) } : null;
}
