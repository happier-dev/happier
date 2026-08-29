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
  }>;
  suspendInput(sessionId: string): Promise<Readonly<{
    release(): Promise<void>;
  }> | null>;
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
  const suspensionLeases = new Map<SuspensionReason, Readonly<{
    release(): Promise<void>;
  }>>();
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
    if (suspensionReasons.has(reason)) return;
    suspensionReasons.add(reason);
    const sessionId = activeSessionId();
    if (!sessionId) return;
    const lease = await input.controller.suspendInput(sessionId);
    if (!lease) return;
    if (disposed || !suspensionReasons.has(reason)) {
      await lease.release();
      return;
    }
    suspensionLeases.set(reason, lease);
  };

  const resume = async (reason: SuspensionReason): Promise<void> => {
    suspensionReasons.delete(reason);
    const lease = suspensionLeases.get(reason);
    suspensionLeases.delete(reason);
    await lease?.release();
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
    const leases = [...suspensionLeases.values()];
    suspensionLeases.clear();
    const sessionId = activeSessionId();
    try {
      if (sessionId) await input.controller.stop(sessionId);
    } catch {
      // The terminal lifecycle fact remains authoritative even when an adapter
      // fails its own stop. Releasing bridge-owned suspension leases is an
      // independent teardown obligation and must not be vetoed by that failure.
    } finally {
      await Promise.allSettled(leases.map(async (lease) => await lease.release()));
    }
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
      const leases = [...suspensionLeases.values()];
      suspensionLeases.clear();
      subscription.remove();
      // A suspension is an attempt-owned lease, not a boolean write. Disposal
      // relinquishes exactly the leases this bridge acquired; each release is
      // idempotent and currentness-fenced by the lifecycle owner.
      void Promise.allSettled(leases.map(async (lease) => await lease.release()));
    },
  });
}
