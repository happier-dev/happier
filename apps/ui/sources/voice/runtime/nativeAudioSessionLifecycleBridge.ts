import type {
  VoiceAudioSessionCoordinator,
  VoiceAudioSessionPlatformEvent,
} from '@happier-dev/audio-stream-native';
import type {
  VoiceOutputFocusApplication,
  VoiceOutputFocusState,
} from '@happier-dev/plugin-sdk/voice/client';
import { Platform } from 'react-native';

type Controller = Readonly<{
  getSnapshot(): Readonly<{
    sessionId: string | null;
    status: 'disconnected' | 'connecting' | 'connected' | 'error';
    micMuted?: boolean;
  }>;
  setMuted(sessionId: string, muted: boolean): Promise<void>;
  setOutputFocusState?(
    sessionId: string,
    state: VoiceOutputFocusState,
  ): Promise<VoiceOutputFocusApplication>;
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

  /**
   * The native coordinator is the only audio-focus authority. This bridge
   * carries its output fact to the admitted Voice runtime. The lifecycle owner
   * holds the exact adapter reference and terminates only that owner when the
   * application cannot be made current; this bridge only gates capture work.
   */
  const applyOutputFocusState = async (state: VoiceOutputFocusState): Promise<boolean> => {
    const sessionId = activeSessionId();
    if (!sessionId) return true;
    let application: VoiceOutputFocusApplication;
    try {
      application = input.controller.setOutputFocusState
        ? await input.controller.setOutputFocusState(sessionId, state)
        : 'unsupported';
    } catch {
      application = 'unsupported';
    }
    return application === 'applied';
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
    if (event.kind === 'focus_duckable') {
      // Ducking is distinct from a transient loss. It must not downgrade a
      // true capture/output suspension before Android has returned focus.
      if (suspensionReasons.has('focus')) return;
      await applyOutputFocusState('ducked');
      return;
    }
    if (event.kind === 'focus_changed') {
      if (event.state === 'lost_permanent') return await stopActive();
      if (event.state === 'lost_transient') {
        if (!await applyOutputFocusState('suspended')) return;
        return await suspend('focus');
      }
      if (event.state === 'gained' || event.state === 'not_required') {
        if (!await applyOutputFocusState('active')) return;
        return await resume('focus');
      }
    }
    if (event.kind === 'lifecycle_changed') {
      // Active native conversation Voice keeps its call-like audio session in
      // ordinary background/lock transitions. Those lifecycle changes are not
      // audio interruptions, so this bridge must not manufacture a mute,
      // reconnect, or reacquisition transition. Dictation retains its separate
      // background-cancellation policy through its own coordinator subscription.
      if (Platform.OS === 'ios' || Platform.OS === 'android') return;
      return event.state === 'background' ? await suspend('lifecycle') : await resume('lifecycle');
    }
    // The native owner reports this only after deciding the graph cannot be
    // resumed, so there is nothing left for this bridge to recover.
    if (event.kind === 'audio_graph_terminal') return await stopActive();
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
