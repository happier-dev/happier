import * as React from 'react';
import type { LayoutChangeEvent, View } from 'react-native';

type Boundary = Readonly<{
    ref: React.RefObject<View | null> | undefined;
    onLayout: (event?: LayoutChangeEvent) => void;
    onFocusChange: (focused: boolean) => void;
    /**
     * The surface will show a picture here (chosen, whether or not it has arrived yet), so a band that
     * opens a picture band above itself reserves that room from its first paint and nothing moves on arrival.
     */
    pictureRoom?: boolean;
    /**
     * The planet is drawn behind this surface, so a band over it reads through material (a Project's page
     * tabs on their segmented track), never straight over its dots and digits.
     */
    planet?: boolean;
    /**
     * What a floating backdrop over this surface may carry softly (the New Session frost): the picture's
     * bytes (its thumbnail when it has one), or the planet. Null where the surface shows no background or
     * Reduce Transparency is on.
     */
    backdrop?: AtmosphereBackdrop | null;
}>;

export type AtmosphereBackdrop = Readonly<{ kind: 'picture'; bytes: Blob | string }> | Readonly<{ kind: 'planet' }>;

export const AtmosphereBandBoundary = React.createContext<Boundary | null>(null);
/** Attach at the actual composer or Project tabs; embedded composers have no atmosphere boundary. */
export const useAtmosphereBandBoundary = () => React.useContext(AtmosphereBandBoundary);
