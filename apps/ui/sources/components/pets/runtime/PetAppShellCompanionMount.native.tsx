import * as React from 'react';
import {
    AccessibilityInfo,
    AppState,
    Pressable,
    StyleSheet,
    View,
    useWindowDimensions,
    type AppStateStatus,
    type GestureResponderEvent,
    type ViewStyle,
} from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';

import { type PetAnimationStateV1 } from '@happier-dev/protocol';

import {
    PET_TAP_REACTION_DURATION_MS,
    PET_TAP_REACTION_HAPTIC,
} from '@/components/pets/animation/petAnimationPlaybackConfig';
import { DEFAULT_BUILT_IN_PET_ID } from '@/components/pets/builtIns/builtInPetRegistry';
import { PetNativeAnimatedView, usePetNativePanGesture } from '@/components/pets/interaction/usePetNativePanGesture';
import { PetNoDragRegionProvider, usePetNoDragRegions } from '@/components/pets/interaction/PetNoDragRegion';
import { PetCompanionState } from '@/components/pets/render/PetCompanionState';
import { resolvePetCompanionOverlayMetrics } from '@/components/pets/render/petCompanionDisplayMetrics';
import { PetSprite } from '@/components/pets/render/PetSprite.native';
import { usePetAnimatedFrame } from '@/components/pets/render/usePetAnimatedFrame';
import { usePetSpritesheetSource } from '@/components/pets/render/usePetSpritesheetSource';
import { useSelectedPetPackage } from '@/components/pets/source/useSelectedPetPackage';
import { usePetCompanionActivityState } from '@/components/pets/state/usePetCompanionActivityState';
import {
    PET_COMPANION_POSITION_DEFAULT_MARGIN_PT,
    createStoredPetCompanionPosition,
    denormalizePetCompanionPosition,
    parsePetCompanionPosition,
    resolvePetCompanionPositionBounds,
    type PetCompanionPoint,
    type PetCompanionViewportMetrics,
} from '@/sync/domains/pets/companionPosition/companionPosition';
import { useLocalSettings } from '@/sync/domains/state/storage';
import { useApplyLocalSettings } from '@/sync/store/settingsWriters';
import { useKeyboardHeight } from '@/hooks/ui/useKeyboardHeight';

const PET_TAP_REACTION_STATE = 'jumping' satisfies PetAnimationStateV1;
const PET_TAP_REACTION_HAPTIC_STYLE: Record<typeof PET_TAP_REACTION_HAPTIC, Haptics.ImpactFeedbackStyle> = {
    light: Haptics.ImpactFeedbackStyle.Light,
};

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

function useAppStateActive(): boolean {
    const [active, setActive] = React.useState(() => AppState.currentState === 'active');

    React.useEffect(() => {
        const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
            setActive(state === 'active');
        });
        return () => {
            subscription.remove();
        };
    }, []);

    return active;
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

function NativePetCompanionLayer(): React.ReactElement | null {
    const selectedPetPackage = useSelectedPetPackage();
    const activity = usePetCompanionActivityState();
    const localSettings = useLocalSettings();
    const applyLocalSettings = useApplyLocalSettings();
    const dimensions = useWindowDimensions();
    const safeAreaInsets = useSafeAreaInsets();
    const keyboardHeight = useKeyboardHeight();
    const reducedMotion = useReducedMotionPreference();
    const appActive = useAppStateActive();
    const noDragRegions = usePetNoDragRegions();
    const spritesheetSource = usePetSpritesheetSource(selectedPetPackage.source, DEFAULT_BUILT_IN_PET_ID);
    const { reactionState, triggerTapReaction } = useTapReactionState();
    const metrics = React.useMemo(
        () => resolvePetCompanionOverlayMetrics(localSettings.petsCompanionSizeScale),
        [localSettings.petsCompanionSizeScale],
    );

    const viewport = React.useMemo<PetCompanionViewportMetrics>(() => ({
        width: dimensions.width,
        height: dimensions.height,
        margin: PET_COMPANION_POSITION_DEFAULT_MARGIN_PT,
        keyboardHeight,
        safeAreaInsets,
    }), [dimensions.height, dimensions.width, keyboardHeight, safeAreaInsets]);

    const bounds = React.useMemo(() => resolvePetCompanionPositionBounds({
        viewport,
        petSize: { width: metrics.spriteWidth, height: metrics.spriteHeight },
    }), [metrics.spriteHeight, metrics.spriteWidth, viewport]);

    const initialPoint = React.useMemo<PetCompanionPoint>(() => denormalizePetCompanionPosition(
        parsePetCompanionPosition(localSettings.petsCompanionPosition),
        bounds,
    ), [bounds, localSettings.petsCompanionPosition]);

    const pan = usePetNativePanGesture({
        bounds,
        initialPoint,
        noDragRegions,
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
    const frame = usePetAnimatedFrame({ state: effectiveState, reducedMotion: reducedMotion || !appActive });

    if (!selectedPetPackage.enabled || !selectedPetPackage.source) {
        return null;
    }

    return (
        <GestureDetector gesture={pan.gesture}>
            <PetNativeAnimatedView
                pointerEvents="box-none"
                style={[
                    styles.root,
                    {
                        width: metrics.spriteWidth,
                        height: metrics.spriteHeight,
                    },
                    pan.animatedStyle,
                ]}
                testID="pet-app-shell-companion-root"
            >
                <PetCompanionState state={effectiveState}>
                    <Pressable
                        testID="pet-app-shell-companion-hitbox"
                        onPress={(event) => triggerTapReaction(event, pan.shouldSuppressPress)}
                        style={styles.hitbox}
                    >
                        <PetSprite
                            testID="pet-app-shell-companion-sprite"
                            frame={frame}
                            spritesheetSource={spritesheetSource}
                            scale={metrics.scale}
                        />
                    </Pressable>
                </PetCompanionState>
            </PetNativeAnimatedView>
        </GestureDetector>
    );
}

export function PetAppShellCompanionMount(): React.ReactElement {
    return (
        <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
            <PetNoDragRegionProvider>
                <NativePetCompanionLayer />
            </PetNoDragRegionProvider>
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
});
