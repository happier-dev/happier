import type { TranscriptViewportLifecycleEffect } from './lifecycle';

type LifecycleEffectOf<TType extends TranscriptViewportLifecycleEffect['type']> =
    Extract<TranscriptViewportLifecycleEffect, { type: TType }>;

type SessionEntryRenderResetSharedEffects = Readonly<{
    activityKeyBaselineReset: LifecycleEffectOf<'session-entry-activity-key-baseline-reset'>;
    commandControllerReset: LifecycleEffectOf<'session-entry-command-controller-reset'>;
    entryRestoreActiveRefsReset: LifecycleEffectOf<'session-entry-entry-restore-active-refs-reset'>;
    entryRestoreAnchorLookupReset: LifecycleEffectOf<'session-entry-entry-restore-anchor-lookup-reset'>;
    entryRestoreLocalStateReset: LifecycleEffectOf<'session-entry-entry-restore-local-state-reset'>;
    entryRestoreTimeoutCleanup: LifecycleEffectOf<'session-entry-entry-restore-timeout-cleanup'>;
    measurementReset: LifecycleEffectOf<'session-entry-measurement-reset'>;
    nativeEntrySettleReset: LifecycleEffectOf<'session-entry-native-entry-settle-confirmation-reset'>;
    nativeExplicitJumpReset: LifecycleEffectOf<'session-entry-native-explicit-jump-confirmation-reset'>;
    nativeGestureMomentumMirrorReset: LifecycleEffectOf<'session-entry-native-gesture-momentum-mirror-reset'>;
    nativeIndexScrollCommandCacheReset: LifecycleEffectOf<'session-entry-native-index-scroll-command-cache-reset'>;
    nativePrependInvalidation: LifecycleEffectOf<'session-entry-native-prepend-transaction-invalidation'>;
    olderPaginationReset: LifecycleEffectOf<'session-entry-older-pagination-reset'>;
    webDomObservationReset: LifecycleEffectOf<'session-entry-web-dom-observation-reset'>;
}>;

export type SessionEntryRenderResetEffects =
    | Readonly<SessionEntryRenderResetSharedEffects & {
        nativeSessionViewportReset: LifecycleEffectOf<'session-entry-native-session-viewport-reset'>;
        platform: 'native';
    }>
    | Readonly<SessionEntryRenderResetSharedEffects & {
        nativeSessionViewportReset: null;
        platform: 'web';
    }>;

function findRequiredEffect<TType extends TranscriptViewportLifecycleEffect['type']>(
    effects: readonly TranscriptViewportLifecycleEffect[],
    type: TType,
    sessionId: string,
    errorMessage: string,
): LifecycleEffectOf<TType> {
    const effect = effects.find((candidate): candidate is LifecycleEffectOf<TType> => (
        candidate.type === type &&
        candidate.sessionId === sessionId
    ));
    if (!effect) {
        throw new Error(errorMessage);
    }
    return effect;
}

export function resolveSessionEntryRenderResetEffects(params: Readonly<{
    effects: readonly TranscriptViewportLifecycleEffect[];
    platform: 'native' | 'web';
    sessionId: string;
}>): SessionEntryRenderResetEffects {
    const shared: SessionEntryRenderResetSharedEffects = {
        activityKeyBaselineReset: findRequiredEffect(
            params.effects,
            'session-entry-activity-key-baseline-reset',
            params.sessionId,
            'Session-entry lifecycle did not emit activity-key baseline reset effect',
        ),
        commandControllerReset: findRequiredEffect(
            params.effects,
            'session-entry-command-controller-reset',
            params.sessionId,
            'Session-entry lifecycle did not emit command-controller reset effect',
        ),
        entryRestoreActiveRefsReset: findRequiredEffect(
            params.effects,
            'session-entry-entry-restore-active-refs-reset',
            params.sessionId,
            'Session-entry lifecycle did not emit entry restore active-refs reset effect',
        ),
        entryRestoreAnchorLookupReset: findRequiredEffect(
            params.effects,
            'session-entry-entry-restore-anchor-lookup-reset',
            params.sessionId,
            'Session-entry lifecycle did not emit entry-restore anchor lookup reset effect',
        ),
        entryRestoreLocalStateReset: findRequiredEffect(
            params.effects,
            'session-entry-entry-restore-local-state-reset',
            params.sessionId,
            'Session-entry lifecycle did not emit entry restore local-state reset effect',
        ),
        entryRestoreTimeoutCleanup: findRequiredEffect(
            params.effects,
            'session-entry-entry-restore-timeout-cleanup',
            params.sessionId,
            'Session-entry lifecycle did not emit entry restore timeout cleanup effect',
        ),
        measurementReset: findRequiredEffect(
            params.effects,
            'session-entry-measurement-reset',
            params.sessionId,
            'Session-entry lifecycle did not emit measurement reset effect',
        ),
        nativeEntrySettleReset: findRequiredEffect(
            params.effects,
            'session-entry-native-entry-settle-confirmation-reset',
            params.sessionId,
            'Session-entry lifecycle did not emit native entry settle confirmation reset effect',
        ),
        nativeExplicitJumpReset: findRequiredEffect(
            params.effects,
            'session-entry-native-explicit-jump-confirmation-reset',
            params.sessionId,
            'Session-entry lifecycle did not emit native explicit jump confirmation reset effect',
        ),
        nativeGestureMomentumMirrorReset: findRequiredEffect(
            params.effects,
            'session-entry-native-gesture-momentum-mirror-reset',
            params.sessionId,
            'Session-entry lifecycle did not emit native gesture/momentum mirror reset effect',
        ),
        nativeIndexScrollCommandCacheReset: findRequiredEffect(
            params.effects,
            'session-entry-native-index-scroll-command-cache-reset',
            params.sessionId,
            'Session-entry lifecycle did not emit native index-scroll command cache reset effect',
        ),
        nativePrependInvalidation: findRequiredEffect(
            params.effects,
            'session-entry-native-prepend-transaction-invalidation',
            params.sessionId,
            'Session-entry lifecycle did not emit native prepend transaction invalidation effect',
        ),
        olderPaginationReset: findRequiredEffect(
            params.effects,
            'session-entry-older-pagination-reset',
            params.sessionId,
            'Session-entry lifecycle did not emit older pagination reset effect',
        ),
        webDomObservationReset: findRequiredEffect(
            params.effects,
            'session-entry-web-dom-observation-reset',
            params.sessionId,
            'Session-entry lifecycle did not emit web DOM observation reset effect',
        ),
    };

    if (params.platform === 'native') {
        return {
            ...shared,
            nativeSessionViewportReset: findRequiredEffect(
                params.effects,
                'session-entry-native-session-viewport-reset',
                params.sessionId,
                'Session-entry lifecycle did not emit native session viewport reset effect',
            ),
            platform: 'native',
        };
    }

    return {
        ...shared,
        nativeSessionViewportReset: null,
        platform: 'web',
    };
}
