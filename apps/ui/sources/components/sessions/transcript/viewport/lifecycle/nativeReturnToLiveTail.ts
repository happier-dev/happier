import type { TranscriptViewportLifecycleEffect } from './lifecycle';
import {
    resolveNativeSettledReturnAnchorCaptureEffects,
    type NativeSettledReturnAnchorCaptureEffect,
} from './nativeSettledReturnAnchorCapture';

type NativeReturnViewportChangeEffect = Extract<
    TranscriptViewportLifecycleEffect,
    { type: 'viewport-change' }
>;

type NativeReturnDrainEffect = Extract<
    TranscriptViewportLifecycleEffect,
    { type: 'drain-deferred-newer' }
>;

export type NativeReturnToLiveTailApplyEffect =
    | Readonly<{
        distanceFromLiveTailPx: number;
        sessionId: string;
        type: 'adopt-native-return-to-live-tail';
    }>
    | Readonly<{
        distanceFromLiveTailPx: number;
        isPinned: boolean;
        sessionId: string;
        type: 'drain-native-return-to-live-tail';
    }>;

export type NativeSettledReturnToLiveTailReturnEffect =
    | Readonly<{
        distanceFromLiveTailPx: number;
        sessionId: string;
        type: 'adopt-native-settled-return-to-live-tail';
    }>
    | NativeSettledReturnAnchorCaptureEffect;

export type NativeSettledReturnToLiveTailDrainEffect = Readonly<{
    distanceFromLiveTailPx: number;
    isPinned: boolean;
    sessionId: string;
    type: 'drain-native-settled-return-to-live-tail';
}>;

export type NativeSettledReturnToLiveTailApplyEffects = Readonly<{
    drainEffects: readonly NativeSettledReturnToLiveTailDrainEffect[];
    returnEffects: readonly NativeSettledReturnToLiveTailReturnEffect[];
}>;

export function resolveNativeReturnToLiveTailApplyEffects(params: Readonly<{
    effects: readonly TranscriptViewportLifecycleEffect[];
    sessionId: string;
}>): readonly NativeReturnToLiveTailApplyEffect[] {
    const applyEffects: NativeReturnToLiveTailApplyEffect[] = [];
    for (const effect of params.effects) {
        if (effect.sessionId !== params.sessionId) continue;
        if (effect.type === 'viewport-change') {
            const viewportChangeEffect: NativeReturnViewportChangeEffect = effect;
            applyEffects.push({
                distanceFromLiveTailPx: viewportChangeEffect.distanceFromLiveTailPx,
                sessionId: viewportChangeEffect.sessionId,
                type: 'adopt-native-return-to-live-tail',
            });
            continue;
        }
        if (effect.type === 'drain-deferred-newer') {
            const drainEffect: NativeReturnDrainEffect = effect;
            applyEffects.push({
                distanceFromLiveTailPx: drainEffect.distanceFromLiveTailPx,
                isPinned: drainEffect.isPinned,
                sessionId: drainEffect.sessionId,
                type: 'drain-native-return-to-live-tail',
            });
        }
    }
    return applyEffects;
}

export function resolveNativeSettledReturnToLiveTailApplyEffects(params: Readonly<{
    effects: readonly TranscriptViewportLifecycleEffect[];
    sessionId: string;
}>): NativeSettledReturnToLiveTailApplyEffects {
    const returnEffects: NativeSettledReturnToLiveTailReturnEffect[] = [];
    const drainEffects: NativeSettledReturnToLiveTailDrainEffect[] = [];

    for (const effect of params.effects) {
        if (effect.sessionId !== params.sessionId) continue;
        if (effect.type === 'viewport-change') {
            const viewportChangeEffect: NativeReturnViewportChangeEffect = effect;
            returnEffects.push({
                distanceFromLiveTailPx: viewportChangeEffect.distanceFromLiveTailPx,
                sessionId: viewportChangeEffect.sessionId,
                type: 'adopt-native-settled-return-to-live-tail',
            });
            returnEffects.push(...resolveNativeSettledReturnAnchorCaptureEffects({
                sessionId: viewportChangeEffect.sessionId,
            }));
            continue;
        }
        if (effect.type === 'drain-deferred-newer') {
            const drainEffect: NativeReturnDrainEffect = effect;
            drainEffects.push({
                distanceFromLiveTailPx: drainEffect.distanceFromLiveTailPx,
                isPinned: drainEffect.isPinned,
                sessionId: drainEffect.sessionId,
                type: 'drain-native-settled-return-to-live-tail',
            });
        }
    }

    return { drainEffects, returnEffects };
}
