import * as React from 'react';
import { View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';

/**
 * A shared registry of rectangles a floating companion must not start a drag from.
 *
 * The registry is fully generic — it only ever holds measured rects — and there is exactly **one**
 * provider for the whole app shell so the pet and the Voice orb agree on the same regions. A second
 * provider would mean each companion sees only its own subtree's rects, which is how a drag starts
 * on top of another companion's action row.
 */

export type CompanionNoDragRegionRect = Readonly<{
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
}>;

type CompanionNoDragRegionRegistry = Readonly<{
    regions: readonly CompanionNoDragRegionRect[];
    registerRegion: (region: CompanionNoDragRegionRect) => void;
    unregisterRegion: (id: string) => void;
}>;

const CompanionNoDragRegionContext = React.createContext<CompanionNoDragRegionRegistry>({
    regions: [],
    registerRegion: () => {},
    unregisterRegion: () => {},
});

export function CompanionNoDragRegionProvider(props: Readonly<{
    children: React.ReactNode;
}>): React.ReactElement {
    const [regionsById, setRegionsById] = React.useState<Readonly<Record<string, CompanionNoDragRegionRect>>>({});

    const registerRegion = React.useCallback((region: CompanionNoDragRegionRect) => {
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

    const value = React.useMemo<CompanionNoDragRegionRegistry>(() => ({
        regions: Object.values(regionsById),
        registerRegion,
        unregisterRegion,
    }), [registerRegion, regionsById, unregisterRegion]);

    return (
        <CompanionNoDragRegionContext.Provider value={value}>
            {props.children}
        </CompanionNoDragRegionContext.Provider>
    );
}

export function useCompanionNoDragRegions(): readonly CompanionNoDragRegionRect[] {
    return React.useContext(CompanionNoDragRegionContext).regions;
}

export function pointIntersectsCompanionNoDragRegions(
    point: Readonly<{ x: number; y: number }>,
    regions: readonly CompanionNoDragRegionRect[],
): boolean {
    return regions.some((region) => (
        point.x >= region.x
        && point.x <= region.x + region.width
        && point.y >= region.y
        && point.y <= region.y + region.height
    ));
}

export function CompanionNoDragRegion(props: Readonly<{
    children?: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    testID?: string;
}>): React.ReactElement {
    const id = React.useId();
    const { registerRegion, unregisterRegion } = React.useContext(CompanionNoDragRegionContext);

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
