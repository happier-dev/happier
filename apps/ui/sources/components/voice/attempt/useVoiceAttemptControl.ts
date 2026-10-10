import * as React from 'react';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Platform } from 'react-native';

import { resolveVoiceConnectRecoveryTarget } from '@/components/voice/surface/resolveVoiceConnectRecoveryTarget';
import {
    resolveCurrentVoiceRuntimePlatform,
    resolveVoiceStartAdmission,
} from '@/components/voice/surface/resolveVoiceStartAdmission';
import { resolveVoiceSurfaceRecovery } from '@/components/voice/surface/resolveVoiceSurfaceRecovery';
import { resolveVoiceSurfaceState, type VoiceSurfaceState } from '@/components/voice/surface/resolveVoiceSurfaceState';
import { resolveVoiceSurfaceStatusPresentation } from '@/components/voice/surface/resolveVoiceSurfaceStatusPresentation';
import { useStoreSnapshot } from '@/components/voice/surface/useStoreSnapshot';
import { useVoiceInputSourceActive } from '@/components/voice/light/VoiceEnergyAppProvider';
import { voiceSurfaceHaptics } from '@/components/voice/surface/voiceSurfaceHaptics';
import { useProjectedConnectedServicesRegistry, useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { normalizeSessionAddress, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { storage, useActiveServerAccountScope, useSession, useSetting } from '@/sync/domains/state/storage';
import { readVoiceProviderSettingsConfig, voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { useSessionStatus } from '@/utils/sessions/sessionUtils';
import {
    canDismissVoiceSessionFailedAttempt,
    dismissVoiceSessionEndedAttempt,
    getVoiceSessionAttemptStartedAt,
    getVoiceSessionPresentedAttemptId,
    getVoiceSessionArrivedAttemptId,
    getVoiceSessionEndedAttempt,
    subscribeToVoiceSessionEndedAttempt,
    type VoiceSessionEndedAttempt,
} from '@/voice/session/voiceSessionStore';
import { useNavigationFocusReturn } from '@/utils/navigation/useNavigationFocusReturn';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { t, tLoose } from '@/text';
import { resolveVoiceServiceTitle } from '@/voice/registry/voiceProviderPresentation';
import { translateVoiceReadiness } from '@/voice/settings/panels/voiceProviderReadinessPresentation';
import { useVoiceExecutionMachinePresentation } from '@/voice/credentials/useExecutionMachinePresentation';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { resolveVoiceBindingBySessionId } from '@/voice/binding/resolveVoiceBindingBySessionId';
import { resolveVoiceConversationNavigationAddress } from '@/voice/binding/resolveVoiceConversationNavigationAddress';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { useVoiceSetupDismissed } from '@/voice/settings/setup/useVoiceSetupItem';
import { resolveVoiceMarkEvent, type VoiceMarkEvent } from '@/components/voice/presence/resolveVoiceMarkPose';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { useVoiceProviderRegistryRevision } from '@/voice/registry/useVoiceProviderRegistryRevision';
import { resolveVoicePresentedProviderId } from '@/voice/settings/resolveVoiceProviderId';
import { useVoiceSessionSnapshot } from '@/voice/session/voiceSession';
import { resolveVoiceMicCaptureActive } from '@/voice/session/resolveVoiceMicCaptureActive';
import { voiceSessionManager } from '@/voice/session/voiceSession';
import { resolveVoiceAdapterSurfaceCapabilities } from '@/voice/session/voiceAdapterRegistry';
import type { VoiceHeldInput } from '@/voice/runtime/controller/VoiceConversationController';
import { useFocusedSessionAddress } from '@/sync/domains/session/sessionSurfaceVisibility';
import { resolveVoiceIdleTarget, useVoiceTargetStore, type VoiceStartIntent } from '@/voice/runtime/voiceTargetStore';
import { isVoiceMachineErrorKind } from '@/voice/runtime/machine/voiceMachineError';
import { resolveVoiceMachineErrorTranslationKey } from '@/voice/runtime/machine/voiceMachineErrorCopy';

import {
    resolveVoiceAttemptControl,
    type VoiceAttemptControl,
} from './resolveVoiceAttemptControl';
import {
    createVoiceAttemptRecoveryDispatch,
    resolveVoiceAttemptRecoveryAvailable,
    resolveVoiceAttemptRecoveryRuntimeTarget,
    type VoiceAttemptRecoveryRuntimeTarget,
} from './voiceAttemptRecovery';

type OpenConversationTarget = Readonly<{ address: SessionAddress | null }>;

const voiceProviderRegistry = createDefaultVoiceProviderRegistry();

/**
 * The conversation a surface creates when **nothing is running** (§2.5).
 *
 * Shell/shortcut consumers use the default policy; Home/New Session and existing-session composers
 * state their explicit intent. It is *only* about starting.
 * Once an attempt exists its session binding is immutable and every surface mirrors and settles
 * that attempt, so this value never reaches a stop, a mute, or a recovery.
 */
export type VoiceAttemptIdleTarget = VoiceStartIntent;

/** The app-level target: no surface session, started through the canonical hidden owner. */
const VOICE_CONVERSING_SURFACE_STATES: ReadonlySet<VoiceSurfaceState> = new Set<VoiceSurfaceState>([
    'listening',
    'transcribing',
    'thinking',
    'speaking',
    'interrupted',
]);

export const VOICE_ATTEMPT_IDLE_TARGET_GLOBAL: VoiceAttemptIdleTarget = Object.freeze({ kind: 'global' });
export const VOICE_ATTEMPT_IDLE_TARGET_DEFAULT: VoiceAttemptIdleTarget = Object.freeze({ kind: 'default' });

export type VoiceAttemptControlProjection = VoiceAttemptControl & Readonly<{
    statusWord: string;
    statusLabel: string;
    elapsedStartedAt: number | null;
    canHoldToTalk: boolean;
    beginHoldToTalk: () => VoiceHeldInput | null;
    /**
     * The conversation that just ended cleanly (the lifecycle's own active → disconnected fact), while
     * nothing runs; presenters show "Voice ended" from it until the next start or a dismiss.
     */
    ended?: VoiceSessionEndedAttempt | null;
    /** Puts the ended conversation away (never touches a running attempt). */
    onDismissEnded?: () => void;
    /** The attempt's one-shot continuation event for the mark (leave / arrive). Omitted by static previews. */
    markEvent?: VoiceMarkEvent | null;
    /** Acknowledges a terminal failure through the lifecycle owner and releases its media. */
    onDismissFailedAttempt?: () => void;
    /** Truthful transport semantics and copy, selected once for every placement. */
    primaryActionLabel: string | null;
    primaryActionHint: string | null;
    recoveryLabel: string | null;
    /** The recovery's short visible verb for compact transports; `recoveryLabel` stays its accessible name. */
    recoveryShortLabel: string | null;
    /** Placement-neutral, privacy-safe microphone status copy. */
    micStateLabel: string;
    /** The sheet caption selected from recovery and microphone status facts. */
    captionLabel: string;
    /** The presented service, including an active attempt that outlives a settings selection. Omitted by static previews. */
    serviceTitle?: string;
    /**
     * The Session the running attempt talks to, captured when it started (null in global mode or while
     * idle). Presence names this target; opening another Session never changes it.
     */
    targetSessionAddress?: SessionAddress | null;
    /** Applied voice from the current admitted attempt; never the next saved preference. */
    inUseVoice?: import('@happier-dev/protocol/actions/voiceConversationActionFamily').VoiceConversationInUseVoice | null;
    onPrimaryAction: () => void;
    /** Starts the caller's idle target when idle; ends the running attempt otherwise. Never re-targets. */
    onToggle: () => void;
    onToggleMute: () => void;
    commitInputLabel?: string | null;
    onCommitInput?: () => void;
    /** The canonical recovery dispatch shared by every container and glance. */
    onRecover: () => void;
    /**
     * The exact session destination read from the canonical binding. A targetless runtime
     * attempt opens Voice History instead, so its address/id are null but canOpenConversation is true.
     */
    openConversationSessionId: string | null;
    openConversationSessionAddress: SessionAddress | null;
    canOpenConversation: boolean;
    /**
     * Opens exactly that conversation.
     *
     * Read-and-navigate only: the binding owner decides what an attempt is bound to and the
     * lifecycle owner holds it immutable, so opening a conversation must not rebind, retarget, or
     * start anything.
     */
    onOpenConversation: () => void;
}>;

/**
 * The single projection over the canonical Voice lifecycle that placement-free surfaces consume
 * (§2.5): shell containers, composer, glance, shortcut and announcer. Placement never controls
 * lifecycle. Explicit composer/Home intents stay exact; default starts use the shared idle policy.
 */
export function useVoiceAttemptControl(idleTarget: VoiceAttemptIdleTarget): VoiceAttemptControlProjection {
    const router = useRouter();
    const snap = useVoiceSessionSnapshot();
    const expectedAttempt = getVoiceSessionPresentedAttemptId();
    const inputSourceActive = useVoiceInputSourceActive();
    const voice = useSetting('voice');
    /*
     * Memoized on the setting's identity: the parse is the most expensive work in this hook, and
     * an unmemoized result is a fresh object every render that would defeat every downstream memo
     * — including the recovery target and, through it, the surface model's `React.memo` seam.
     */
    const canonicalVoice = React.useMemo(() => voiceSettingsParse(voice), [voice]);
    useVoiceProviderRegistryRevision(voiceProviderRegistry);
    const providerId = resolveVoicePresentedProviderId(snap, canonicalVoice, voiceProviderRegistry) ?? 'off';
    const capabilities = resolveVoiceAdapterSurfaceCapabilities(providerId, voice);
    const voiceAgentFeatureEnabled = useFeatureEnabled('voice.agent');
    const surfaceState = resolveVoiceSurfaceState({
        status: snap.status,
        mode: snap.mode,
        errorPresentation: snap.errorPresentation,
        presentationState: snap.presentationState,
    });
    const recoveryAction = snap.errorRecoveryAction ?? (
        snap.presentationState === 'reconnecting' && snap.reconnectRetryAvailable === true
            ? 'retry'
            : null
    );
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
    const explicitIntent = React.useMemo<VoiceStartIntent>(
        () => idleTarget.kind === 'session'
            ? { kind: 'session', sessionAddress: normalizeSessionAddress(
                idleTarget.sessionAddress?.serverId,
                idleTarget.sessionAddress?.sessionId,
            ) }
            : idleTarget,
        [idleTarget],
    );
    const focusedSessionAddress = useFocusedSessionAddress();
    const lastFocusedSessionAddress = useVoiceTargetStore((state) => explicitIntent.kind === 'default' ? state.lastFocusedSessionAddress : null);
    const resolvedIdleTarget = React.useMemo(() => resolveVoiceIdleTarget({
        intent: explicitIntent,
        scopeDefault: canonicalVoice.ui.scopeDefault,
        allowsGlobalStart: capabilities?.allowsGlobalStart === true,
        focusedSessionAddress,
        lastFocusedSessionAddress,
    }), [explicitIntent, canonicalVoice.ui.scopeDefault, capabilities?.allowsGlobalStart, focusedSessionAddress, lastFocusedSessionAddress]);
    const bindingScope = resolvedIdleTarget.kind;
    const startSessionAddress = resolvedIdleTarget.kind === 'session' ? resolvedIdleTarget.sessionAddress : null;
    const startSessionId = startSessionAddress?.sessionId ?? null;
    const startAdmission = resolveVoiceStartAdmission({
        bindingScope,
        // Start admission and recovery consume canonical capabilities, independent of container.
        daemonLocalVoiceUnavailable:
            capabilities?.requiresVoiceAgentFeature === true && voiceAgentFeatureEnabled !== true,
        globalStartAuthorized: bindingScope === 'global' && capabilities?.allowsGlobalStart === true,
        platform: resolveCurrentVoiceRuntimePlatform(Platform.OS),
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
    const setupDismissed = useVoiceSetupDismissed();
    const capturing = resolveVoiceMicCaptureActive({
        status: snap.status,
        inputSourceActive,
    });

    /*
     * Where a failure is actually repaired — the exact Connected Account, the exact Agent runtime
     * on the exact machine, the platform microphone settings — derived here so every placement
     * offers the same remedy. Horizon used to own this and the orb fell back to a generic jump to
     * Voice settings, which made the same failure offer different help depending on the surface.
     */
    const activeServerSnapshot = useActiveServerSnapshot();
    const voiceExecutionMachine = useVoiceExecutionMachinePresentation();
    const connectedServicesRegistry = useProjectedConnectedServicesRegistry();
    const navigateWithFocusReturn = useNavigationFocusReturn();
    const agentRuntime = capabilities?.agentRuntime ?? null;
    /*
     * `resolveVoiceAdapterSurfaceCapabilities` freezes a new capability object on every call, so a
     * stable identity built from the two ids the recovery target actually reads is the same value
     * with a usable reference.
     */
    const agentRuntimeIdentity = React.useMemo(
        () => (agentRuntime ? { localId: agentRuntime.localId, pluginId: agentRuntime.pluginId } : null),
        [agentRuntime?.localId, agentRuntime?.pluginId],
    );
    const capturedAttemptTarget = expectedAttempt ? voiceSessionManager.getAttemptTargetSessionAddress() : null;
    const recoveryBindingScope = expectedAttempt ? capturedAttemptTarget ? 'session' : 'global' : bindingScope;
    const targetServerId = capturedAttemptTarget?.serverId ?? null;
    const targetSessionId = capturedAttemptTarget?.sessionId ?? null;
    const targetSessionAddress = React.useMemo<SessionAddress | null>(
        () => targetSessionId && targetServerId ? { serverId: targetServerId, sessionId: targetSessionId } : null,
        [targetServerId, targetSessionId],
    );
    /*
     * The session a recovery is about: the running attempt's control session, or — when nothing is
     * running — the conversation this caller would start. Never a third session.
     */
    const recoverySessionId = capturedAttemptTarget?.sessionId ?? normalizeNonEmptyString(snap.sessionId) ?? startSessionId;
    const selectRecoverySession = React.useCallback(
        (state: ReturnType<typeof storage.getState>) => {
            const session = recoverySessionId ? state.sessions[recoverySessionId] ?? null : null;
            return capturedAttemptTarget && session?.serverId !== capturedAttemptTarget.serverId ? null : session;
        },
        [capturedAttemptTarget, recoverySessionId],
    );
    const recoverySession = useStoreSnapshot(storage, selectRecoverySession);
    const recoverySessionOwnerMetadata = recoverySession
        ? readSessionOwnerMetadataView(recoverySession)
        : null;
    const recoverySessionServerId = normalizeNonEmptyString(recoverySession?.serverId);
    const runtimeRecoveryTarget = React.useMemo<VoiceAttemptRecoveryRuntimeTarget | null>(() => {
        return resolveVoiceAttemptRecoveryRuntimeTarget({ agentRuntime: agentRuntimeIdentity,
            serverId: recoveryBindingScope === 'session' ? capturedAttemptTarget?.serverId ?? recoverySessionServerId : activeServerSnapshot.serverId,
            machineId: recoveryBindingScope === 'session' ? recoverySessionOwnerMetadata?.machineId : voiceExecutionMachine.machineId });
    }, [
        activeServerSnapshot.serverId,
        agentRuntimeIdentity,
        recoveryBindingScope,
        capturedAttemptTarget,
        recoverySessionOwnerMetadata,
        recoverySessionServerId,
        voiceExecutionMachine.machineId,
    ]);
    const providerEntry = voiceProviderRegistry.get(providerId);
    const localizePluginText = useProjectedPluginLocalizedTextResolver();
    const serviceTitle = providerEntry ? resolveVoiceServiceTitle(providerEntry, tLoose, localizePluginText) : t('voicePresence.title');
    const providerSourcePluginId = providerEntry?.source.kind === 'bundled'
        || providerEntry?.source.kind === 'external'
        ? providerEntry.source.pluginId
        : null;
    const providerConnectedServicesBinding =
        providerEntry?.providerSettings?.connectedServicesBinding ?? null;
    const connectRecoveryTarget = React.useMemo(() => resolveVoiceConnectRecoveryTarget({
        agentRuntime: agentRuntimeIdentity,
        bindingScope: recoveryBindingScope,
        runtimeTarget: runtimeRecoveryTarget,
        provider: providerEntry
            ? {
                sourcePluginId: providerSourcePluginId,
                connectedServicesBinding: providerConnectedServicesBinding,
            }
            : null,
        providerConfig: recoveryBindingScope === 'session'
            ? null
            : readVoiceProviderSettingsConfig(canonicalVoice, providerId),
        sessionMetadata: recoveryBindingScope === 'session' ? recoverySessionOwnerMetadata : null,
        connectedServiceEntries: connectedServicesRegistry.entries,
    }), [
        agentRuntimeIdentity,
        recoveryBindingScope,
        canonicalVoice,
        connectedServicesRegistry.entries,
        providerConnectedServicesBinding,
        providerEntry,
        providerId,
        providerSourcePluginId,
        recoverySessionOwnerMetadata,
        runtimeRecoveryTarget,
    ]);
    const globalStartAuthorized = recoveryBindingScope === 'global';
    const recoveryContext = React.useMemo(() => ({
        connectRecoveryTarget,
        runtimeRecoveryTarget,
        attemptSessionId: snap.sessionId ?? null,
        startSessionId,
        globalStartAuthorized,
    }), [
        connectRecoveryTarget,
        globalStartAuthorized,
        runtimeRecoveryTarget,
        snap.sessionId,
        startSessionId,
    ]);
    const recoveryAvailable = resolveVoiceAttemptRecoveryAvailable(recovery, recoveryContext);
    const snapSessionId = snap.sessionId ?? null;
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
    const ended = React.useSyncExternalStore(
        subscribeToVoiceSessionEndedAttempt,
        getVoiceSessionEndedAttempt,
        getVoiceSessionEndedAttempt,
    );
    const presentedEnded = snap.status === 'disconnected' ? ended : null;
    const arrivedAttemptId = React.useSyncExternalStore(
        subscribeToVoiceSessionEndedAttempt,
        getVoiceSessionArrivedAttemptId,
        getVoiceSessionArrivedAttemptId,
    );
    const markEvent = React.useMemo(
        () => resolveVoiceMarkEvent({ ended: presentedEnded, arrivedAttemptId }),
        [arrivedAttemptId, presentedEnded],
    );
    const currentAccountScope = useActiveServerAccountScope();
    const subscribeBindingSources = React.useCallback((notify: () => void) => {
        const unsubscribeSessions = storage.subscribe(notify);
        const unsubscribeBindings = voiceSessionBindingStore.subscribe(notify);
        return () => {
            unsubscribeSessions();
            unsubscribeBindings();
        };
    }, []);
    // The conversation the user can return to, with the Home its binding named.
    const bindingCacheRef = React.useRef<Readonly<{
        sessions: unknown;
        bindings: unknown;
        controlSessionId: string;
        adapterId: string | null;
        value: OpenConversationTarget | null;
    }> | null>(null);
    // The binding already names the conversation carrier's Home. Cached whole so the
    // external-store snapshot keeps one identity while the inputs are unchanged.
    const readOpenConversationTarget = React.useCallback((): OpenConversationTarget | null => {
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
        const address = binding ? resolveVoiceConversationNavigationAddress(binding) : null;
        const previous = cached?.value;
        const value = binding
            ? previous && previous.address?.sessionId === address?.sessionId
                && previous.address?.serverId === address?.serverId
                ? previous
                : { address }
            : null;
        bindingCacheRef.current = {
            sessions,
            bindings,
            controlSessionId,
            adapterId: snapAdapterId,
            value,
        };
        return value;
    }, [snapAdapterId, snapSessionId]);
    const activeOpenConversationTarget = React.useSyncExternalStore(
        subscribeBindingSources,
        readOpenConversationTarget,
        readOpenConversationTarget,
    );
    // End can retire the live binding. Its captured addresses and policy remain authoritative;
    // a control id or a later visible session must never reconstruct this destination.
    const endedOpenConversationTarget = React.useMemo<OpenConversationTarget | null>(() => {
        if (!presentedEnded || !areServerAccountScopesEqual(presentedEnded.accountScope, currentAccountScope)) return null;
        const conversationSessionAddress = presentedEnded.conversationSessionAddress;
        if (!conversationSessionAddress) return null;
        return { address: resolveVoiceConversationNavigationAddress({ ...presentedEnded, conversationSessionAddress }) };
    }, [currentAccountScope, presentedEnded]);
    const openConversationTarget = presentedEnded ? endedOpenConversationTarget : activeOpenConversationTarget;
    const openConversationSessionAddress = openConversationTarget?.address ?? null;
    const openConversationSessionId = openConversationSessionAddress?.sessionId ?? null;
    const canOpenConversation = openConversationTarget !== null;

    const onOpenConversation = React.useCallback(() => {
        if (!openConversationTarget) return;
        if (presentedEnded && !areServerAccountScopesEqual(presentedEnded.accountScope, storage.getState().profileScope)) return;
        if (!openConversationTarget.address) {
            router.push(SETTINGS_ROUTES.voiceHistory as never);
            return;
        }
        router.push(buildScopedSessionRouteHref({
            sessionId: openConversationTarget.address.sessionId,
            serverId: openConversationTarget.address.serverId,
        }) as never);
    }, [openConversationTarget, presentedEnded, router]);


    const presentedSession = useSession(openConversationSessionId ?? snapSessionId ?? '', openConversationSessionAddress?.serverId ?? recoverySessionServerId);
    const sessionStatus = useSessionStatus(presentedSession, { subscribeToSession: false, workingTextMode: 'static' });
    const elapsedStartedAt = getVoiceSessionAttemptStartedAt();
    // Hold is not inferred from commitInput or mute: the capture-input owner must admit the gesture.
    const canHoldToTalk = snap.status === 'connected' && snap.canHoldToTalk === true;
    const beginHoldToTalk = React.useCallback(() => {
        if (!canHoldToTalk || !snapSessionId || !voiceSessionManager.matchesAttempt(expectedAttempt)) return null;
        return voiceSessionManager.beginHoldToTalk(snapSessionId);
    }, [canHoldToTalk, expectedAttempt, snapSessionId]);
    const control = React.useMemo(() => resolveVoiceAttemptControl({
        surfaceState,
        tone: resolveVoiceSurfaceStatusPresentation(surfaceState).tone,
        status: snap.status,
        sessionId: snap.sessionId ?? null,
        canStop: snap.canStop === true,
        canCommitInput: snap.canCommitInput === true,
        muted: snap.micMuted === true,
        capturing,
        startAdmitted: startAdmission.canStart,
        hasRecovery: recoveryAvailable || setupIncomplete,
        canDismissFailedAttempt: canDismissVoiceSessionFailedAttempt(snap),
        /*
         * Every mount of this projection is already behind the Voice feature gate (the global off
         * switch), so an idle Voice that cannot start offers its setup and the rest mic stays
         * discoverable — until the person dismisses "Set up voice" (the same dismissal Home uses;
         * Settings → Voice stays reachable). A malformed target (a session scope with no session) is
         * a caller mistake setup cannot fix — it fails closed.
         */
        setupOffered: !setupDismissed && (bindingScope === 'global' || startSessionId !== null),
        sessionStatus,
    }), [
        bindingScope,
        setupDismissed,
        recoveryAvailable,
        setupIncomplete,
        startSessionId,
        sessionStatus?.state,
        sessionStatus?.statusText,
        snap.canStop,
        snap.canCommitInput,
        snap.micMuted,
        snap.sessionId,
        snap.status,
        snap.adapterId,
        snap.errorCode,
        snap.errorPresentation,
        startAdmission.canStart,
        surfaceState,
        capturing,
    ]);

    const statusPresentation = resolveVoiceSurfaceStatusPresentation(surfaceState);
    const statusOverride = presentedEnded
        ? t('voicePresence.ended')
        : control.statusCell === 'working' || control.statusCell === 'needs_you'
        ? sessionStatus?.statusText ?? null
        // A muted conversation says so: its mode may still read "Listening", which would invite talking.
        : control.muted && VOICE_CONVERSING_SURFACE_STATES.has(surfaceState)
        ? t('voicePresence.muted')
        : null;
    const statusLabel = statusOverride ?? t(statusPresentation.labelKey);
    const statusWord = statusOverride ?? t(statusPresentation.wordKey ?? statusPresentation.labelKey);
    const canStop = control.canStop;
    const canStart = control.canStart;
    const canMute = control.canMute;
    const muted = control.muted;

    const onToggle = React.useCallback(() => {
        if (!voiceSessionManager.matchesAttempt(expectedAttempt)) return;
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
        fireAndForget(voiceSessionManager.toggle(startSessionAddress), { tag: 'VoiceAttemptControl.toggle' });
    }, [canStart, canStop, expectedAttempt, snapSessionId, startSessionAddress]);

    const onToggleMute = React.useCallback(() => {
        const sessionId = snapSessionId?.trim() ?? '';
        if (!canMute || !sessionId || !voiceSessionManager.matchesAttempt(expectedAttempt)) return;
        fireAndForget(voiceSessionManager.setMuted(sessionId, !muted), { tag: 'VoiceAttemptControl.mute' });
    }, [canMute, expectedAttempt, muted, snapSessionId]);

    const onDismissFailedAttempt = React.useCallback(() => {
        if (control.canDismissFailedAttempt !== true || !voiceSessionManager.matchesAttempt(expectedAttempt)) return;
        fireAndForget(voiceSessionManager.dismissFailedAttempt(snapSessionId), { tag: 'VoiceAttemptControl.dismissFailedAttempt' });
    }, [control.canDismissFailedAttempt, expectedAttempt, snapSessionId]);

    const onCommitInput = React.useCallback(() => {
        if (control.canCommitInput !== true || !snapSessionId || !voiceSessionManager.matchesAttempt(expectedAttempt)) return;
        fireAndForget(voiceSessionManager.commitInput(snapSessionId), { tag: 'VoiceAttemptControl.commitInput' });
    }, [control.canCommitInput, expectedAttempt, snapSessionId]);
    const commitInputLabel = control.canCommitInput === true ? t('common.send') : null;

    const onRecover = React.useMemo(() => createVoiceAttemptRecoveryDispatch({
        expectedAttempt,
        recoveryAction,
        setupIncomplete,
        context: recoveryContext,
        navigate: (href: unknown) => navigateWithFocusReturn(() => router.push(href as never)),
    }), [expectedAttempt, navigateWithFocusReturn, recoveryAction, recoveryContext, router, setupIncomplete]);
    const onDismissEnded = React.useCallback(() => {
        if (voiceSessionManager.matchesAttempt(expectedAttempt)) dismissVoiceSessionEndedAttempt();
    }, [expectedAttempt]);

    const recoveryLabel = control.recoveryAvailable
        ? t(recovery?.labelKey ?? 'modals.openSettings')
        : null;
    const micStateLabel = surfaceState === 'permission_required' ? statusLabel : t(
        control.muted
            ? 'voiceSurface.a11y.microphoneMuted'
            : control.capturing
                ? 'voiceSurface.a11y.microphoneActive'
                : 'voiceSurface.a11y.microphoneInactive',
    );
    /*
     * A failure's caption is what to do about it or why it happened, never the status word again:
     * a blocked microphone says how to unblock it, a failed attempt names the runtime's own reason
     * (the same machine-error copy the Voice section shows), so no presenter falls back to the
     * last line said as if the call were fine.
     */
    const failureReason = surfaceState === 'error' && isVoiceMachineErrorKind(snap.errorCode)
        ? translateVoiceReadiness(resolveVoiceMachineErrorTranslationKey(snap.errorCode), { service: serviceTitle })
        : null;
    const captionLabel = surfaceState === 'permission_required'
        ? t('voicePresence.captions.blocked')
        : surfaceState === 'error'
            ? failureReason ?? t('voicePresence.captions.failed')
            : recoveryLabel ?? micStateLabel;
    /*
     * The transport's visible verb (lab ST: Allow · Retry · Set up). The full `recoveryLabel` stays
     * the accessible name and the glance's button title.
     */
    const recoveryShortLabel = !recoveryLabel
        ? null
        : surfaceState === 'permission_required' || recoveryAction === 'open_settings_then_reconnect'
            ? t('voicePresence.recovery.allow')
            : recovery === null || recovery.kind === 'open_settings' || recovery.kind === 'review_credentials'
                || recovery.kind === 'select_execution_machine'
                ? t('voicePresence.recovery.setUp')
                : recoveryLabel;
    const primaryActionLabel = control.primaryAction === 'recover'
        ? recoveryLabel
        : control.primaryAction === 'end'
            ? t('voiceAssistant.endVoice')
            : control.primaryAction === 'start'
                ? t('voiceAssistant.startVoice')
                : control.primaryAction === 'setup'
                    ? t('voicePresence.setUp')
                    : null;
    const primaryActionHint = control.primaryAction === 'recover'
        ? primaryActionLabel
        : control.primaryAction === 'end'
            ? t('voiceSurface.orbEndHint')
            : control.primaryAction === 'start'
                ? t('voiceSurface.orbStartHint')
                : control.primaryAction === 'setup'
                    ? t('voicePresence.setUpHint')
                    : null;
    const onPrimaryAction = React.useCallback(() => {
        if (control.primaryAction === 'recover') {
            onRecover();
            return;
        }
        if (control.primaryAction === 'setup') {
            navigateWithFocusReturn(() => router.push(SETTINGS_ROUTES.voice as never));
            return;
        }
        if (control.primaryAction === 'start' || control.primaryAction === 'end') onToggle();
    }, [control.primaryAction, navigateWithFocusReturn, onRecover, onToggle, router]);

    return React.useMemo(
        () => ({
            ...control,
            statusWord,
            statusLabel,
            elapsedStartedAt,
            canHoldToTalk,
            beginHoldToTalk,
            ended: presentedEnded,
            markEvent,
            onDismissEnded,
            onDismissFailedAttempt,
            onToggle,
            onToggleMute,
            onCommitInput,
            commitInputLabel,
            onRecover,
            primaryActionLabel,
            primaryActionHint,
            recoveryLabel,
            recoveryShortLabel,
            micStateLabel,
            captionLabel,
            onPrimaryAction,
            serviceTitle,
            inUseVoice: snap.status === 'connected' ? snap.inUseVoice ?? null : null,
            targetSessionAddress,
            openConversationSessionId,
            openConversationSessionAddress,
            canOpenConversation,
            onOpenConversation,
        }),
        [
            control,
            statusWord,
            serviceTitle,
            snap.status,
            snap.inUseVoice,
            targetSessionAddress,
            statusLabel,
            elapsedStartedAt,
            canHoldToTalk,
            beginHoldToTalk,
            presentedEnded,
            markEvent,
            onDismissEnded,
            onDismissFailedAttempt,
            onCommitInput,
            commitInputLabel,
            onOpenConversation,
            onPrimaryAction,
            onRecover,
            onToggle,
            onToggleMute,
            openConversationSessionId,
            openConversationSessionAddress,
            canOpenConversation,
            primaryActionHint,
            primaryActionLabel,
            recoveryLabel,
            recoveryShortLabel,
            micStateLabel,
            captionLabel,
        ],
    );
}
