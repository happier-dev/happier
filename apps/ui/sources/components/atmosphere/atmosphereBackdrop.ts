import * as React from 'react';


import type { AtmosphereBackdrop } from './atmosphereBandBoundary';
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
