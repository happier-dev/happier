import * as React from 'react';
import {
    Platform,
    StyleSheet,
    View,
} from 'react-native';

import { DEFAULT_BUILT_IN_PET_ID } from '@/components/pets/builtIns/builtInPetRegistry';
import {
    type PetPointerDragMove,
    usePetPointerDragSession,
} from '@/components/pets/interaction/usePetPointerDragSession';
import { PetCompanionSurface } from '@/components/pets/render/PetCompanionSurface';
import {
    resolvePetCompanionOverlayMetrics,
    type PetCompanionOverlayMetrics,
} from '@/components/pets/render/petCompanionDisplayMetrics';
import { usePetSpritesheetSource } from '@/components/pets/render/usePetSpritesheetSource';
import { useSelectedPetPackage } from '@/components/pets/source/useSelectedPetPackage';
import { usePetCompanionActivityState } from '@/components/pets/state/usePetCompanionActivityState';
import { useLocalSettings } from '@/sync/domains/state/storage';
import { isTauriDesktop } from '@/utils/platform/tauri';

const APP_SHELL_PET_MARGIN = 24;
const APP_SHELL_DEFAULT_METRICS = resolvePetCompanionOverlayMetrics(1);

type PetDragOffset = Readonly<{ x: number; y: number }>;

function readViewportSize(): { width: number; height: number } {
    const win = (globalThis as { window?: { innerWidth?: unknown; innerHeight?: unknown } }).window;
    return {
        width: typeof win?.innerWidth === 'number' && Number.isFinite(win.innerWidth) ? win.innerWidth : 0,
        height: typeof win?.innerHeight === 'number' && Number.isFinite(win.innerHeight) ? win.innerHeight : 0,
    };
}

function clampDragOffset(offset: PetDragOffset, metrics: PetCompanionOverlayMetrics): PetDragOffset {
    const viewport = readViewportSize();
    const minX = -Math.max(0, viewport.width - (APP_SHELL_PET_MARGIN * 2) - metrics.spriteWidth);
    const minY = -Math.max(0, viewport.height - (APP_SHELL_PET_MARGIN * 2) - metrics.spriteHeight);
    return {
        x: Math.min(0, Math.max(minX, offset.x)),
        y: Math.min(0, Math.max(minY, offset.y)),
    };
}

function useAppShellPetDrag(): {
    offset: PetDragOffset;
    metrics: PetCompanionOverlayMetrics;
    dragState: ReturnType<typeof usePetPointerDragSession>['dragState'];
    dragTargetRef: ReturnType<typeof usePetPointerDragSession>['dragTargetRef'];
    pointerHandlers: ReturnType<typeof usePetPointerDragSession>['pointerHandlers'];
    shouldSuppressPress: ReturnType<typeof usePetPointerDragSession>['shouldSuppressPress'];
} {
    const localSettings = useLocalSettings();
    const metrics = React.useMemo(
        () => resolvePetCompanionOverlayMetrics(localSettings.petsCompanionSizeScale),
        [localSettings.petsCompanionSizeScale],
    );
    const [offset, setOffset] = React.useState<PetDragOffset>({ x: 0, y: 0 });
    const handleMove = React.useCallback((move: PetPointerDragMove) => {
        if (move.coordinateSpace !== 'client') return;
        setOffset((current) => clampDragOffset({
            x: current.x + move.deltaX,
            y: current.y + move.deltaY,
        }, metrics));
    }, [metrics]);
    const drag = usePetPointerDragSession({
        coordinateSpace: 'client',
        onDragMove: handleMove,
    });
    return {
        offset,
        metrics,
        dragState: drag.dragState,
        dragTargetRef: drag.dragTargetRef,
        pointerHandlers: drag.pointerHandlers,
        shouldSuppressPress: drag.shouldSuppressPress,
    };
}

export function PetAppShellCompanionMount(): React.ReactElement | null {
    const selectedPetPackage = useSelectedPetPackage();
    const activity = usePetCompanionActivityState();
    const spritesheetSource = usePetSpritesheetSource(selectedPetPackage.source, DEFAULT_BUILT_IN_PET_ID);
    const drag = useAppShellPetDrag();

    if (Platform.OS !== 'web' || isTauriDesktop() || !selectedPetPackage.enabled || !selectedPetPackage.source) {
        return null;
    }

    return (
        <View
            pointerEvents="box-none"
            style={[
                styles.root,
                {
                    width: drag.metrics.spriteWidth,
                    height: drag.metrics.spriteHeight,
                },
                {
                    transform: [
                        { translateX: drag.offset.x },
                        { translateY: drag.offset.y },
                    ],
                },
            ]}
            testID="pet-app-shell-companion-root"
        >
            <PetCompanionSurface
                state={drag.dragState ?? activity.state}
                hitboxTestID="pet-app-shell-companion-hitbox"
                spriteTestID="pet-app-shell-companion-sprite"
                spritesheetSource={spritesheetSource}
                scale={drag.metrics.scale}
                dragTargetRef={drag.dragTargetRef}
                pointerHandlers={drag.pointerHandlers}
                shouldSuppressPress={drag.shouldSuppressPress}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    root: {
        position: 'absolute',
        right: APP_SHELL_PET_MARGIN,
        bottom: APP_SHELL_PET_MARGIN,
        width: APP_SHELL_DEFAULT_METRICS.spriteWidth,
        height: APP_SHELL_DEFAULT_METRICS.spriteHeight,
        backgroundColor: 'transparent',
        zIndex: 20,
    },
});
