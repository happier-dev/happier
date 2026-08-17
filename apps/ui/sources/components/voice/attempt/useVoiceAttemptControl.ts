import * as React from 'react';

import { useRouter } from 'expo-router';

import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { resolveVoiceStartAdmission } from '@/components/voice/surface/resolveVoiceStartAdmission';
import { resolveVoiceSurfaceRecovery } from '@/components/voice/surface/resolveVoiceSurfaceRecovery';
import { resolveVoiceSurfaceState } from '@/components/voice/surface/resolveVoiceSurfaceState';
import { resolveVoiceSurfaceStatusPresentation } from '@/components/voice/surface/resolveVoiceSurfaceStatusPresentation';
import { useVoiceInputSourceActive } from '@/components/voice/light/VoiceEnergyAppProvider';
import { voiceSurfaceHaptics } from '@/components/voice/surface/voiceSurfaceHaptics';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { storage, useSetting } from '@/sync/domains/state/storage';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { t } from '@/text';
import { resolveVoiceBindingBySessionId } from '@/voice/binding/resolveVoiceBindingBySessionId';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { resolveVoiceProviderIdForSurface } from '@/voice/settings/resolveVoiceProviderId';
import { useVoiceSessionSnapshot } from '@/voice/session/voiceSession';
import { resolveVoiceMicCaptureActive } from '@/voice/session/resolveVoiceMicCaptureActive';
import { voiceSessionManager } from '@/voice/session/voiceSession';
import { resolveVoiceAdapterSurfaceCapabilities } from '@/voice/session/voiceAdapterRegistry';

import {
    resolveVoiceAttemptActionability,
    resolveVoiceAttemptControl,
    type VoiceAttemptControl,
} from './resolveVoiceAttemptControl';

const voiceProviderRegistry = createDefaultVoiceProviderRegistry();

/**
 * The conversation a surface creates when **nothing is running** (§2.5).
 *
 * Stated by the caller, never inferred here: the orb and the New Session composer state `global`,
 * and the composer of an existing session states that exact session. It is *only* about starting.
 * Once an attempt exists its session binding is immutable and every surface mirrors and settles
 * that attempt, so this value never reaches a stop, a mute, or a recovery.
 */
export type VoiceAttemptIdleTarget =
    | Readonly<{ kind: 'global' }>
    | Readonly<{ kind: 'session'; sessionId: string }>;

/** The app-level target: no surface session, started through the canonical hidden owner. */
export const VOICE_ATTEMPT_IDLE_TARGET_GLOBAL: VoiceAttemptIdleTarget = Object.freeze({ kind: 'global' });

export type VoiceAttemptControlProjection = VoiceAttemptControl & Readonly<{
    /** Truthful transport semantics and copy, selected once for every placement. */
    primaryActionLabel: string | null;
    primaryActionHint: string | null;
    recoveryLabel: string | null;
    /** Placement-neutral, privacy-safe microphone status copy. */
    micStateLabel: string;
    /** The sheet caption selected from recovery and microphone status facts. */
    captionLabel: string;
    onPrimaryAction: () => void;
    /** Starts the caller's idle target when idle; ends the running attempt otherwise. Never re-targets. */
    onToggle: () => void;
    onToggleMute: () => void;
    /** The same canonical recovery dispatch Horizon uses. */
    onRecover: () => void;
    /**
     * The conversation a **session-bound** attempt is running in (§2.5), read from the canonical
     * binding. `null` for a global attempt, which has no conversation to return to, and `null`
     * while nothing is running.
     */
    openConversationSessionId: string | null;
    /**
     * Opens exactly that conversation.
     *
     * Read-and-navigate only: the binding owner decides what an attempt is bound to and the
     * lifecycle owner holds it immutable, so opening a conversation must not rebind, retarget, or
     * start anything.
     */
    onOpenConversation: () => void;
}>;

export type VoiceAttemptRecoveryProjectionOverride = Readonly<{
    label: string;
    onRecover: () => void;
}> | null;

/**
 * Composes a placement's richer recovery route without letting it re-select Start, End or Recover.
 * Horizon needs extra navigation context for some recovery kinds; the attempt projection remains
 * the one place that turns actionability into transport semantics.
 */
export function overrideVoiceAttemptRecoveryProjection(
    control: VoiceAttemptControlProjection,
    recovery: VoiceAttemptRecoveryProjectionOverride,
): VoiceAttemptControlProjection {
    const recoveryAvailable = recovery !== null;
    const { availability, primaryAction } = resolveVoiceAttemptActionability({
        canStart: control.canStart,
        canStop: control.canStop,
        recoveryAvailable,
    });
    const onRecover = recovery?.onRecover ?? (() => {});
    const recoveryLabel = recovery?.label ?? null;
    const captionLabel = recoveryLabel ?? control.micStateLabel;
    const primaryActionLabel = primaryAction === 'recover' ? recoveryLabel : control.primaryActionLabel;
    const primaryActionHint = primaryAction === 'recover' ? recovery?.label ?? null : control.primaryActionHint;
    const onPrimaryAction = primaryAction === 'recover' ? onRecover : control.onToggle;
    return {
        ...control,
        availability,
        primaryAction,
        primaryActionHint,
        primaryActionLabel,
        recoveryLabel,
        captionLabel,
        recoveryAvailable,
        onPrimaryAction,
        onRecover,
    };
}

/**
 * The single projection over the canonical Voice lifecycle that placement-free surfaces consume
 * (§2.5): the floating orb, the composer planet and the announcer.
 *
 * Deliberately absent: `ui.surfaceLocation` and `ui.scopeDefault`. Those are Horizon's placement
 * policy, and a floating companion that read them would delete itself whenever the user set the
 * Voice surface to "session". What replaces them is the caller's explicit `idleTarget` — this hook
 * infers a target from nothing at all.
 */
export function useVoiceAttemptControl(idleTarget: VoiceAttemptIdleTarget): VoiceAttemptControlProjection {
    const router = useRouter();
    const snap = useVoiceSessionSnapshot();
    const inputSourceActive = useVoiceInputSourceActive();
    const voice = useSetting('voice');
    const canonicalVoice = voiceSettingsParse(voice);
    const providerId = resolveVoiceProviderIdForSurface(canonicalVoice, voiceProviderRegistry) ?? 'off';
    const capabilities = resolveVoiceAdapterSurfaceCapabilities(providerId, voice);
    const voiceAgentFeatureEnabled = useFeatureEnabled('voice.agent');
    const surfaceState = resolveVoiceSurfaceState({
        status: snap.status,
        mode: snap.mode,
        errorPresentation: snap.errorPresentation,
        presentationState: snap.presentationState,
    });
    const recoveryAction = snap.errorRecoveryAction ?? null;
    const recovery = React.useMemo(
        () => resolveVoiceSurfaceRecovery(recoveryAction),
        [recoveryAction],
    );
    /*
     * The caller's stated target, normalized once (§2.5).
     *
     * A blank session id is a caller mistake, not an instruction to fall back to Global: it keeps
     * the session scope and simply fails admission, because silently starting a *different*
     * conversation from the one the surface named is exactly the retarget this contract forbids.
     */
    const bindingScope = idleTarget.kind === 'session' ? 'session' : 'global';
    const startSessionId = idleTarget.kind === 'session'
        ? (idleTarget.sessionId.trim() || null)
        : null;
    const startAdmission = resolveVoiceStartAdmission({
        // Never inherited from `ui.scopeDefault` or `ui.surfaceLocation`: those are Horizon's
        // placement policy, and a floating companion that read them would delete itself the
        // moment the user chose the session surface.
        bindingScope,
        // Same rule as `useVoiceSurfaceTargetState.ts:62-64`, read off the same canonical
        // capability. That hook is placement-aware, so the orb resolves the fact rather than
        // consuming the surface's target state.
        daemonLocalVoiceUnavailable:
            capabilities?.requiresVoiceAgentFeature === true && voiceAgentFeatureEnabled !== true,
        globalStartAuthorized: bindingScope === 'global' && capabilities?.allowsGlobalStart === true,
        providerId,
        providerSettings: voiceProviderRegistry.get(providerId)?.providerSettings ?? null,
        registry: voiceProviderRegistry,
        // `null` for the global target: a global start binds no surface session by definition.
        startSessionId,
        voiceSettings: canonicalVoice,
    });
    /*
     * §2.2's middle rung. A provider the user selected but has not finished connecting refuses the
     * start and publishes no `errorRecoveryAction` — nothing failed, because nothing was ever
     * attempted. Reading that as terminally unavailable removes the transport *and* the only
     * affordance that would fix it, which is how the orb came to vanish on a half-configured
     * provider instead of offering setup.
     *
     * The fact is read, not re-derived: `resolveVoiceProviderIdForSurface` deliberately keeps such
     * a provider visible for remediation, and `resolveVoiceStartAdmission` already returns the
     * unfinished connected-services binding as its own answer precisely because it is the one
     * refusal a surface acts on. A refusal with no declared setup behind it — a server feature the
     * settings screen cannot switch on — is not a setup the user can finish, and stays terminal.
     */
    const setupIncomplete = !startAdmission.connectedServicesBindingReady;
    const capturing = resolveVoiceMicCaptureActive({
        status: snap.status,
        inputSourceActive,
    });
    const control = React.useMemo(() => resolveVoiceAttemptControl({
        surfaceState,
        tone: resolveVoiceSurfaceStatusPresentation(surfaceState).tone,
        status: snap.status,
        sessionId: snap.sessionId ?? null,
        canStop: snap.canStop === true,
        muted: snap.micMuted === true,
        capturing,
        startAdmitted: startAdmission.canStart,
        hasRecovery: recovery !== null || setupIncomplete,
    }), [
        recovery,
        setupIncomplete,
        snap.canStop,
        snap.micMuted,
        snap.sessionId,
        snap.status,
        startAdmission.canStart,
        surfaceState,
        capturing,
    ]);

    const snapSessionId = snap.sessionId ?? null;
    const canStop = control.canStop;
    const canStart = control.canStart;
    const canMute = control.canMute;
    const muted = control.muted;

    const onToggle = React.useCallback(() => {
        if (canStop) {
            /*
             * The **running attempt's** session, never the idle target: a surface that stopped its
             * own target would leave a conversation it does not own still listening, and settle a
             * second one that never started.
             */
            const sessionId = snapSessionId?.trim() ?? '';
            if (!sessionId) return;
            voiceSurfaceHaptics.notify('start_stop');
            fireAndForget(voiceSessionManager.stop(sessionId), { tag: 'VoiceAttemptControl.stop' });
            return;
        }
        if (!canStart) return;
        // The caller's stated target. The empty session id is the canonical global/hidden-owner start.
        voiceSurfaceHaptics.notify('start_stop');
        fireAndForget(voiceSessionManager.toggle(startSessionId ?? ''), { tag: 'VoiceAttemptControl.toggle' });
    }, [canStart, canStop, snapSessionId, startSessionId]);

    const onToggleMute = React.useCallback(() => {
        const sessionId = snapSessionId?.trim() ?? '';
        if (!canMute || !sessionId) return;
        fireAndForget(voiceSessionManager.setMuted(sessionId, !muted), { tag: 'VoiceAttemptControl.mute' });
    }, [canMute, muted, snapSessionId]);

    const recoveryKind = recovery?.kind ?? null;
    const onRecover = React.useCallback(() => {
        if (recoveryKind === 'retry' || recoveryKind === 'reconnect') {
            fireAndForget(
                voiceSessionManager.toggle(snapSessionId?.trim() ?? ''),
                { tag: 'VoiceAttemptControl.recover' },
            );
            return;
        }
        if (recoveryKind === null && !setupIncomplete) return;
        // Every other recovery — and an unfinished setup, which is the same problem before it has
        // had a chance to fail — is owned by the Voice settings screen. One dispatch, not two.
        router.push(SETTINGS_ROUTES.voice as never);
    }, [recoveryKind, router, setupIncomplete, snapSessionId]);

    const recoveryLabel = control.recoveryAvailable
        ? t(recovery?.labelKey ?? 'modals.openSettings')
        : null;
    const micStateLabel = t(
        control.muted
            ? 'voiceSurface.a11y.microphoneMuted'
            : control.capturing
                ? 'voiceSurface.a11y.microphoneActive'
                : 'voiceSurface.a11y.microphoneInactive',
    );
    const captionLabel = recoveryLabel ?? micStateLabel;
    const primaryActionLabel = control.primaryAction === 'recover'
        ? recoveryLabel
        : control.primaryAction === 'end'
            ? t('voiceAssistant.endVoice')
            : control.primaryAction === 'start'
                ? t('voiceAssistant.startVoice')
                : null;
    const primaryActionHint = control.primaryAction === 'recover'
        ? primaryActionLabel
        : control.primaryAction === 'end'
            ? t('voiceSurface.orbEndHint')
            : control.primaryAction === 'start'
                ? t('voiceSurface.orbStartHint')
                : null;
    const onPrimaryAction = React.useCallback(() => {
        if (control.primaryAction === 'recover') {
            onRecover();
            return;
        }
        if (control.primaryAction === 'start' || control.primaryAction === 'end') onToggle();
    }, [control.primaryAction, onRecover, onToggle]);

    /*
     * Which conversation a running attempt belongs to.
     *
     * Both stores can change the answer on their own — a runtime `bind()` never touches storage —
     * so both are subscribed, and the answer is derived through the same canonical reader Horizon
     * uses (`resolveVoiceBindingBySessionId`) rather than re-implemented here. The read is cached on
     * the two store identities plus the attempt's own identity, so an unrelated session write costs
     * three reference comparisons instead of a walk over every persisted binding.
     */
    const snapAdapterId = snap.adapterId ?? null;
    const subscribeBindingSources = React.useCallback((notify: () => void) => {
        const unsubscribeSessions = storage.subscribe(notify);
        const unsubscribeBindings = voiceSessionBindingStore.subscribe(notify);
        return () => {
            unsubscribeSessions();
            unsubscribeBindings();
        };
    }, []);
    const bindingCacheRef = React.useRef<Readonly<{
        sessions: unknown;
        bindings: unknown;
        controlSessionId: string;
        adapterId: string | null;
        value: string | null;
    }> | null>(null);
    const readOpenConversationSessionId = React.useCallback((): string | null => {
        const controlSessionId = snapSessionId?.trim() ?? '';
        const sessions = storage.getState();
        const bindings = voiceSessionBindingStore.getState();
        const cached = bindingCacheRef.current;
        if (
            cached
            && cached.sessions === sessions
            && cached.bindings === bindings
            && cached.controlSessionId === controlSessionId
            && cached.adapterId === snapAdapterId
        ) {
            return cached.value;
        }
        const binding = controlSessionId
            ? resolveVoiceBindingBySessionId({ sessionId: controlSessionId, adapterId: snapAdapterId })
            : null;
        // A global attempt is bound to no session, so there is nothing to return to; only an
        // attempt with a target session has a conversation the user came from.
        const value = binding && binding.targetSessionId ? binding.conversationSessionId : null;
        bindingCacheRef.current = {
            sessions,
            bindings,
            controlSessionId,
            adapterId: snapAdapterId,
            value,
        };
        return value;
    }, [snapAdapterId, snapSessionId]);
    const openConversationSessionId = React.useSyncExternalStore(
        subscribeBindingSources,
        readOpenConversationSessionId,
        readOpenConversationSessionId,
    );

    const onOpenConversation = React.useCallback(() => {
        if (!openConversationSessionId) return;
        router.push(`/session/${openConversationSessionId}` as never);
    }, [openConversationSessionId, router]);

    return React.useMemo(
        () => ({
            ...control,
            onToggle,
            onToggleMute,
            onRecover,
            primaryActionLabel,
            primaryActionHint,
            recoveryLabel,
            micStateLabel,
            captionLabel,
            onPrimaryAction,
            openConversationSessionId,
            onOpenConversation,
        }),
        [
            control,
            onOpenConversation,
            onPrimaryAction,
            onRecover,
            onToggle,
            onToggleMute,
            openConversationSessionId,
            primaryActionHint,
            primaryActionLabel,
            recoveryLabel,
            micStateLabel,
            captionLabel,
        ],
    );
}
