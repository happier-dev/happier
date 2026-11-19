import { processColor } from 'react-native';

import type { PlanetRgb } from '@happier-dev/brand/planet';

export function themeHorizonInk(colour: string): PlanetRgb | undefined {
    const argb = processColor(colour);
    if (typeof argb !== 'number') return undefined;
    return [(argb >>> 16) & 255, (argb >>> 8) & 255, argb & 255];
}
