import * as React from 'react';
import {
    View,
    type LayoutChangeEvent,
    type StyleProp,
    type ViewStyle,
} from 'react-native';

export type PetNoDragRegionRect = Readonly<{
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
}>;

type PetNoDragRegionRegistry = Readonly<{
    regions: readonly PetNoDragRegionRect[];
    registerRegion: (region: PetNoDragRegionRect) => void;
    unregisterRegion: (id: string) => void;
}>;

const PetNoDragRegionContext = React.createContext<PetNoDragRegionRegistry>({
    regions: [],
    registerRegion: () => {},
    unregisterRegion: () => {},
});

export function PetNoDragRegionProvider(props: Readonly<{
    children: React.ReactNode;
}>): React.ReactElement {
    const [regionsById, setRegionsById] = React.useState<Readonly<Record<string, PetNoDragRegionRect>>>({});

    const registerRegion = React.useCallback((region: PetNoDragRegionRect) => {
        setRegionsById((current) => {
            const existing = current[region.id];
            if (
                existing
                && existing.x === region.x
                && existing.y === region.y
                && existing.width === region.width
                && existing.height === region.height
            ) {
                return current;
            }
            return { ...current, [region.id]: region };
        });
    }, []);

    const unregisterRegion = React.useCallback((id: string) => {
        setRegionsById((current) => {
            if (!current[id]) return current;
            const next = { ...current };
            delete next[id];
            return next;
        });
    }, []);

    const value = React.useMemo<PetNoDragRegionRegistry>(() => ({
        regions: Object.values(regionsById),
        registerRegion,
        unregisterRegion,
    }), [registerRegion, regionsById, unregisterRegion]);

    return (
        <PetNoDragRegionContext.Provider value={value}>
            {props.children}
        </PetNoDragRegionContext.Provider>
    );
}

export function usePetNoDragRegions(): readonly PetNoDragRegionRect[] {
    return React.useContext(PetNoDragRegionContext).regions;
}

export function pointIntersectsPetNoDragRegions(
    point: Readonly<{ x: number; y: number }>,
    regions: readonly PetNoDragRegionRect[],
): boolean {
    return regions.some((region) => (
        point.x >= region.x
        && point.x <= region.x + region.width
        && point.y >= region.y
        && point.y <= region.y + region.height
    ));
}

export function PetNoDragRegion(props: Readonly<{
    children?: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    testID?: string;
}>): React.ReactElement {
    const id = React.useId();
    const { registerRegion, unregisterRegion } = React.useContext(PetNoDragRegionContext);

    React.useEffect(() => () => {
        unregisterRegion(id);
    }, [id, unregisterRegion]);

    const handleLayout = React.useCallback((event: LayoutChangeEvent) => {
        const layout = event.nativeEvent.layout;
        registerRegion({
            id,
            x: layout.x,
            y: layout.y,
            width: layout.width,
            height: layout.height,
        });
    }, [id, registerRegion]);

    // Native drag suppression uses measured registrations; web uses data-pet-no-drag DOM markers.
    return (
        <View
            testID={props.testID}
            style={props.style}
            onLayout={handleLayout}
        >
            {props.children}
        </View>
    );
}
