import {
    createPlanetMarkGeometry,
    type PlanetDotPose,
    type PlanetMarkGeometry,
    type PlanetTheme,
} from '@happier-dev/brand/planet';

export type VoiceMarkGeometry = PlanetMarkGeometry;

const cache = new Map<string, PlanetMarkGeometry>();

/**
 * The Brand mark geometry for one size · theme · pose (· readiness light), built once per process.
 * Every dot, colour and morph fact is the Brand owner's; this only memoizes it for the painters.
 */
export function resolveVoiceMarkGeometry(input: Readonly<{
    size: number;
    theme: PlanetTheme;
    pose: PlanetDotPose;
    /** A static light vector (readiness art); absent, the pose lights the planet. */
    light?: readonly [number, number, number];
}>): PlanetMarkGeometry {
    const key = `${input.size}:${input.theme}:${input.pose}:${input.light?.join(',') ?? ''}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const geometry = createPlanetMarkGeometry(input);
    cache.set(key, geometry);
    return geometry;
}
