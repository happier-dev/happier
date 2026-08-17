import * as Haptics from 'expo-haptics';
import * as React from 'react';
import { AccessibilityInfo, Pressable, View, useWindowDimensions, type GestureResponderEvent, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { GestureDetector } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { type PetAnimationStateV1 } from '@happier-dev/protocol';

import {
    PET_TAP_REACTION_DURATION_MS,
    PET_TAP_REACTION_HAPTIC,
} from '@/components/pets/animation/petAnimationPlaybackConfig';
import {
    usePetCompanionActivityModel,
    usePetCompanionTrayDismissals,
    type PetCompanionTrayItem,
} from '@/components/pets/activity';
import { DEFAULT_BUILT_IN_PET_ID } from '@/components/pets/builtIns/builtInPetRegistry';
import {
    CompanionNativeAnimatedView,
    useCompanionNativePanGesture,
} from '@/components/companion/interaction/useCompanionNativePanGesture';
import {
    CompanionNoDragRegion,
    useCompanionNoDragRegions,
} from '@/components/companion/interaction/CompanionNoDragRegion';
import { PET_COMPANION_RELEASE_MOTION } from '@/components/pets/interaction/petPointerDragBindings';
import { resolvePetNativeDragAnimationState } from '@/components/pets/interaction/resolvePetDragAnimationState';
import { PetCompanionState } from '@/components/pets/render/PetCompanionState';
import { resolvePetCompanionOverlayMetrics } from '@/components/pets/render/petCompanionDisplayMetrics';
import { PetSprite } from '@/components/pets/render/PetSprite.native';
import { usePetAnimatedFrame } from '@/components/pets/render/usePetAnimatedFrame';
import { usePetSpritesheetSource } from '@/components/pets/render/usePetSpritesheetSource';
import { useSelectedPetPackage } from '@/components/pets/source/useSelectedPetPackage';
import { PetCompanionActivityTray } from '@/components/pets/tray/PetCompanionActivityTray';
import {
    PET_COMPANION_ACTIVITY_TRAY_MAX_HEIGHT,
    PET_COMPANION_ACTIVITY_TRAY_WIDTH,
} from '@/components/pets/tray/petCompanionActivityTrayGeometry';
import {
    PET_COMPANION_POSITION_DEFAULT_MARGIN_PT,
    createStoredPetCompanionPosition,
    denormalizePetCompanionPosition,
    parsePetCompanionPosition,
    resolvePetCompanionPositionBounds,
    type PetCompanionPoint,
    type PetCompanionViewportMetrics,
} from '@/sync/domains/pets/companionPosition/companionPosition';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { useApplyLocalSettings } from '@/sync/store/settingsWriters';
import { useKeyboardHeight } from '@/hooks/ui/useKeyboardHeight';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';

const PET_TAP_REACTION_STATE = 'jumping' satisfies PetAnimationStateV1;
const PET_TAP_REACTION_HAPTIC_STYLE: Record<typeof PET_TAP_REACTION_HAPTIC, Haptics.ImpactFeedbackStyle> = {
    light: Haptics.ImpactFeedbackStyle.Light,
};
const NATIVE_PET_TRAY_GAP_PX = 18;

function useReducedMotionPreference(): boolean {
    const [reducedMotion, setReducedMotion] = React.useState(false);

    React.useEffect(() => {
        let mounted = true;
        void AccessibilityInfo.isReduceMotionEnabled()
            .then((enabled) => {
                if (mounted) setReducedMotion(enabled);
            })
            .catch(() => {
                if (mounted) setReducedMotion(false);
            });
        const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (enabled) => {
            setReducedMotion(enabled);
        });
        return () => {
            mounted = false;
            subscription.remove();
        };
    }, []);

    return reducedMotion;
}

function useTapReactionState(): Readonly<{
    reactionState: PetAnimationStateV1 | null;
    triggerTapReaction: (event: GestureResponderEvent | undefined, shouldSuppressPress: () => boolean) => void;
}> {
    const [reactionState, setReactionState] = React.useState<PetAnimationStateV1 | null>(null);
    const reactionTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    React.useEffect(() => () => {
        if (reactionTimeoutRef.current) {
            clearTimeout(reactionTimeoutRef.current);
        }
    }, []);

    const triggerTapReaction = React.useCallback((event: GestureResponderEvent | undefined, shouldSuppressPress: () => boolean) => {
        if (shouldSuppressPress()) {
            event?.preventDefault?.();
            event?.stopPropagation?.();
            return;
        }
        if (reactionTimeoutRef.current) {
            clearTimeout(reactionTimeoutRef.current);
        }
        setReactionState(PET_TAP_REACTION_STATE);
        reactionTimeoutRef.current = setTimeout(() => {
            reactionTimeoutRef.current = null;
            setReactionState(null);
        }, PET_TAP_REACTION_DURATION_MS);
        void Haptics.impactAsync(PET_TAP_REACTION_HAPTIC_STYLE[PET_TAP_REACTION_HAPTIC]).catch(() => {});
    }, []);

    return { reactionState, triggerTapReaction };
}

const NativePetCompanionSprite = React.memo(function NativePetCompanionSprite(props: Readonly<{
    state: PetAnimationStateV1;
    reducedMotion: boolean;
    hostViewed: boolean;
    spritesheetSource: ReturnType<typeof usePetSpritesheetSource>;
    scale: number;
}>): React.ReactElement {
    const frame = usePetAnimatedFrame({
        state: props.state,
        reducedMotion: props.reducedMotion || !props.hostViewed,
    });

    return (
        <PetSprite
            testID="pet-app-shell-companion-sprite"
            frame={frame}
            spritesheetSource={props.spritesheetSource}
            scale={props.scale}
        />
    );
});

function NativePetCompanionLayer({
    selectedPetPackage,
}: Readonly<{
    selectedPetPackage: ReturnType<typeof useSelectedPetPackage>;
}>): React.ReactElement {
    const { dismissedTrayItemKeys, dismissTrayItem } = usePetCompanionTrayDismissals();
    const activity = usePetCompanionActivityModel({ dismissedTrayItemKeys });
    const petsCompanionPosition = useLocalSetting('petsCompanionPosition');
    const petsCompanionSizeScale = useLocalSetting('petsCompanionSizeScale');
    const applyLocalSettings = useApplyLocalSettings();
    const dimensions = useWindowDimensions();
    const safeAreaInsets = useSafeAreaInsets();
    const keyboardHeight = useKeyboardHeight();
    const reducedMotion = useReducedMotionPreference();
    // One host watch for the whole app, and it answers the question this actually asks: is anyone
    // looking? A private `AppState.currentState === 'active'` sample said "no" on a host that had
    // not reported yet — Android before its first foreground transition — and froze the companion
    // on frame 0 for the whole of a cold start.
    const hostViewed = useHostActivelyViewed();
    const noDragRegions = useCompanionNoDragRegions();
    const spritesheetSource = usePetSpritesheetSource(selectedPetPackage.source, DEFAULT_BUILT_IN_PET_ID);
    const { reactionState, triggerTapReaction } = useTapReactionState();
    const metrics = React.useMemo(
        () => resolvePetCompanionOverlayMetrics(petsCompanionSizeScale),
        [petsCompanionSizeScale],
    );
    const trayItemCount = activity.trayItems.length;
    const hasTrayItems = trayItemCount > 0;
    const rootWidth = hasTrayItems ? Math.max(PET_COMPANION_ACTIVITY_TRAY_WIDTH, metrics.spriteWidth) : metrics.spriteWidth;
    const rootHeight = hasTrayItems
        ? PET_COMPANION_ACTIVITY_TRAY_MAX_HEIGHT + metrics.spriteHeight + NATIVE_PET_TRAY_GAP_PX
        : metrics.spriteHeight;
    const actionExecutor = React.useMemo(() => createDefaultActionExecutor(), []);

    const viewport = React.useMemo<PetCompanionViewportMetrics>(() => ({
        width: dimensions.width,
        height: dimensions.height,
        margin: PET_COMPANION_POSITION_DEFAULT_MARGIN_PT,
        keyboardHeight,
        safeAreaInsets,
    }), [dimensions.height, dimensions.width, keyboardHeight, safeAreaInsets]);

    const bounds = React.useMemo(() => resolvePetCompanionPositionBounds({
        viewport,
        petSize: { width: rootWidth, height: rootHeight },
    }), [rootHeight, rootWidth, viewport]);

    const initialPoint = React.useMemo<PetCompanionPoint>(() => denormalizePetCompanionPosition(
        parsePetCompanionPosition(petsCompanionPosition),
        bounds,
    ), [bounds, petsCompanionPosition]);

    const pan = useCompanionNativePanGesture<PetAnimationStateV1>({
        bounds,
        initialPoint,
        noDragRegions,
        releaseMotion: PET_COMPANION_RELEASE_MOTION,
        resolveDragState: resolvePetNativeDragAnimationState,
        onPositionChange: ({ point }) => {
            applyLocalSettings({
                petsCompanionPosition: createStoredPetCompanionPosition({
                    surface: 'mobile-app-shell',
                    point,
                    bounds,
                    viewport,
                }),
            });
        },
    });
    const effectiveState = reactionState ?? pan.dragState ?? activity.state;
    const handleOpenTrayItem = React.useCallback(async (item: PetCompanionTrayItem) => {
        await actionExecutor.execute(
            'session.open',
            { sessionId: item.sessionId },
            { defaultSessionId: item.sessionId },
        );
    }, [actionExecutor]);
    const handleQuickReply = React.useCallback(async (item: PetCompanionTrayItem, message: string) => {
        const trimmedMessage = message.trim();
        if (!trimmedMessage) return;
        await actionExecutor.execute(
            'session.message.send',
            { sessionId: item.sessionId, message: trimmedMessage },
            { defaultSessionId: item.sessionId },
        );
    }, [actionExecutor]);
    return (
        <GestureDetector gesture={pan.gesture}>
            <CompanionNativeAnimatedView
                pointerEvents="box-none"
                style={[
                    styles.root,
                    {
                        width: rootWidth,
                        height: rootHeight,
                    },
                    pan.animatedStyle,
                ]}
                testID="pet-app-shell-companion-root"
            >
                {hasTrayItems ? (
                    <CompanionNoDragRegion
                        testID="pet-app-shell-companion-tray-no-drag-region"
                        style={[
                            styles.trayNoDragRegion,
                            { bottom: metrics.spriteHeight + NATIVE_PET_TRAY_GAP_PX },
                        ]}
                    >
                        <PetCompanionActivityTray
                            items={activity.trayItems}
                            open
                            onOpenItem={handleOpenTrayItem}
                            onDismissItem={dismissTrayItem}
                            onQuickReply={handleQuickReply}
                        />
                    </CompanionNoDragRegion>
                ) : null}
                <PetCompanionState
                    state={effectiveState}
                    style={[
                        hasTrayItems ? styles.stateExpanded : styles.stateCompact,
                        {
                            width: metrics.spriteWidth,
                            height: metrics.spriteHeight,
                        },
                    ]}
                >
                    <Pressable
                        testID="pet-app-shell-companion-hitbox"
                        onPress={(event) => triggerTapReaction(event, pan.shouldSuppressPress)}
                        style={[
                            styles.hitbox,
                            {
                                width: metrics.spriteWidth,
                                height: metrics.spriteHeight,
                            },
                        ]}
                    >
                        <NativePetCompanionSprite
                            state={effectiveState}
                            reducedMotion={reducedMotion}
                            hostViewed={hostViewed}
                            spritesheetSource={spritesheetSource}
                            scale={metrics.scale}
                        />
                    </Pressable>
                </PetCompanionState>
            </CompanionNativeAnimatedView>
        </GestureDetector>
    );
}

export function PetAppShellCompanionMount(): React.ReactElement | null {
    const selectedPetPackage = useSelectedPetPackage();
    if (!selectedPetPackage.enabled || !selectedPetPackage.source) {
        return null;
    }

    // The no-drag registry is provided once at app-shell level so the pet and the Voice orb read
    // the same regions; a second provider here would give each companion only its own subtree.
    return (
        <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
            <NativePetCompanionLayer selectedPetPackage={selectedPetPackage} />
        </View>
    );
}

const styles = StyleSheet.create({
    root: {
        position: 'absolute',
        left: 0,
        top: 0,
        backgroundColor: 'transparent',
        zIndex: 20,
    } satisfies ViewStyle,
    hitbox: {
        backgroundColor: 'transparent',
    } satisfies ViewStyle,
    stateCompact: {
        position: 'absolute',
        right: 0,
        bottom: 0,
    } satisfies ViewStyle,
    stateExpanded: {
        position: 'absolute',
        right: 0,
        bottom: 0,
        alignItems: 'center',
        justifyContent: 'center',
    } satisfies ViewStyle,
    trayNoDragRegion: {
        position: 'absolute',
        right: 0,
    } satisfies ViewStyle,
});
