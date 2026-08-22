import * as React from 'react';
import { Platform, View, type ViewStyle } from 'react-native';

import { DEFAULT_BUILT_IN_PET_ID } from '@/components/pets/builtIns/builtInPetRegistry';
import {
    type CompanionPointerDragMove,
    useCompanionPointerDragSession,
} from '@/components/companion/interaction/useCompanionPointerDragSession';
import { PET_POINTER_DRAG_SELECTORS } from '@/components/pets/interaction/petPointerDragBindings';
import { resolvePetDragAnimationState } from '@/components/pets/interaction/resolvePetDragAnimationState';
import type { PetAnimationStateV1 } from '@happier-dev/protocol';
import type { PetCompanionTrayItem } from '@/components/pets/activity';
import {
    usePetCompanionActivityModel,
    usePetCompanionTrayDismissals,
} from '@/components/pets/activity';
import { PetCompanionSurface } from '@/components/pets/render/PetCompanionSurface';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useRuntimeActive } from '@/hooks/runtime/useRuntimeActive';
import {
    resolvePetCompanionOverlayMetrics,
    type PetCompanionOverlayMetrics,
} from '@/components/pets/render/petCompanionDisplayMetrics';
import { usePetSpritesheetSource } from '@/components/pets/render/usePetSpritesheetSource';
import { useSelectedPetPackage } from '@/components/pets/source/useSelectedPetPackage';
import { PetCompanionActivityTray } from '@/components/pets/tray/PetCompanionActivityTray';
import {
    PET_COMPANION_ACTIVITY_TRAY_MAX_HEIGHT,
    PET_COMPANION_ACTIVITY_TRAY_WIDTH,
} from '@/components/pets/tray/petCompanionActivityTrayGeometry';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { isDesktopHost } from '@/utils/platform/desktopHost';

const APP_SHELL_PET_MARGIN = 24;
const APP_SHELL_DEFAULT_METRICS = resolvePetCompanionOverlayMetrics(1);
const APP_SHELL_PET_WEB_Z_INDEX = 90_000;
const APP_SHELL_PET_WEB_POSITION = ('fixed' as unknown) as ViewStyle['position'];

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
    dragState: PetAnimationStateV1 | null;
    dragTargetRef: ReturnType<typeof useCompanionPointerDragSession<PetAnimationStateV1>>['dragTargetRef'];
    pointerHandlers: ReturnType<typeof useCompanionPointerDragSession<PetAnimationStateV1>>['pointerHandlers'];
    shouldSuppressPress: ReturnType<typeof useCompanionPointerDragSession<PetAnimationStateV1>>['shouldSuppressPress'];
} {
    const petsCompanionSizeScale = useLocalSetting('petsCompanionSizeScale');
    const metrics = React.useMemo(
        () => resolvePetCompanionOverlayMetrics(petsCompanionSizeScale),
        [petsCompanionSizeScale],
    );
    const [offset, setOffset] = React.useState<PetDragOffset>({ x: 0, y: 0 });
    const handleMove = React.useCallback((move: CompanionPointerDragMove) => {
        if (move.coordinateSpace !== 'client') return;
        setOffset((current) => clampDragOffset({
            x: current.x + move.deltaX,
            y: current.y + move.deltaY,
        }, metrics));
    }, [metrics]);
    const drag = useCompanionPointerDragSession<PetAnimationStateV1>({
        coordinateSpace: 'client',
        selectors: PET_POINTER_DRAG_SELECTORS,
        resolveDragState: resolvePetDragAnimationState,
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
    if (Platform.OS !== 'web' || isDesktopHost() || !selectedPetPackage.enabled || !selectedPetPackage.source) {
        return null;
    }

    return <PetAppShellCompanionRuntime selectedPetPackage={selectedPetPackage} />;
}

function PetAppShellCompanionRuntime({
    selectedPetPackage,
}: Readonly<{
    selectedPetPackage: ReturnType<typeof useSelectedPetPackage>;
}>): React.ReactElement {
    const { dismissedTrayItemKeys, dismissTrayItem } = usePetCompanionTrayDismissals();
    const activity = usePetCompanionActivityModel({ dismissedTrayItemKeys });
    const spritesheetSource = usePetSpritesheetSource(selectedPetPackage.source, DEFAULT_BUILT_IN_PET_ID);
    const drag = useAppShellPetDrag();
    // The companion's ambient motion exists only for a user who is looking at it. The native mount
    // already resolved both facts; without them here the web/desktop pet ran its frame ticker and
    // its ambient action chain through an OS reduced-motion preference and behind a hidden tab.
    const reducedMotion = useReducedMotionPreference();
    const runtimeActive = useRuntimeActive();
    const actionExecutor = React.useMemo(() => createDefaultActionExecutor(), []);
    const hasTrayItems = activity.trayItems.length > 0;
    const handleOpenTrayItem = React.useCallback(async (item: PetCompanionTrayItem) => {
        await actionExecutor.execute(
            'session.open',
            { sessionId: item.sessionId },
            { defaultSessionId: item.sessionId },
        );
    }, [actionExecutor]);
    const handleQuickReply = React.useCallback(async (item: PetCompanionTrayItem, message: string) => {
        const trimmedMessage = message.trim();
        if (!trimmedMessage) {
            return;
        }
        await actionExecutor.execute(
            'session.message.send',
            { sessionId: item.sessionId, message: trimmedMessage },
            { defaultSessionId: item.sessionId },
        );
    }, [actionExecutor]);
    return (
        <View
            pointerEvents="box-none"
            style={[
                styles.root,
                {
                    width: hasTrayItems
                        ? Math.max(PET_COMPANION_ACTIVITY_TRAY_WIDTH, drag.metrics.spriteWidth)
                        : drag.metrics.spriteWidth,
                    height: hasTrayItems
                        ? PET_COMPANION_ACTIVITY_TRAY_MAX_HEIGHT + drag.metrics.spriteHeight + 18
                        : drag.metrics.spriteHeight,
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
                reducedMotion={reducedMotion}
                active={runtimeActive}
                state={drag.dragState ?? activity.state}
                stateStyle={[
                    styles.pet,
                    {
                        width: drag.metrics.spriteWidth,
                        height: drag.metrics.spriteHeight,
                    },
                ]}
                hitboxTestID="pet-app-shell-companion-hitbox"
                spriteTestID="pet-app-shell-companion-sprite"
                spritesheetSource={spritesheetSource}
                scale={drag.metrics.scale}
                dragTargetRef={drag.dragTargetRef}
                pointerHandlers={drag.pointerHandlers}
                shouldSuppressPress={drag.shouldSuppressPress}
            />
            {hasTrayItems ? (
                <PetCompanionActivityTray
                    items={activity.trayItems}
                    open
                    onOpenItem={handleOpenTrayItem}
                    onDismissItem={dismissTrayItem}
                    onQuickReply={handleQuickReply}
                    style={[
                        styles.tray,
                        { bottom: drag.metrics.spriteHeight + 18 },
                    ]}
                />
            ) : null}
        </View>
    );
}

const styles = {
    root: {
        position: APP_SHELL_PET_WEB_POSITION,
        right: APP_SHELL_PET_MARGIN,
        bottom: APP_SHELL_PET_MARGIN,
        width: APP_SHELL_DEFAULT_METRICS.spriteWidth,
        height: APP_SHELL_DEFAULT_METRICS.spriteHeight,
        backgroundColor: 'transparent',
        zIndex: APP_SHELL_PET_WEB_Z_INDEX,
    } satisfies ViewStyle,
    pet: {
        position: 'absolute',
        right: 0,
        bottom: 0,
    } satisfies ViewStyle,
    tray: {
        position: 'absolute',
        right: 0,
    } satisfies ViewStyle,
} satisfies Record<string, ViewStyle>;
