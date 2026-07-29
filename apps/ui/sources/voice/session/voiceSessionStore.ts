import { create } from 'zustand';

import type { VoiceSessionSnapshot } from './types';
import { getVoiceSessionLifecycleController } from './voiceSessionLifecycleControllerStore';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

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
let lastAttemptSnapshot: VoiceSessionSnapshot = DEFAULT_SNAPSHOT;

function isAttemptActive(snapshot: VoiceSessionSnapshot): boolean {
  return snapshot.status === 'connecting' || snapshot.status === 'connected';
}

function reconcileAttemptId(snapshot: VoiceSessionSnapshot): void {
  const active = isAttemptActive(snapshot);
  const previousActive = isAttemptActive(lastAttemptSnapshot);
  const sessionChanged = active
    && previousActive
    && snapshot.sessionId !== lastAttemptSnapshot.sessionId;
  if (active && (!previousActive || sessionChanged)) {
    activeAttemptId = `voice-attempt:${++attemptSequence}`;
  } else if (!active) {
    activeAttemptId = null;
  }
  lastAttemptSnapshot = snapshot;
}

function isVoiceSessionSnapshotEqual(a: VoiceSessionSnapshot, b: VoiceSessionSnapshot): boolean {
  return (
    a.adapterId === b.adapterId
    && a.sessionId === b.sessionId
    && a.status === b.status
    && a.mode === b.mode
    && a.canStop === b.canStop
    && a.micMuted === b.micMuted
    && a.errorCode === b.errorCode
    && a.errorMessage === b.errorMessage
    && a.errorRecoveryAction === b.errorRecoveryAction
    && a.errorPresentation === b.errorPresentation
    && a.presentationState === b.presentationState
  );
}

function isDefaultSnapshot(snapshot: VoiceSessionSnapshot): boolean {
  return isVoiceSessionSnapshotEqual(snapshot, DEFAULT_SNAPSHOT);
}

function normalizeVoiceSessionSnapshot(snapshot: VoiceSessionSnapshot): VoiceSessionSnapshot {
  return {
    ...snapshot,
    adapterId: normalizeNonEmptyString(snapshot.adapterId),
    sessionId: normalizeNonEmptyString(snapshot.sessionId),
    micMuted: snapshot.micMuted === true ? true : undefined,
    // Ensure optional error fields clear when omitted from a later snapshot.
    errorCode: snapshot.errorCode,
    errorMessage: snapshot.errorMessage,
    errorRecoveryAction: snapshot.errorRecoveryAction,
    errorPresentation: snapshot.errorPresentation,
    presentationState: snapshot.presentationState,
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

export function setVoiceSessionSnapshot(snapshot: VoiceSessionSnapshot): void {
  const normalized = normalizeVoiceSessionSnapshot(snapshot);
  reconcileAttemptId(normalized);
  useVoiceSessionStore.getState().setSnapshot(normalized);
}

export function getVoiceSessionAttemptId(): string | null {
  return activeAttemptId;
}

export function subscribeToVoiceSessionSnapshot(listener: () => void): () => void {
  return useVoiceSessionStore.subscribe(() => listener());
}

export function resetVoiceSessionStoreForTests(): void {
  cachedCanonicalSnapshot = DEFAULT_SNAPSHOT;
  attemptSequence = 0;
  activeAttemptId = null;
  lastAttemptSnapshot = DEFAULT_SNAPSHOT;
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
