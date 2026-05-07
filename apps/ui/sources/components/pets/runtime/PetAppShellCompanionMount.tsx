import * as React from 'react';
import {
    Platform,
    StyleSheet,
    View,
} from 'react-native';

import { DEFAULT_BUILT_IN_PET_ID } from '@/components/pets/builtIns/builtInPetRegistry';
import {
    openDesktopPetOverlayTrayItem,
    sendDesktopPetOverlayQuickReply,
    tuckDesktopPetOverlay,
} from '@/components/pets/desktop/actions/desktopPetOverlayActions';
import { DesktopPetOverlayContextActions } from '@/components/pets/desktop/actions/DesktopPetOverlayContextActions';
import {
    resolveDesktopPetOverlayGeometry,
} from '@/components/pets/desktop/desktopPetOverlayGeometry';
import { resolveDesktopPetOverlayPolicy } from '@/components/pets/desktop/policy/resolveDesktopPetOverlayPolicy';
import { DesktopPetOverlayTray } from '@/components/pets/desktop/tray/DesktopPetOverlayTray';
import { usePetCompanionActivityModel, type PetCompanionTrayItem } from '@/components/pets/activity';
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
import { useLocalSettings, useSettings } from '@/sync/domains/state/storage';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { useApplyLocalSettings } from '@/sync/store/settingsWriters';
import { isTauriDesktop } from '@/utils/platform/tauri';

const APP_SHELL_PET_MARGIN = 24;
const APP_SHELL_DEFAULT_METRICS = resolvePetCompanionOverlayMetrics(1);
const APP_SHELL_CONTEXT_ACTION_SHOULDER_BOTTOM_OFFSET_PX = 12;

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
    const settings = useSettings();
    const localSettings = useLocalSettings();
    const spritesheetSource = usePetSpritesheetSource(selectedPetPackage.source, DEFAULT_BUILT_IN_PET_ID);
    const drag = useAppShellPetDrag();
    const geometry = React.useMemo(
        () => resolveDesktopPetOverlayGeometry(localSettings.petsCompanionSizeScale),
        [localSettings.petsCompanionSizeScale],
    );
    const [dismissedTrayItemKeys, setDismissedTrayItemKeys] = React.useState<ReadonlySet<string>>(() => new Set());
    const activity = usePetCompanionActivityModel({ dismissedTrayItemKeys });
    const [trayOpen, setTrayOpen] = React.useState(false);
    const trayItemCount = activity.trayItems.length;
    const applyLocalSettings = useApplyLocalSettings();
    const actionExecutor = React.useMemo(() => createDefaultActionExecutor(), []);
    const desktopOverlayPolicy = React.useMemo(() => resolveDesktopPetOverlayPolicy({
        companionFeatureState: selectedPetPackage.enabled ? 'enabled' : 'disabled',
        accountSettings: settings,
        localSettings,
    }), [localSettings, selectedPetPackage.enabled, settings]);
    const desktopOverlayOwnsPet = isTauriDesktop() && desktopOverlayPolicy.enabled;
    React.useEffect(() => {
        setTrayOpen((current) => {
            if (trayItemCount === 0) return false;
            return current || trayItemCount > 0;
        });
    }, [trayItemCount]);
    const hasTrayItems = activity.trayItems.length > 0;
    const handleOpenTrayItem = React.useCallback(async (item: PetCompanionTrayItem) => {
        await openDesktopPetOverlayTrayItem({
            item,
            executor: actionExecutor,
            showMainWindow: async () => undefined,
        });
    }, [actionExecutor]);
    const handleQuickReply = React.useCallback(async (item: PetCompanionTrayItem, message: string) => {
        await sendDesktopPetOverlayQuickReply({ item, message, executor: actionExecutor });
    }, [actionExecutor]);
    const handleDismissTrayItem = React.useCallback((item: PetCompanionTrayItem) => {
        setDismissedTrayItemKeys((current) => {
            const next = new Set(current);
            next.add(item.dismissKey);
            return next;
        });
    }, []);
    const handleTuck = React.useCallback(() => {
        tuckDesktopPetOverlay({ applyLocalSettings });
    }, [applyLocalSettings]);

    if (Platform.OS !== 'web' || desktopOverlayOwnsPet || !selectedPetPackage.enabled || !selectedPetPackage.source) {
        return null;
    }

    return (
        <View
            pointerEvents="box-none"
            style={[
                styles.root,
                {
                    width: hasTrayItems ? geometry.expandedWindowWidth : drag.metrics.spriteWidth,
                    height: hasTrayItems ? geometry.expandedWindowHeight : drag.metrics.spriteHeight,
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
                stateStyle={[
                    hasTrayItems ? styles.petExpanded : styles.petCompact,
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
                <DesktopPetOverlayTray
                    items={activity.trayItems}
                    open={trayOpen}
                    onOpenItem={handleOpenTrayItem}
                    onDismissItem={handleDismissTrayItem}
                    onQuickReply={handleQuickReply}
                    style={[
                        styles.tray,
                        { bottom: geometry.windowHeight + 18 },
                    ]}
                />
            ) : null}
            {hasTrayItems ? (
                <DesktopPetOverlayContextActions
                    trayCount={trayItemCount}
                    trayOpen={trayOpen}
                    onTrayOpenChange={setTrayOpen}
                    onTuck={handleTuck}
                    style={[
                        styles.contextExpanded,
                        { bottom: geometry.windowHeight - APP_SHELL_CONTEXT_ACTION_SHOULDER_BOTTOM_OFFSET_PX },
                    ]}
                />
            ) : null}
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
    petCompact: {
        position: 'absolute',
        right: 0,
        bottom: 0,
    },
    petExpanded: {
        position: 'absolute',
        right: 36,
        bottom: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    tray: {
        position: 'absolute',
        right: 58,
    },
    contextExpanded: {
        position: 'absolute',
        right: 46,
    },
});
