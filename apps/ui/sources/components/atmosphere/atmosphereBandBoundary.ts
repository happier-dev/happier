import * as React from 'react';
import type { LayoutChangeEvent, View } from 'react-native';

type Boundary = Readonly<{
    ref: React.RefObject<View | null> | undefined;
    onLayout: (event?: LayoutChangeEvent) => void;
    onFocusChange: (focused: boolean) => void;
}>;

export type AtmosphereBackdrop = Readonly<{ kind: 'picture'; bytes: Blob | string }> | Readonly<{ kind: 'planet' }>;

export const AtmosphereBandBoundary = React.createContext<Boundary | null>(null);
/** Attach at the actual composer or Project tabs; embedded composers have no atmosphere boundary. */
export const useAtmosphereBandBoundary = () => React.useContext(AtmosphereBandBoundary);
