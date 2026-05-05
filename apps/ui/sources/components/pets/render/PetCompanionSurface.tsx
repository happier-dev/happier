import * as React from 'react';
import {
    Platform,
    Pressable,
    StyleSheet,
    type GestureResponderEvent,
    type PressableProps,
    type View,
    type StyleProp,
    type ViewStyle,
} from 'react-native';

import {
    type PetAnimationStateV1,
} from '@happier-dev/protocol';
import type { ImageProps } from 'expo-image';

import {
    PET_TAP_REACTION_DURATION_MS,
} from '@/components/pets/animation/petAnimationPlaybackConfig';
import { resolvePetAnimationStateDurationMs } from '@/components/pets/animation/resolvePetAnimationTimeline';
import { PetCompanionState } from '@/components/pets/render/PetCompanionState';
import { PetSprite } from '@/components/pets/render/PetSprite';
import { usePetAnimatedFrame } from '@/components/pets/render/usePetAnimatedFrame';

const PET_TAP_REACTION_STATE = 'jumping' satisfies PetAnimationStateV1;
const PET_AMBIENT_ACTION_STATES = ['waving', 'waiting'] as const satisfies readonly PetAnimationStateV1[];
const PET_AMBIENT_ACTION_MIN_DELAY_MS = 8_000;
const PET_AMBIENT_ACTION_MAX_DELAY_MS = 18_000;

export type PetCompanionSurfaceProps = Readonly<{
    state: PetAnimationStateV1;
    spritesheetSource?: ImageProps['source'];
    scale?: number;
    reducedMotion?: boolean;
    active?: boolean;
    stateStyle?: StyleProp<ViewStyle>;
    spriteTestID: string;
    hitboxTestID: string;
    dragTargetRef?: React.Ref<View>;
    pointerHandlers?: Readonly<{ onPointerDown?: (event: unknown) => void }>;
    accessibilityLabel?: string;
    onActivate?: () => void | Promise<void>;
    shouldSuppressPress?: () => boolean;
}>;

function resolveAmbientActionDelayMs(): number {
    const spanMs = PET_AMBIENT_ACTION_MAX_DELAY_MS - PET_AMBIENT_ACTION_MIN_DELAY_MS;
    return PET_AMBIENT_ACTION_MIN_DELAY_MS + Math.floor(Math.random() * spanMs);
}

function resolveAmbientActionState(): PetAnimationStateV1 {
    const index = Math.min(
        PET_AMBIENT_ACTION_STATES.length - 1,
        Math.floor(Math.random() * PET_AMBIENT_ACTION_STATES.length),
    );
    return PET_AMBIENT_ACTION_STATES[index] ?? PET_AMBIENT_ACTION_STATES[0];
}

function useAmbientPetState(params: Readonly<{
    baseState: PetAnimationStateV1;
    reducedMotion: boolean;
}>): PetAnimationStateV1 | null {
    const [ambientState, setAmbientState] = React.useState<PetAnimationStateV1 | null>(null);
    const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    React.useEffect(() => {
        const clearAmbientTimeout = () => {
            if (timeoutRef.current) {
                clearTimeout(timeoutRef.current);
                timeoutRef.current = null;
            }
        };
        clearAmbientTimeout();
        setAmbientState(null);

        if (params.reducedMotion || params.baseState !== 'idle') return clearAmbientTimeout;

        let cancelled = false;
        const scheduleNextAmbientAction = () => {
            timeoutRef.current = setTimeout(() => {
                if (cancelled) return;
                const nextState = resolveAmbientActionState();
                setAmbientState(nextState);
                timeoutRef.current = setTimeout(() => {
                    if (cancelled) return;
                    setAmbientState(null);
                    scheduleNextAmbientAction();
                }, resolvePetAnimationStateDurationMs(nextState));
            }, resolveAmbientActionDelayMs());
        };

        scheduleNextAmbientAction();

        return () => {
            cancelled = true;
            clearAmbientTimeout();
        };
    }, [params.baseState, params.reducedMotion]);

    return ambientState;
}

export function PetCompanionSurface(props: PetCompanionSurfaceProps): React.ReactElement {
    const shouldSuppressPress = props.shouldSuppressPress;
    const onActivate = props.onActivate;
    const [reactionState, setReactionState] = React.useState<PetAnimationStateV1 | null>(null);
    const reactionTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const reducedMotion = props.reducedMotion === true;
    const active = props.active !== false;
    const ambientState = useAmbientPetState({
        baseState: props.state,
        reducedMotion: reducedMotion || !active,
    });
    const effectiveState = reactionState ?? ambientState ?? props.state;
    const frame = usePetAnimatedFrame({
        state: effectiveState,
        reducedMotion,
        active,
    });
    const webPointerHandlers: { onPointerDown?: (event: unknown) => void } =
        Platform.OS === 'web' && props.pointerHandlers?.onPointerDown
            ? { onPointerDown: props.pointerHandlers.onPointerDown }
            : {};
    const hitboxDataProps = {
        dataSet: {
            petMascot: 'true',
            avatarMascot: 'true',
            avatarOverlayHitRegion: 'true',
        },
        'data-pet-mascot': 'true',
        'data-avatar-mascot': 'true',
        'data-avatar-overlay-hit-region': 'true',
    } satisfies Partial<PressableProps> & Record<string, unknown>;

    React.useEffect(() => () => {
        if (reactionTimeoutRef.current) {
            clearTimeout(reactionTimeoutRef.current);
        }
    }, []);

    const triggerTapReaction = React.useCallback((event: GestureResponderEvent) => {
        if (shouldSuppressPress?.()) {
            event.preventDefault?.();
            event.stopPropagation?.();
            return;
        }
        if (props.state !== 'idle' && ambientState == null && reactionState == null) {
            event.preventDefault?.();
            event.stopPropagation?.();
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
        void onActivate?.();
    }, [ambientState, onActivate, props.state, reactionState, shouldSuppressPress]);

    return (
        <PetCompanionState state={effectiveState} style={props.stateStyle}>
            <Pressable
                {...hitboxDataProps}
                {...webPointerHandlers}
                ref={props.dragTargetRef}
                testID={props.hitboxTestID}
                accessibilityRole="button"
                accessibilityLabel={props.accessibilityLabel}
                onPress={triggerTapReaction}
                style={styles.hitbox}
            >
                <PetSprite
                    testID={props.spriteTestID}
                    frame={frame}
                    spritesheetSource={props.spritesheetSource}
                    scale={props.scale}
                />
            </Pressable>
        </PetCompanionState>
    );
}

const styles = StyleSheet.create({
    hitbox: {
        backgroundColor: 'transparent',
    } satisfies ViewStyle,
});
