import * as React from 'react';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Platform } from 'react-native';

import { resolveVoiceConnectRecoveryTarget } from '@/components/voice/surface/resolveVoiceConnectRecoveryTarget';
import {
    resolveCurrentVoiceRuntimePlatform,
    resolveVoiceStartAdmission,
} from '@/components/voice/surface/resolveVoiceStartAdmission';
import { resolveVoiceSurfaceRecovery, type VoiceRecoveryIcon } from '@/components/voice/surface/resolveVoiceSurfaceRecovery';
import { resolveVoiceSurfaceState, type VoiceSurfaceState } from '@/components/voice/surface/resolveVoiceSurfaceState';
import { resolveVoiceSurfaceStatusPresentation } from '@/components/voice/surface/resolveVoiceSurfaceStatusPresentation';
import { useStoreSnapshot } from '@/components/voice/surface/useStoreSnapshot';
import { useVoiceInputSourceActive } from '@/components/voice/light/VoiceEnergyAppProvider';
import { voiceSurfaceHaptics } from '@/components/voice/surface/voiceSurfaceHaptics';
import { useProjectedConnectedServicesRegistry, useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { normalizeSessionAddress, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { storage, useActiveServerAccountScope, useSession, useSetting } from '@/sync/domains/state/storage';
import { readLocalConversationVoiceSettings, readVoiceProviderSettingsConfig, voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { useSessionStatus } from '@/utils/sessions/sessionUtils';
import {
    canDismissVoiceSessionFailedAttempt,
    getVoiceSessionAttemptStartedAt,
    getVoiceSessionPresentedAttemptId,
    getVoiceSessionFirstSuccessAttemptId,
    getVoiceSessionArrivedAttemptId,
    getVoiceSessionEndedAttempt,
    subscribeToVoiceSessionEndedAttempt,
    getVoiceSessionRestartTarget,
    type VoiceSessionEndedAttempt,
} from '@/voice/session/voiceSessionStore';
import { useNavigationFocusReturn } from '@/utils/navigation/useNavigationFocusReturn';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { t, tLoose } from '@/text';
import { resolveVoiceServiceTitle } from '@/voice/registry/voiceProviderPresentation';
import { useVoiceExecutionMachinePresentation } from '@/voice/credentials/useExecutionMachinePresentation';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { resolveVoiceBindingBySessionId } from '@/voice/binding/resolveVoiceBindingBySessionId';
import { resolveVoiceConversationNavigationAddress } from '@/voice/binding/resolveVoiceConversationNavigationAddress';
import { isVoiceConversationCustodySessionMetadata } from '@/voice/persistence/voiceConversationSystemSessionLookup';
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
import { canVoiceAdapterStartNewConversation, resolveVoiceAdapterSurfaceCapabilities } from '@/voice/session/voiceAdapterRegistry';
import type { VoiceHeldInput } from '@/voice/runtime/controller/VoiceConversationController';
import { useFocusedSessionAddress } from '@/sync/domains/session/sessionSurfaceVisibility';
import { getFocusedDesktopAppWindowSurface, subscribeFocusedDesktopAppWindowSurface } from '@/desktop/window/appWindowSurface';
import { resolveDesktopWindowContext } from '@/desktop/window/isDesktopAuxiliaryWindowContext';
import { resolveVoiceIdleTarget, useVoiceTargetStore, type VoiceStartIntent } from '@/voice/runtime/voiceTargetStore';
import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { VoiceConversationActionOutputSchemas, type VoiceConversationActionId } from '@happier-dev/protocol/actions/voiceConversationActionFamily';
import { createFrontDoorUiActionExecutor, type UiActionOperation } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { projectVoiceAttemptPresentation } from './projectVoiceAttemptPresentation';
import type { VoiceAttemptPresentation } from '@happier-dev/protocol/voice/attemptPresentation';

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

type OpenConversationTarget = Readonly<{ address: SessionAddress | null; requestAddress: SessionAddress | null }>;

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
    /** Sanitized read-only public seam, produced from this exact host model. */
    publicPresentation?: VoiceAttemptPresentation;
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
    /** The same genuine completion fact drives setup art and the composer mark. */
    firstSuccessEvent?: VoiceMarkEvent | null;
    /** Acknowledges a terminal failure through the lifecycle owner and releases its media. */
    onDismissFailedAttempt?: () => void;
    /** Truthful transport semantics and copy, selected once for every placement. */
    primaryActionLabel: string | null;
    primaryActionHint: string | null;
    /**
     * The recovery's one label (lab ST: Allow · Retry · Set up), drawn and announced the same way in
     * every placement — the pill, the island, the glance and the sheet never name one action twice.
     */
    recoveryLabel: string | null;
    /** The recovery's glyph, chosen with its label: microphone to allow, gear to set up, arrow to retry. */
    recoveryIcon: VoiceRecoveryIcon | null;
    /** Placement-neutral, privacy-safe microphone status copy. */
    micStateLabel: string;
    /** The sheet caption selected from recovery and microphone status facts. */
    captionLabel: string;
    /**
     * The one sentence for a machine error, whatever its presentation: the caption of a failed
     * attempt and the glance subtitle read it, never their own translation. Omitted by static previews.
     */
    failureMessage?: string | null;
    /** The presented service, including an active attempt that outlives a settings selection. Omitted by static previews. */
    serviceTitle?: string;
    /**
     * The person-facing admitted Session target, retained for the same Account's clean ended moment.
     * Global mode and hidden Voice carriers have no displayed target; request/navigation addresses
     * keep their exact custody independently. Never substitutes the caller's next idle target.
     */
    targetSessionAddress?: SessionAddress | null;
    /** Exact request owner, independent of whether navigation exposes a conversation or History. */
    pendingRequestSessionAddress?: SessionAddress | null;
    /** Applied voice from the current admitted attempt; never the next saved preference. */
    inUseVoice?: import('@happier-dev/protocol/actions/voiceConversationActionFamily').VoiceConversationInUseVoice | null;
    /** Render Speaks from only for this admitted carrier fact, using its exact Session's display name. */
    preparedInstructionsFor?: SessionAddress | null;
    onPrimaryAction: () => void | Promise<boolean>;
    /**
     * Starts a fresh conversation at the caller's idle target. Present only while Start is admitted,
     * the conversation is executable, and Start would otherwise continue the last one. Omitted by
     * static previews.
     */
    onNewConversation?: () => Promise<boolean>;
    /** Starts the caller's idle target when idle; ends the running attempt otherwise. Never re-targets. */
    onToggle: () => void | Promise<boolean>;
    onToggleMute: () => void;
    commitInputLabel?: string | null;
    onCommitInput?: () => void;
    /** The canonical recovery dispatch shared by every container and glance. */
    onRecover: () => void | Promise<boolean>;
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
    const ownsVoiceRuntime = resolveDesktopWindowContext().role === 'primary';
    const router = useRouter();
    const navigateWithFocusReturn = useNavigationFocusReturn();
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
    const ended = React.useSyncExternalStore(
        subscribeToVoiceSessionEndedAttempt,
        getVoiceSessionEndedAttempt,
        getVoiceSessionEndedAttempt,
    );
    const presentedEnded = snap.status === 'disconnected' ? ended : null;
    const currentAccountScope = useActiveServerAccountScope();
    const { executeValue } = useMountedActionExecution(currentAccountScope);
    const executeControl = React.useCallback(async (
        actionId: VoiceConversationActionId, input: unknown, tag: string, operation?: UiActionOperation,
    ) => {
        try {
            // Approval can await: retain the originating tab and focus-return target, not the then-focused destination.
            const navigation = actionId === 'ui.voice_global.recover' || actionId === 'ui.voice_global.open_conversation'
                ? navigateWithFocusReturn.capture() : null;
            const result = await executeValue(actionId, input, {
                ...operation,
                ...(navigation ? { openRoute: (route: string) => navigation.navigate(() => router.push(route as never)) } : {}),
            });
            const output = VoiceConversationActionOutputSchemas[actionId].parse(result);
            return 'status' in output && output.status === 'completed';
        } catch (error) {
            fireAndForget(Promise.reject(error), { tag });
            return false;
        }
    }, [executeValue, navigateWithFocusReturn, router]);
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
    const focusedWindowSurface = React.useSyncExternalStore(subscribeFocusedDesktopAppWindowSurface,
        getFocusedDesktopAppWindowSurface, getFocusedDesktopAppWindowSurface);
    const lastFocusedSessionAddress = useVoiceTargetStore((state) => explicitIntent.kind === 'default' ? state.lastFocusedSessionAddress : null);
    const resolvedIdleTarget = React.useMemo(() => resolveVoiceIdleTarget({
        intent: explicitIntent,
        restartTarget: getVoiceSessionRestartTarget(providerId, currentAccountScope),
        scopeDefault: canonicalVoice.ui.scopeDefault,
        allowsGlobalStart: capabilities?.allowsGlobalStart === true,
        focusedSessionAddress,
        focusedWindowSurface,
        currentAccountId: currentAccountScope?.accountId,
        lastFocusedSessionAddress,
    }), [explicitIntent, presentedEnded, expectedAttempt, snap, providerId, currentAccountScope, canonicalVoice.ui.scopeDefault, capabilities?.allowsGlobalStart, focusedSessionAddress, focusedWindowSurface, lastFocusedSessionAddress]);
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
    const agentRuntime = expectedAttempt ? snap.recoveryTarget?.agentRuntime ?? null : capabilities?.agentRuntime ?? null;
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
        if (expectedAttempt) return resolveVoiceAttemptRecoveryRuntimeTarget({
            agentRuntime: snap.recoveryTarget?.agentRuntime ?? null,
            serverId: snap.recoveryTarget?.serverId,
            machineId: snap.recoveryTarget?.machineId,
        });
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
        snap.recoveryTarget,
        expectedAttempt,
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
        uxDiagnostic: snap.errorConnectedServiceDiagnostic,
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
        snap.errorConnectedServiceDiagnostic,
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
    const arrivedAttemptId = React.useSyncExternalStore(
        subscribeToVoiceSessionEndedAttempt,
        getVoiceSessionArrivedAttemptId,
        getVoiceSessionArrivedAttemptId,
    );
    const presentedTarget = presentedEnded
        ? areServerAccountScopesEqual(presentedEnded.accountScope, currentAccountScope)
            ? presentedEnded.targetSessionAddress : null
        : capturedAttemptTarget;
    const targetServerId = presentedTarget?.serverId ?? null;
    const targetSessionId = presentedTarget?.sessionId ?? null;
    const targetSession = useSession(targetSessionId ?? '', targetServerId);
    const hiddenTarget = targetSession !== null
        && isVoiceConversationCustodySessionMetadata(readSessionOwnerMetadataView(targetSession));
    const targetSessionAddress = React.useMemo<SessionAddress | null>(
        () => !hiddenTarget && targetSessionId && targetServerId ? { serverId: targetServerId, sessionId: targetSessionId } : null,
        [hiddenTarget, targetServerId, targetSessionId],
    );
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
        const requestAddress = binding?.targetSessionAddress ?? binding?.conversationSessionAddress ?? null;
        const previous = cached?.value;
        const value = binding
            ? previous && previous.address?.sessionId === address?.sessionId
                && previous.address?.serverId === address?.serverId
                && previous.requestAddress?.sessionId === requestAddress?.sessionId
                && previous.requestAddress?.serverId === requestAddress?.serverId
                ? previous
                : { address, requestAddress }
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
        return { address: resolveVoiceConversationNavigationAddress({ ...presentedEnded, conversationSessionAddress }),
            requestAddress: presentedEnded.targetSessionAddress ?? conversationSessionAddress };
    }, [currentAccountScope, presentedEnded]);
    const openConversationTarget = presentedEnded ? endedOpenConversationTarget : activeOpenConversationTarget;
    const openConversationSessionAddress = openConversationTarget?.address ?? null;
    const openConversationSessionId = openConversationSessionAddress?.sessionId ?? null;
    const canOpenConversation = openConversationTarget !== null;
    const pendingRequestSessionAddress = presentedTarget ?? activeOpenConversationTarget?.requestAddress ?? null;

    const firstSuccessAttemptId = React.useSyncExternalStore(
        subscribeToVoiceSessionEndedAttempt,
        getVoiceSessionFirstSuccessAttemptId,
        getVoiceSessionFirstSuccessAttemptId,
    );
    const firstSuccessEvent = React.useMemo<VoiceMarkEvent | null>(() => firstSuccessAttemptId
        ? { kind: 'gather', id: `${firstSuccessAttemptId}:first-success` } : null, [firstSuccessAttemptId]);
    const markEvent = React.useMemo(
        () => resolveVoiceMarkEvent({ ended: presentedEnded, arrivedAttemptId, firstSuccess: firstSuccessEvent }),
        [arrivedAttemptId, presentedEnded, firstSuccessEvent],
    );

    const onOpenConversation = React.useCallback(() => {
        if (!openConversationTarget || !expectedAttempt) return;
        return executeControl('ui.voice_global.open_conversation', { expectedAttempt }, 'VoiceAttemptControl.openConversation');
    }, [executeControl, expectedAttempt, openConversationTarget]);


    const presentedSession = useSession(pendingRequestSessionAddress?.sessionId ?? openConversationSessionId ?? snapSessionId ?? '',
        pendingRequestSessionAddress?.serverId ?? openConversationSessionAddress?.serverId ?? recoverySessionServerId);
    const sessionStatus = useSessionStatus(presentedSession, { subscribeToSession: false, workingTextMode: 'static' });
    const presentedSessionIsHidden = presentedSession !== null
        && isVoiceConversationCustodySessionMetadata(readSessionOwnerMetadataView(presentedSession));
    const elapsedStartedAt = getVoiceSessionAttemptStartedAt();
    // Hold is not inferred from commitInput or mute: the capture-input owner must admit the gesture.
    const canHoldToTalk = snap.status === 'connected' && snap.canHoldToTalk === true;
    const beginHoldToTalk = React.useCallback(() => {
        if (!canHoldToTalk || !snapSessionId || !expectedAttempt || !voiceSessionManager.matchesAttempt(expectedAttempt)) return null;
        const admission = new AbortController();
        const finishAction = createFrontDoorUiActionExecutor(undefined, currentAccountScope
            ? { serverId: currentAccountScope.serverId, expectedAccountId: currentAccountScope.accountId } : undefined);
        let admitted = false;
        let finishing: Promise<void> | null = null;
        const ready = executeControl('ui.voice_global.hold_begin', { expectedAttempt }, 'VoiceAttemptControl.holdBegin',
            { signal: admission.signal }).then(result => { admitted = result; return result; });
        const finish = (outcome: 'release' | 'cancel'): Promise<void> => {
            if (finishing) return finishing;
            // Releasing before admission must never open capture later, including while Ask first is pending.
            if (!admitted) admission.abort();
            finishing = (async () => {
                if (!await ready) return;
                // The admitted gesture must release capture even when its presenter just unmounted.
                await finishAction(outcome === 'release' ? 'ui.voice_global.hold_release' : 'ui.voice_global.hold_cancel', { expectedAttempt });
            })();
            return finishing;
        };
        return { ready, release: () => finish('release'), cancel: () => finish('cancel') } satisfies VoiceHeldInput;
    }, [canHoldToTalk, currentAccountScope, executeControl, expectedAttempt, snapSessionId]);
    const control = React.useMemo(() => resolveVoiceAttemptControl({
        surfaceState,
        tone: resolveVoiceSurfaceStatusPresentation(surfaceState).tone,
        status: snap.status,
        sessionId: snap.sessionId ?? null,
        canStop: snap.canStop === true,
        canCommitInput: snap.canCommitInput === true,
        muted: snap.micMuted === true,
        capturing,
        startAdmitted: ownsVoiceRuntime && startAdmission.canStart,
        hasRecovery: ownsVoiceRuntime && (recoveryAvailable || setupIncomplete),
        canDismissFailedAttempt: canDismissVoiceSessionFailedAttempt(snap),
        /*
         * Every mount of this projection is already behind the Voice feature gate (the global off
         * switch), so an idle Voice that cannot start offers its setup and the rest mic stays
         * discoverable — until the person dismisses "Set up voice" (the same dismissal Home uses;
         * Settings → Voice stays reachable). A malformed target (a session scope with no session) is
         * a caller mistake setup cannot fix — it fails closed.
         */
        setupOffered: ownsVoiceRuntime && !setupDismissed && (bindingScope === 'global' || startSessionId !== null),
        sessionStatus,
        hiddenSession: presentedSessionIsHidden,
    }), [
        bindingScope,
        ownsVoiceRuntime,
        setupDismissed,
        recoveryAvailable,
        setupIncomplete,
        startSessionId,
        sessionStatus?.state,
        sessionStatus?.statusText,
        sessionStatus?.actionRequiredReason,
        presentedSessionIsHidden,
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

    const canStop = control.canStop;
    const canStart = control.canStart;
    const canMute = control.canMute;
    const muted = control.muted;

    const onToggle = React.useCallback(async () => {
        if (!voiceSessionManager.matchesAttempt(expectedAttempt)) return false;
        if (canStop) {
            /*
             * The **running attempt's** session, never the idle target: a surface that stopped its
             * own target would leave a conversation it does not own still listening, and settle a
             * second one that never started.
             */
            const sessionId = snapSessionId?.trim() ?? '';
            if (!sessionId || !expectedAttempt) return false;
            voiceSurfaceHaptics.notify('start_stop');
            return await executeControl('ui.voice_global.end', { expectedAttempt }, 'VoiceAttemptControl.stop');
        }
        if (!canStart) return false;
        // The caller's stated target. The empty session id is the canonical global/hidden-owner start.
        voiceSurfaceHaptics.notify('start_stop');
        return await executeControl('ui.voice_global.start', { target: resolvedIdleTarget, expectedAttempt: null }, 'VoiceAttemptControl.toggle');
    }, [canStart, canStop, executeControl, expectedAttempt, resolvedIdleTarget, snapSessionId]);

    // New differs from Start only for an executable conversation whose Start continues the last one.
    const newConversationOffered = canStart && canVoiceAdapterStartNewConversation(capabilities, resolvedIdleTarget.kind)
        && readLocalConversationVoiceSettings(canonicalVoice).agent.rootSessionPolicy !== 'new';
    const onNewConversation = React.useCallback(async () => {
        if (!voiceSessionManager.matchesAttempt(expectedAttempt) || !canStart) return false;
        voiceSurfaceHaptics.notify('start_stop');
        return await executeControl('ui.voice_global.new_conversation', { target: resolvedIdleTarget, expectedAttempt: null }, 'VoiceAttemptControl.newConversation');
    }, [canStart, executeControl, expectedAttempt, resolvedIdleTarget]);

    const onToggleMute = React.useCallback(() => {
        const sessionId = snapSessionId?.trim() ?? '';
        if (!canMute || !sessionId || !voiceSessionManager.matchesAttempt(expectedAttempt)) return;
        return executeControl('ui.voice_global.set_muted', { expectedAttempt, muted: !muted }, 'VoiceAttemptControl.mute');
    }, [canMute, executeControl, expectedAttempt, muted, snapSessionId]);

    const onDismissFailedAttempt = React.useCallback(() => {
        if (control.canDismissFailedAttempt !== true || !voiceSessionManager.matchesAttempt(expectedAttempt)) return;
        return executeControl('ui.voice_global.dismiss', { expectedAttempt, kind: 'failed' }, 'VoiceAttemptControl.dismissFailedAttempt');
    }, [control.canDismissFailedAttempt, executeControl, expectedAttempt]);

    const onCommitInput = React.useCallback(() => {
        if (control.canCommitInput !== true || !snapSessionId || !voiceSessionManager.matchesAttempt(expectedAttempt)) return;
        return executeControl('ui.voice_global.turn_control', { expectedAttempt, control: 'commit_input' }, 'VoiceAttemptControl.commitInput');
    }, [control.canCommitInput, executeControl, expectedAttempt, snapSessionId]);
    const commitInputLabel = control.canCommitInput === true ? t('common.send') : null;

    const recoverBeforeAttempt = React.useMemo(() => createVoiceAttemptRecoveryDispatch({
        expectedAttempt,
        recoveryAction,
        errorReason: snap.errorMessage,
        setupIncomplete,
        context: recoveryContext,
        navigate: (href: unknown) => navigateWithFocusReturn(() => router.push(href as never)),
    }), [expectedAttempt, navigateWithFocusReturn, recoveryAction, recoveryContext, router, setupIncomplete, snap.errorMessage]);
    const onRecover = React.useCallback(() => expectedAttempt
        ? executeControl('ui.voice_global.recover', { expectedAttempt }, 'VoiceAttemptControl.recover')
        : recoverBeforeAttempt(), [executeControl, expectedAttempt, recoverBeforeAttempt]);
    const onDismissEnded = React.useCallback(() => {
        if (expectedAttempt) return executeControl('ui.voice_global.dismiss', { expectedAttempt, kind: 'ended' }, 'VoiceAttemptControl.dismissEnded');
    }, [executeControl, expectedAttempt]);

    /*
     * A signed-out Agent names itself and the machine it is signed out on only when both are exact:
     * the recovery target already derives them, so the sentence and its Set up CTA agree. Anywhere
     * else the kind's generic sentence and the Connect label stand.
     */
    const agentTitle = React.useMemo(
        () => agentRuntimeIdentity ? resolveAgentCatalogTitle(agentRuntimeIdentity.localId) : null,
        [agentRuntimeIdentity],
    );
    const agentMachineLabel = expectedAttempt ? snap.recoveryTarget?.machineLabel ?? null : runtimeRecoveryTarget?.machineId === voiceExecutionMachine.machineId
        ? voiceExecutionMachine.machineLabel
        : null;
    /*
     * One label per recovery action for every placement (R12b), owned by the recovery resolver. A
     * blocked microphone is always "Allow"; setup still owed with no runtime recovery is "Set up";
     * a Connect that opens the exact Agent's own settings is "Set up <Agent>".
     */
    const publicPresentation = React.useMemo(() => projectVoiceAttemptPresentation({
        control, attemptId: expectedAttempt, ended: presentedEnded !== null,
        errorCode: snap.errorCode, errorMessage: snap.errorMessage, recoveryAction, recoveryContext,
        errorConnectedServiceDiagnostic: snap.errorConnectedServiceDiagnostic,
        errorProviderMessage: snap.errorProviderMessage,
        serviceTitle, agentTitle, agentMachineLabel,
    }), [control, expectedAttempt, presentedEnded, snap.errorCode, snap.errorMessage, snap.errorProviderMessage, snap.errorConnectedServiceDiagnostic, recoveryAction,
        recoveryContext, serviceTitle, agentTitle, agentMachineLabel]);
    const statusPresentation = resolveVoiceSurfaceStatusPresentation(surfaceState);
    const statusOverride = presentedEnded
        ? t('voicePresence.ended')
        // A muted conversation says so: its mode may still read "Listening", which would invite talking.
        : control.muted && VOICE_CONVERSING_SURFACE_STATES.has(surfaceState)
        ? t('voicePresence.muted')
        : null;
    const failureStatusWord = surfaceState === 'error'
        ? publicPresentation.failureTitle ?? t(statusPresentation.wordKey ?? statusPresentation.labelKey)
        : null;
    const statusLabel = statusOverride ?? (surfaceState === 'error' ? publicPresentation.failureMessage : null) ?? t(statusPresentation.labelKey);
    const statusWord = presentedEnded ? t('voicePresence.ended') : failureStatusWord ?? (
        control.statusCell === 'working' || control.statusCell === 'needs_you'
            ? t(`workStatus.buckets.${control.statusCell}`)
            : statusOverride ?? t(statusPresentation.wordKey ?? statusPresentation.labelKey)
    );
    const recoveryLabel = publicPresentation.recovery?.label ?? null;
    const recoveryIcon = publicPresentation.recovery?.icon ?? null;
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
    const failureMessage = publicPresentation.failureMessage;
    const failureReason = surfaceState === 'error' ? failureMessage : null;
    const captionLabel = surfaceState === 'permission_required'
        ? t('voicePresence.captions.blocked')
        : surfaceState === 'error'
            ? failureReason ?? t('voicePresence.captions.failed')
            : recoveryLabel ?? micStateLabel;
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
            return onRecover();
        }
        if (control.primaryAction === 'setup') {
            navigateWithFocusReturn(() => router.push(SETTINGS_ROUTES.voice as never));
            return;
        }
        if (control.primaryAction === 'start' || control.primaryAction === 'end') return onToggle();
    }, [control.primaryAction, navigateWithFocusReturn, onRecover, onToggle, router]);

    return React.useMemo(
        () => ({
            ...control,
            publicPresentation,
            statusWord,
            statusLabel,
            elapsedStartedAt,
            canHoldToTalk,
            beginHoldToTalk,
            ended: presentedEnded,
            markEvent,
            firstSuccessEvent,
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
            recoveryIcon,
            micStateLabel,
            captionLabel,
            failureMessage,
            onPrimaryAction,
            ...(newConversationOffered ? { onNewConversation } : {}),
            serviceTitle,
            inUseVoice: snap.status === 'connected' ? snap.inUseVoice ?? null : null,
            preparedInstructionsFor: snap.status === 'connected' ? snap.preparedInstructionsFor ?? null : null,
            targetSessionAddress,
            pendingRequestSessionAddress,
            openConversationSessionId,
            openConversationSessionAddress,
            canOpenConversation,
            onOpenConversation,
        }),
        [
            control,
            publicPresentation,
            statusWord,
            serviceTitle,
            snap.status,
            snap.inUseVoice,
            snap.preparedInstructionsFor,
            targetSessionAddress,
            pendingRequestSessionAddress,
            statusLabel,
            elapsedStartedAt,
            canHoldToTalk,
            beginHoldToTalk,
            presentedEnded,
            markEvent,
            firstSuccessEvent,
            onDismissEnded,
            onDismissFailedAttempt,
            onCommitInput,
            commitInputLabel,
            onOpenConversation,
            onPrimaryAction,
            newConversationOffered,
            onNewConversation,
            onRecover,
            onToggle,
            onToggleMute,
            openConversationSessionId,
            openConversationSessionAddress,
            canOpenConversation,
            primaryActionHint,
            primaryActionLabel,
            recoveryLabel,
            recoveryIcon,
            micStateLabel,
            captionLabel,
            failureMessage,
        ],
    );
}
