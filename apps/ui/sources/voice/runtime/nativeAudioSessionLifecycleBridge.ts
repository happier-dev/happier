import type {
  VoiceAudioSessionCoordinator,
  VoiceAudioSessionPlatformEvent,
} from '@happier-dev/audio-stream-native';

type Controller = Readonly<{
  getSnapshot(): Readonly<{
    sessionId: string | null;
    status: 'disconnected' | 'connecting' | 'connected' | 'error';
    micMuted?: boolean;
  }>;
  setMuted(sessionId: string, muted: boolean): Promise<void>;
  stop(sessionId: string): Promise<void>;
}>;

type SuspensionReason = 'interruption' | 'focus' | 'lifecycle';

/** Maps native audio ownership events into the canonical voice lifecycle owner. */
export function createNativeAudioSessionLifecycleBridge(input: Readonly<{
  coordinator: VoiceAudioSessionCoordinator;
  controller: Controller;
}>) {
  const suspensionReasons = new Set<SuspensionReason>();
  let autoMutedSessionId: string | null = null;
  let disposed = false;
  let workTail = Promise.resolve();

  const activeSessionId = (): string | null => {
    const snapshot = input.controller.getSnapshot();
    return snapshot.status === 'disconnected' || snapshot.status === 'error'
      ? null
      : snapshot.sessionId;
  };

  const enqueue = (work: () => Promise<void>): void => {
    workTail = workTail
      .catch(() => undefined)
      .then(async () => {
        if (!disposed) await work();
      });
  };

  const suspend = async (reason: SuspensionReason): Promise<void> => {
    suspensionReasons.add(reason);
    if (autoMutedSessionId) return;
    const snapshot = input.controller.getSnapshot();
    const sessionId = activeSessionId();
    if (!sessionId || snapshot.micMuted === true) return;
    autoMutedSessionId = sessionId;
    try {
      await input.controller.setMuted(sessionId, true);
    } catch {
      autoMutedSessionId = null;
      await input.controller.stop(sessionId).catch(() => undefined);
    }
  };

  const resume = async (reason: SuspensionReason): Promise<void> => {
    suspensionReasons.delete(reason);
    if (suspensionReasons.size > 0) return;
    const sessionId = autoMutedSessionId;
    autoMutedSessionId = null;
    if (!sessionId || activeSessionId() !== sessionId) return;
    await input.controller.setMuted(sessionId, false).catch(async () => {
      await input.controller.stop(sessionId).catch(() => undefined);
    });
  };

  const stopActive = async (): Promise<void> => {
    suspensionReasons.clear();
    autoMutedSessionId = null;
    const sessionId = activeSessionId();
    if (sessionId) await input.controller.stop(sessionId).catch(() => undefined);
  };

  const handle = async (event: VoiceAudioSessionPlatformEvent): Promise<void> => {
    if (event.kind === 'interruption_began') return await suspend('interruption');
    if (event.kind === 'interruption_ended') {
      if (!event.shouldResume) return await stopActive();
      return await resume('interruption');
    }
    if (event.kind === 'focus_changed') {
      if (event.state === 'lost_permanent') return await stopActive();
      if (event.state === 'lost_transient') return await suspend('focus');
      return await resume('focus');
    }
    if (event.kind === 'lifecycle_changed') {
      return event.state === 'background' ? await suspend('lifecycle') : await resume('lifecycle');
    }
    if (event.kind === 'capabilities_changed') {
      const configuration = input.coordinator.getSnapshot().configuration;
      if (configuration?.aec === 'required' && (!event.aecAvailable || !event.aecActive)) {
        await stopActive();
      }
    } else if (event.kind === 'restoration_failed') {
      await stopActive();
    }
  };

  const subscription = input.coordinator.subscribe((event) => {
    enqueue(() => handle(event));
  });

  return Object.freeze({
    dispose(): void {
      if (disposed) return;
      disposed = true;
      suspensionReasons.clear();
      autoMutedSessionId = null;
      subscription.remove();
    },
  });
}
