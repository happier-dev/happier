import { create } from 'zustand';

import type { VoiceSessionSnapshot } from './types';
import { getVoiceSessionLifecycleController } from './voiceSessionLifecycleControllerStore';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import type { VoiceSessionBinding } from '@/voice/binding/voiceConversationBindingTypes';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { areSessionAddressesEqual } from '@/sync/domains/session/sessionAddress';
import type { VoiceContinuationProvenance } from '@/voice/transcript/voiceTranscriptNoteMeta';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import type { VoiceConversationScopeMetadata } from '@/voice/persistence/voiceConversationScopeMetadata';
import type { VoiceIdleTarget } from '@/voice/runtime/voiceTargetStore';
import { createSpokenActionConfirmation, type SpokenActionConfirmation } from '@/voice/tools/spokenActionConfirmation';

type VoiceSessionConversationContext = Readonly<{
  accountScope: ServerAccountScope;
  /** The admitted coding target exists even when there is no hidden conversation binding. */
  targetSessionAddress?: SessionAddress | null;
  conversationScope: VoiceConversationScopeMetadata | null;
}>;

type VoiceSessionState = VoiceSessionSnapshot & {
  setSnapshot: (snapshot: VoiceSessionSnapshot) => void;
};

const DEFAULT_SNAPSHOT: VoiceSessionSnapshot = {
  adapterId: null,
  sessionId: null,
  status: 'disconnected',
  mode: 'idle',
  canStop: false,
};

let cachedCanonicalSnapshot: VoiceSessionSnapshot = DEFAULT_SNAPSHOT;
let attemptSequence = 0;
let activeAttemptId: string | null = null;
let spokenActionConfirmation: SpokenActionConfirmation | null = null;
let presentedAttemptId: string | null = null;
let activeAttemptStartedAt: number | null = null;
let lastAttemptSnapshot: VoiceSessionSnapshot = DEFAULT_SNAPSHOT;
let activeAttemptBinding: VoiceSessionBinding | null = null;
let activeAttemptConversationContext: VoiceSessionConversationContext | null = null;
let requestedEndReason: VoiceSessionEndReason | null = null;
/** The live attempt that connected to a conversation last voiced on another device (continuation arrival). */
let arrivedAttemptId: string | null = null;
let firstSuccessAttempt: Readonly<{ attemptId: string; lifetime: ServerAccountScopeLifetime }> | null = null;
const NO_INPUT_IDS: readonly string[] = Object.freeze([]);
let firstSuccessInputs: Readonly<{ attemptId: string; lifetime: ServerAccountScopeLifetime; ids: readonly string[] }> | null = null;

export type VoiceSessionEndReason = Readonly<
  | { kind: 'disconnected' }
  | { kind: 'stopped' }
  | { kind: 'continued_elsewhere'; continuation: VoiceContinuationProvenance }
>;

/**
 * The attempt that last ended cleanly — the lifecycle's own active → disconnected transition, never a
 * failure (that is the error state) and never inferred from time. Presence shows "Voice ended" from
 * this one fact until the next attempt starts or the person dismisses it; it is not persisted.
 */
export type VoiceSessionEndedAttempt = Readonly<{
  attemptId?: string | null;
  sessionId: string | null;
  adapterId: string | null;
  startedAt: number | null;
  endedAt: number;
  reason: VoiceSessionEndReason;
  conversationSessionAddress: SessionAddress | null;
  targetSessionAddress: SessionAddress | null;
  transcriptMode: VoiceSessionBinding['transcriptMode'] | null;
  lifetime?: VoiceSessionBinding['lifetime'];
  accountScope: ServerAccountScope | null;
  conversationScope: VoiceConversationScopeMetadata | null;
}>;
let endedAttempt: VoiceSessionEndedAttempt | null = null;
const endedAttemptListeners = new Set<() => void>();

function setEndedAttempt(next: VoiceSessionEndedAttempt | null): void {
  if (next === endedAttempt) return;
  endedAttempt = next;
  for (const listener of endedAttemptListeners) listener();
}

function isAttemptActive(snapshot: VoiceSessionSnapshot): boolean {
  return snapshot.status === 'connecting' || snapshot.status === 'connected';
}

/** A terminal failure can be acknowledged; live and starting attempts must be ended instead. */
export function canDismissVoiceSessionFailedAttempt(snapshot: VoiceSessionSnapshot): boolean {
  return Boolean(snapshot.adapterId)
    && snapshot.canStop === false
    && (snapshot.status === 'error' || (snapshot.status === 'disconnected'
      && Boolean(snapshot.errorCode || snapshot.errorPresentation)));
}

function reconcileAttemptId(snapshot: VoiceSessionSnapshot, binding?: VoiceSessionBinding | null, context?: VoiceSessionConversationContext | null): void {
  const active = isAttemptActive(snapshot);
  const previousActive = isAttemptActive(lastAttemptSnapshot);
  const sessionChanged = active
    && previousActive
    && (snapshot.sessionId !== lastAttemptSnapshot.sessionId || snapshot.adapterId !== lastAttemptSnapshot.adapterId);
  if (active && (!previousActive || sessionChanged)) {
    spokenActionConfirmation?.clear();
    spokenActionConfirmation = createSpokenActionConfirmation();
    activeAttemptId = `voice-attempt:${++attemptSequence}`;
    presentedAttemptId = activeAttemptId;
    activeAttemptStartedAt = Date.now();
    activeAttemptBinding = null;
    activeAttemptConversationContext = null;
    requestedEndReason = null;
    arrivedAttemptId = null;
    firstSuccessAttempt = null;
    firstSuccessInputs = null;
    setEndedAttempt(null);
  } else if (!active) {
    spokenActionConfirmation?.clear();
    spokenActionConfirmation = null;
    arrivedAttemptId = null;
    if (previousActive) {
      setEndedAttempt(snapshot.status === 'disconnected' && !snapshot.errorCode && !snapshot.errorPresentation
        ? Object.freeze({
          attemptId: activeAttemptId,
          sessionId: lastAttemptSnapshot.sessionId,
          adapterId: lastAttemptSnapshot.adapterId,
          startedAt: activeAttemptStartedAt,
          endedAt: Date.now(),
          reason: requestedEndReason ?? ({ kind: 'disconnected' } satisfies VoiceSessionEndReason),
          conversationSessionAddress: activeAttemptBinding?.conversationSessionAddress ?? null,
          // A continued carrier's admitted binding owns its effective coding target, including null for Voice home.
          targetSessionAddress: activeAttemptBinding
            ? activeAttemptBinding.targetSessionAddress
            : activeAttemptConversationContext?.targetSessionAddress ?? null,
          transcriptMode: activeAttemptBinding?.transcriptMode ?? null,
          ...(activeAttemptBinding?.lifetime ? { lifetime: activeAttemptBinding.lifetime } : {}),
          accountScope: activeAttemptConversationContext?.accountScope ?? null,
          conversationScope: activeAttemptConversationContext?.conversationScope ?? null,
        })
        : null);
    }
    activeAttemptId = null;
    activeAttemptStartedAt = null;
    if (!canDismissVoiceSessionFailedAttempt(snapshot)) {
      activeAttemptBinding = null;
      activeAttemptConversationContext = null;
    }
    requestedEndReason = null;
    if (!canDismissVoiceSessionFailedAttempt(snapshot) && endedAttempt === null) presentedAttemptId = null;
    if (canDismissVoiceSessionFailedAttempt(snapshot) && (presentedAttemptId === null
      || (!previousActive && (!canDismissVoiceSessionFailedAttempt(lastAttemptSnapshot)
        || snapshot.adapterId !== lastAttemptSnapshot.adapterId || snapshot.sessionId !== lastAttemptSnapshot.sessionId)))) {
      setEndedAttempt(null);
      presentedAttemptId = `voice-attempt:${++attemptSequence}`;
    }
  }
  const admittedHome = activeAttemptConversationContext?.accountScope.serverId ?? context?.accountScope.serverId;
  if (active && binding?.adapterId === snapshot.adapterId && binding.controlSessionId === snapshot.sessionId
    && (!admittedHome || binding.conversationSessionAddress.serverId === admittedHome)) {
    if (!areSessionAddressesEqual(activeAttemptBinding?.conversationSessionAddress, binding.conversationSessionAddress)) {
      if (activeAttemptConversationContext) activeAttemptConversationContext = { ...activeAttemptConversationContext, conversationScope: null };
    }
    activeAttemptBinding = binding;
  }
  const contextHome = context?.targetSessionAddress?.serverId ?? activeAttemptBinding?.conversationSessionAddress.serverId;
  if (active && context && context.accountScope.serverId === contextHome) {
    // Admission owns target and Account; a later route/profile publication cannot relabel them.
    if (!activeAttemptConversationContext) activeAttemptConversationContext = context;
    else if (activeAttemptBinding && areServerAccountScopesEqual(activeAttemptConversationContext.accountScope, context.accountScope)) {
      activeAttemptConversationContext = { ...activeAttemptConversationContext, conversationScope: context.conversationScope };
    }
  }
  lastAttemptSnapshot = snapshot;
}

const SNAPSHOT_FIELDS = {
  adapterId: true,
  sessionId: true,
  status: true,
  mode: true,
  canStop: true,
  canCommitInput: true,
  canHoldToTalk: true,
  micMuted: true,
  errorCode: true,
  errorMessage: true,
  errorRecoveryAction: true,
  errorPresentation: true,
  presentationState: true,
  reconnectRetryAvailable: true,
  inUseVoice: true,
  preparedInstructionsFor: true,
  recoveryTarget: true,
} satisfies Record<keyof VoiceSessionSnapshot, true>;
const SNAPSHOT_KEYS = Object.keys(SNAPSHOT_FIELDS) as Array<keyof VoiceSessionSnapshot>;

function isVoiceSessionSnapshotEqual(a: VoiceSessionSnapshot, b: VoiceSessionSnapshot): boolean {
  return SNAPSHOT_KEYS.every((key) => a[key] === b[key]);
}

function isDefaultSnapshot(snapshot: VoiceSessionSnapshot): boolean {
  return isVoiceSessionSnapshotEqual(snapshot, DEFAULT_SNAPSHOT);
}

function normalizeVoiceSessionSnapshot(snapshot: VoiceSessionSnapshot): VoiceSessionSnapshot {
  return {
    ...snapshot,
    adapterId: normalizeNonEmptyString(snapshot.adapterId),
    sessionId: normalizeNonEmptyString(snapshot.sessionId),
    // Zustand merges snapshots: omitted capability facts must retire with their owner.
    canCommitInput: snapshot.canCommitInput,
    canHoldToTalk: snapshot.canHoldToTalk,
    micMuted: snapshot.micMuted === true ? true : undefined,
    // Ensure optional error fields clear when omitted from a later snapshot.
    errorCode: snapshot.errorCode,
    errorMessage: snapshot.errorMessage,
    errorRecoveryAction: snapshot.errorRecoveryAction,
    errorPresentation: snapshot.errorPresentation,
    presentationState: snapshot.presentationState,
    reconnectRetryAvailable: snapshot.reconnectRetryAvailable,
    inUseVoice: snapshot.status === 'connected' ? snapshot.inUseVoice : undefined,
    preparedInstructionsFor: snapshot.status === 'connected' ? snapshot.preparedInstructionsFor : undefined,
    recoveryTarget: snapshot.recoveryTarget,
  };
}

function readPublishedSnapshot(): VoiceSessionSnapshot {
  const { setSnapshot: _ignore, ...snapshot } = useVoiceSessionStore.getState();
  return snapshot;
}

function finalizeCanonicalSnapshot(nextSnapshot: VoiceSessionSnapshot): VoiceSessionSnapshot {
  if (isVoiceSessionSnapshotEqual(cachedCanonicalSnapshot, nextSnapshot)) {
    return cachedCanonicalSnapshot;
  }
  cachedCanonicalSnapshot = nextSnapshot;
  return nextSnapshot;
}

export const useVoiceSessionStore = create<VoiceSessionState>((set) => ({
  ...DEFAULT_SNAPSHOT,
  setSnapshot: (snapshot) =>
    set((state) => {
      const nextSnapshot = normalizeVoiceSessionSnapshot(snapshot);
      if (isVoiceSessionSnapshotEqual(state, nextSnapshot)) {
        return state;
      }
      return nextSnapshot;
    }),
}));

export function getVoiceSessionSnapshot(): VoiceSessionSnapshot {
  const lifecycleSnapshot = getVoiceSessionLifecycleController()?.getSnapshot();
  if (lifecycleSnapshot) {
    return finalizeCanonicalSnapshot(lifecycleSnapshot);
  }

  const publishedSnapshot = readPublishedSnapshot();
  if (!isDefaultSnapshot(publishedSnapshot)) {
    return finalizeCanonicalSnapshot(publishedSnapshot);
  }

  return finalizeCanonicalSnapshot(DEFAULT_SNAPSHOT);
}

export function setVoiceSessionSnapshot(snapshot: VoiceSessionSnapshot, binding?: VoiceSessionBinding | null, context?: VoiceSessionConversationContext | null): void {
  const normalized = normalizeVoiceSessionSnapshot(snapshot);
  reconcileAttemptId(normalized, binding, context);
  useVoiceSessionStore.getState().setSnapshot(normalized);
}

/** Only the canonical End command can annotate the existing active attempt; this never ends it. */
export function recordVoiceSessionEndReason(adapterId: string, controlSessionId: string, reason: VoiceSessionEndReason | null): void {
  if (!isAttemptActive(lastAttemptSnapshot) || lastAttemptSnapshot.adapterId !== adapterId
    || lastAttemptSnapshot.sessionId !== controlSessionId) return;
  if (reason?.kind === 'continued_elsewhere'
    && !areSessionAddressesEqual(reason.continuation.conversation, activeAttemptBinding?.conversationSessionAddress)) return;
  requestedEndReason = reason;
}

/** Marks the exact live attempt as a continuation arrival; a terminal or different attempt is ignored. */
export function recordVoiceSessionArrival(adapterId: string, controlSessionId: string): void {
  if (!activeAttemptId || !isAttemptActive(lastAttemptSnapshot) || lastAttemptSnapshot.adapterId !== adapterId
    || lastAttemptSnapshot.sessionId !== controlSessionId || arrivedAttemptId === activeAttemptId) return;
  arrivedAttemptId = activeAttemptId;
  for (const listener of endedAttemptListeners) listener();
}

export function getVoiceSessionArrivedAttemptId(): string | null {
  return arrivedAttemptId;
}

/** The runtime publishes only the genuine completed-attempt fact, never transcript rows to controls. */
export function recordVoiceSessionFirstSuccess(attemptId: string, lifetime: ServerAccountScopeLifetime): void {
  if (attemptId !== presentedAttemptId || !lifetime.isCurrent()
    || (attemptId !== activeAttemptId && attemptId !== endedAttempt?.attemptId)
    || firstSuccessAttempt?.attemptId === attemptId) return;
  firstSuccessAttempt = { attemptId, lifetime };
  firstSuccessInputs = null;
  for (const listener of endedAttemptListeners) listener();
}

export function clearVoiceSessionFirstSuccess(): void {
  if (!firstSuccessAttempt && !firstSuccessInputs) return;
  firstSuccessAttempt = null;
  firstSuccessInputs = null;
  for (const listener of endedAttemptListeners) listener();
}

export function clearVoiceSessionFirstSuccessInputs(): void {
  if (!firstSuccessInputs) return;
  firstSuccessInputs = null;
  for (const listener of endedAttemptListeners) listener();
}

/** The durable input producer reports acceptance for its captured attempt, including settlement just after End. */
export function recordVoiceSessionFirstSuccessInput(input: Readonly<{
  attemptId: string; lifetime: ServerAccountScopeLifetime; conversationSessionId: string; localId: string;
}>): void {
  const conversation = activeAttemptBinding?.conversationSessionAddress ?? endedAttempt?.conversationSessionAddress;
  if (input.attemptId !== presentedAttemptId || !input.lifetime.isCurrent()
    || firstSuccessAttempt?.attemptId === input.attemptId
    || (input.attemptId !== activeAttemptId && input.attemptId !== endedAttempt?.attemptId)
    || conversation?.sessionId !== input.conversationSessionId || conversation.serverId !== input.lifetime.scope.serverId) return;
  const previous = firstSuccessInputs?.attemptId === input.attemptId && firstSuccessInputs.lifetime === input.lifetime
    ? firstSuccessInputs.ids : NO_INPUT_IDS;
  if (previous.includes(input.localId)) return;
  firstSuccessInputs = { attemptId: input.attemptId, lifetime: input.lifetime, ids: [...previous, input.localId] };
  for (const listener of endedAttemptListeners) listener();
}

export function getVoiceSessionFirstSuccessInputIds(): readonly string[] {
  return firstSuccessInputs?.attemptId === presentedAttemptId && firstSuccessInputs.lifetime.isCurrent()
    ? firstSuccessInputs.ids : NO_INPUT_IDS;
}

export function getVoiceSessionFirstSuccessAttemptId(): string | null {
  return firstSuccessAttempt?.attemptId === presentedAttemptId && firstSuccessAttempt.lifetime.isCurrent()
    ? firstSuccessAttempt.attemptId : null;
}

export function getVoiceSessionAttemptId(): string | null {
  return activeAttemptId;
}

/** One non-persisted read-back binding belongs to the existing live call. */
export function getVoiceSessionSpokenActionConfirmation(): SpokenActionConfirmation | null {
  return spokenActionConfirmation;
}

/** The existing attempt identity remains addressable through its terminal presentation. */
export function getVoiceSessionPresentedAttemptId(): string | null {
  return presentedAttemptId;
}

export function getVoiceSessionPresentedBinding(): VoiceSessionBinding | null {
  return activeAttemptBinding;
}

/** Default restart stays with the presented attempt; explicit Home/composer intents remain explicit. */
export function getVoiceSessionRestartTarget(providerId: string, accountScope: ServerAccountScope | null): VoiceIdleTarget | null {
  const ended = endedAttempt;
  const failed = canDismissVoiceSessionFailedAttempt(lastAttemptSnapshot);
  const adapterId = ended?.adapterId ?? (failed ? lastAttemptSnapshot.adapterId : null);
  const scope = ended?.accountScope ?? (failed ? activeAttemptConversationContext?.accountScope : null);
  if (adapterId !== providerId || !areServerAccountScopesEqual(scope, accountScope)) return null;
  const target = ended ? ended.targetSessionAddress
    : activeAttemptBinding ? activeAttemptBinding.targetSessionAddress
    : activeAttemptConversationContext?.targetSessionAddress ?? null;
  return target ? { kind: 'session', sessionAddress: target } : { kind: 'global' };
}

/** The canonical observed start boundary; presentation never starts its own clock on mount. */
export function getVoiceSessionAttemptStartedAt(): number | null {
  return activeAttemptStartedAt;
}

export function getVoiceSessionEndedAttempt(): VoiceSessionEndedAttempt | null {
  return endedAttempt;
}

/** The person put the ended conversation away; the next start clears it on its own. */
export function dismissVoiceSessionEndedAttempt(): void {
  clearVoiceSessionFirstSuccess();
  setEndedAttempt(null);
  if (!activeAttemptId && !canDismissVoiceSessionFailedAttempt(lastAttemptSnapshot)) presentedAttemptId = null;
}

/** The attempt's presentation facts: the ended attempt and a continuation arrival. */
export function subscribeToVoiceSessionEndedAttempt(listener: () => void): () => void {
  endedAttemptListeners.add(listener);
  return () => {
    endedAttemptListeners.delete(listener);
  };
}

export function subscribeToVoiceSessionSnapshot(listener: () => void): () => void {
  return useVoiceSessionStore.subscribe(() => listener());
}

export function resetVoiceSessionStoreForTests(): void {
  spokenActionConfirmation?.clear();
  spokenActionConfirmation = null;
  cachedCanonicalSnapshot = DEFAULT_SNAPSHOT;
  attemptSequence = 0;
  activeAttemptId = null;
  presentedAttemptId = null;
  activeAttemptStartedAt = null;
  lastAttemptSnapshot = DEFAULT_SNAPSHOT;
  activeAttemptBinding = null;
  activeAttemptConversationContext = null;
  requestedEndReason = null;
  arrivedAttemptId = null;
  firstSuccessAttempt = null;
  firstSuccessInputs = null;
  endedAttempt = null;
  useVoiceSessionStore.setState({
    ...DEFAULT_SNAPSHOT,
    setSnapshot: useVoiceSessionStore.getState().setSnapshot,
  }, true);
}

export async function resetVoiceSessionRuntimeStateForTests(): Promise<void> {
  const [
    { resetVoiceSessionLifecycleControllerStoreForTests },
    { resetVoiceAdapterRegistryForTests },
  ] = await Promise.all([
    import('./voiceSessionLifecycleControllerStore'),
    import('./voiceAdapterRegistry'),
  ]);

  resetVoiceSessionLifecycleControllerStoreForTests();
  resetVoiceAdapterRegistryForTests();
  resetVoiceSessionStoreForTests();
}
