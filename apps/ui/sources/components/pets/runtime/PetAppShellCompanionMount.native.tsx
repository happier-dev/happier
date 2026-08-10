import * as React from 'react';
import {
    Pressable,
    View,
    useWindowDimensions,
    type GestureResponderEvent,
    type ViewStyle,
} from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';

import { type PetAnimationStateV1 } from '@happier-dev/protocol';

import {
    PET_TAP_REACTION_DURATION_MS,
    PET_TAP_REACTION_HAPTIC,
} from '@/components/pets/animation/petAnimationPlaybackConfig';
import {
    usePetCompanionActivityModel,
    usePetCompanionTrayDismissals,
    type PetCompanionActivityModel,
    type PetCompanionTrayItem,
} from '@/components/pets/activity';
import { DEFAULT_BUILT_IN_PET_ID } from '@/components/pets/builtIns/builtInPetRegistry';
import {
    openDesktopPetOverlayTrayItem,
    sendDesktopPetOverlayQuickReply,
} from '@/components/pets/desktop/actions/desktopPetOverlayActions';
import {
    resolveDesktopPetOverlayGeometry,
} from '@/components/pets/desktop/desktopPetOverlayGeometry';
import { PetNativeAnimatedView, usePetNativePanGesture } from '@/components/pets/interaction/usePetNativePanGesture';
import { PetNoDragRegion, PetNoDragRegionProvider, usePetNoDragRegions } from '@/components/pets/interaction/PetNoDragRegion';
import { PetCompanionState } from '@/components/pets/render/PetCompanionState';
import { resolvePetCompanionOverlayMetrics } from '@/components/pets/render/petCompanionDisplayMetrics';
import { PetSprite } from '@/components/pets/render/PetSprite.native';
import { usePetAnimatedFrame } from '@/components/pets/render/usePetAnimatedFrame';
import { usePetSpritesheetSource } from '@/components/pets/render/usePetSpritesheetSource';
import { useSelectedPetPackage } from '@/components/pets/source/useSelectedPetPackage';
import type { SelectedPetPackageSource } from '@/components/pets/source/resolveSelectedPetPackage';
import { PetCompanionActivityTray } from '@/components/pets/tray/PetCompanionActivityTray';
import { shouldAnimateNativePetCompanionFrame } from './nativePetFrameAnimationPolicy';
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
import { useRuntimeActive } from '@/hooks/runtime/useRuntimeActive';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

const PET_TAP_REACTION_STATE = 'jumping' satisfies PetAnimationStateV1;
const PET_TAP_REACTION_HAPTIC_STYLE: Record<typeof PET_TAP_REACTION_HAPTIC, Haptics.ImpactFeedbackStyle> = {
    light: Haptics.ImpactFeedbackStyle.Light,
};

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
    appActive: boolean;
    animate: boolean;
    spritesheetSource: ReturnType<typeof usePetSpritesheetSource>;
    scale: number;
}>): React.ReactElement {
    const frame = usePetAnimatedFrame({
        state: props.state,
        reducedMotion: props.reducedMotion || !props.appActive,
        active: props.animate,
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

type NativePetCompanionInteractiveLayerProps = Readonly<{
    activity: PetCompanionActivityModel;
    appActive: boolean;
    applyLocalSettings: ReturnType<typeof useApplyLocalSettings>;
    dimensions: ReturnType<typeof useWindowDimensions>;
    dismissTrayItem: (item: PetCompanionTrayItem) => void;
    keyboardHeight: number;
    petsCompanionPosition: ReturnType<typeof useLocalSetting<'petsCompanionPosition'>>;
    petsCompanionSizeScale: ReturnType<typeof useLocalSetting<'petsCompanionSizeScale'>>;
    reducedMotion: boolean;
    safeAreaInsets: ReturnType<typeof useSafeAreaInsets>;
    spritesheetSource: ReturnType<typeof usePetSpritesheetSource>;
}>;

const NativePetCompanionInteractiveLayer = React.memo(function NativePetCompanionInteractiveLayer(
    props: NativePetCompanionInteractiveLayerProps,
): React.ReactElement {
    const [trayOpen, setTrayOpen] = React.useState(false);
    const noDragRegions = usePetNoDragRegions();
    const { reactionState, triggerTapReaction } = useTapReactionState();
    const metrics = React.useMemo(
        () => resolvePetCompanionOverlayMetrics(props.petsCompanionSizeScale),
        [props.petsCompanionSizeScale],
    );
    const geometry = React.useMemo(
        () => resolveDesktopPetOverlayGeometry(props.petsCompanionSizeScale),
        [props.petsCompanionSizeScale],
    );
    const trayItemCount = props.activity.trayItems.length;
    const hasTrayItems = trayItemCount > 0;
    const rootWidth = hasTrayItems ? geometry.expandedWindowWidth : metrics.spriteWidth;
    const rootHeight = hasTrayItems ? geometry.expandedWindowHeight : metrics.spriteHeight;
    const actionExecutor = React.useMemo(() => createDefaultActionExecutor(), []);

    React.useEffect(() => {
        setTrayOpen((current) => {
            if (trayItemCount === 0) return false;
            return current || trayItemCount > 0;
        });
    }, [trayItemCount]);

    const viewport = React.useMemo<PetCompanionViewportMetrics>(() => ({
        width: props.dimensions.width,
        height: props.dimensions.height,
        margin: PET_COMPANION_POSITION_DEFAULT_MARGIN_PT,
        keyboardHeight: props.keyboardHeight,
        safeAreaInsets: props.safeAreaInsets,
    }), [props.dimensions.height, props.dimensions.width, props.keyboardHeight, props.safeAreaInsets]);

    const bounds = React.useMemo(() => resolvePetCompanionPositionBounds({
        viewport,
        petSize: { width: rootWidth, height: rootHeight },
    }), [rootHeight, rootWidth, viewport]);

    const initialPoint = React.useMemo<PetCompanionPoint>(() => denormalizePetCompanionPosition(
        parsePetCompanionPosition(props.petsCompanionPosition),
        bounds,
    ), [bounds, props.petsCompanionPosition]);
    const handlePositionChange = React.useCallback(({ point }: Readonly<{
        point: PetCompanionPoint;
    }>) => {
        props.applyLocalSettings({
            petsCompanionPosition: createStoredPetCompanionPosition({
                surface: 'mobile-app-shell',
                point,
                bounds,
                viewport,
            }),
        });
    }, [props.applyLocalSettings, bounds, viewport]);

    const pan = usePetNativePanGesture({
        bounds,
        initialPoint,
        noDragRegions,
        onPositionChange: handlePositionChange,
    });
    const effectiveState = reactionState ?? pan.dragState ?? props.activity.state;
    const animateFrame = shouldAnimateNativePetCompanionFrame({
        dragState: pan.dragState,
        reactionState,
    });
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

    return (
        <GestureDetector gesture={pan.gesture}>
            <PetNativeAnimatedView
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
                    <PetNoDragRegion
                        testID="pet-app-shell-companion-tray-no-drag-region"
                        style={[
                            styles.trayNoDragRegion,
                            { bottom: geometry.windowHeight + 18 },
                        ]}
                    >
                        <PetCompanionActivityTray
                            items={props.activity.trayItems}
                            open={trayOpen}
                            onOpenItem={handleOpenTrayItem}
                            onDismissItem={props.dismissTrayItem}
                            onQuickReply={handleQuickReply}
                        />
                    </PetNoDragRegion>
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
                            reducedMotion={props.reducedMotion}
                            appActive={props.appActive}
                            animate={animateFrame}
                            spritesheetSource={props.spritesheetSource}
                            scale={metrics.scale}
                        />
                    </Pressable>
                </PetCompanionState>
            </PetNativeAnimatedView>
        </GestureDetector>
    );
});

function NativePetCompanionLayer(): React.ReactElement | null {
    const selectedPetPackage = useSelectedPetPackage();

    if (!selectedPetPackage.enabled || !selectedPetPackage.source) {
        return null;
    }

    return <NativePetCompanionActivityLayer source={selectedPetPackage.source} />;
}

function NativePetCompanionActivityLayer(props: Readonly<{
    source: SelectedPetPackageSource;
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
    const appActive = useRuntimeActive();
    const spritesheetSource = usePetSpritesheetSource(props.source, DEFAULT_BUILT_IN_PET_ID);

    return (
        <NativePetCompanionInteractiveLayer
            activity={activity}
            appActive={appActive}
            applyLocalSettings={applyLocalSettings}
            dimensions={dimensions}
            dismissTrayItem={dismissTrayItem}
            keyboardHeight={keyboardHeight}
            petsCompanionPosition={petsCompanionPosition}
            petsCompanionSizeScale={petsCompanionSizeScale}
            reducedMotion={reducedMotion}
            safeAreaInsets={safeAreaInsets}
            spritesheetSource={spritesheetSource}
        />
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
    stateCompact: {
        position: 'absolute',
        left: 0,
        top: 0,
    } satisfies ViewStyle,
    stateExpanded: {
        position: 'absolute',
        right: 36,
        bottom: 18,
        alignItems: 'center',
        justifyContent: 'center',
    } satisfies ViewStyle,
    trayNoDragRegion: {
        position: 'absolute',
        right: 58,
    } satisfies ViewStyle,
});
