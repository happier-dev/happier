import { fieldDotLayer, planetGlyphLayer, type FieldDotOptions } from '@happier-dev/brand/glyph-scene';
import { welcomePlanetPose, type HomePane, type WelcomePlanetState } from '@happier-dev/brand/planet-placement';

/** The welcome pose and the quieter stipple behind its controls share one presentation. */
export function welcomeGlyphScene(state: WelcomePlanetState, pane: HomePane, options: Readonly<{
    phone: boolean;
    field: FieldDotOptions;
}>) {
    return [
        fieldDotLayer(options.field),
        planetGlyphLayer({ geometry: welcomePlanetPose(state, pane, options), intensity: 'quiet', digits: true }),
    ] as const;
}
