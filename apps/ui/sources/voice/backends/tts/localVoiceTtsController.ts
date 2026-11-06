import {
  createDefaultLocalVoiceTtsProviderControllers,
  prepareLocalVoiceTtsRequest,
  reportTtsFailure,
  speakWithBundledSpeechTts,
  type LocalVoiceTtsController,
  type LocalVoiceTtsProviderController,
  type LocalVoiceTtsProviderId,
} from './localVoiceTtsProviderControllers';
import { createVoicePlaybackController } from '@/voice/runtime/playback/VoicePlaybackController';

export function createLocalVoiceTtsController(options?: Readonly<{
  controllers?: Partial<Record<LocalVoiceTtsProviderId, LocalVoiceTtsProviderController>>;
}>): LocalVoiceTtsController {
  const controllers = new Map(createDefaultLocalVoiceTtsProviderControllers());
  for (const [providerId, controller] of Object.entries(options?.controllers ?? {})) {
    if (controller) controllers.set(providerId, controller);
  }

  const playback = createVoicePlaybackController();
  let sayState: ReturnType<LocalVoiceTtsController['readSay']> = 'idle';
  const listeners = new Set<() => void>();
  const publish = (next: ReturnType<LocalVoiceTtsController['readSay']>) => {
    if (sayState === next) return;
    sayState = next;
    for (const listener of listeners) listener();
  };
  const controller: LocalVoiceTtsController = {
    speak: async (ctx) => {
      const preparation = prepareLocalVoiceTtsRequest(ctx);
      if (!preparation) return;
      const controller = controllers.get(ctx.tts.provider);
      if (controller) {
        // Selection-less engines cannot consume a declared preference by silently using a default.
        if (preparation.preference && !controller.sessionVoiceProviderId) {
          reportTtsFailure(ctx, new Error('voice_preference_unavailable'));
          return;
        }
        const onSpeaking = ctx.sessionId && !controller.sessionVoiceProviderId ? () => {
          if (!preparation.isCurrent()) return;
          preparation.onVoiceApplied?.(null);
          ctx.onSpeaking();
        } : ctx.onSpeaking;
        await controller.speak({ ...ctx, preparation, onSpeaking });
        return;
      }
      if (await speakWithBundledSpeechTts(ctx.tts.provider, ctx, preparation)) return;
      throw Object.assign(new Error('voice_tts_provider_unavailable'), { code: 'provider_unavailable' });
    },
    readSay: () => sayState,
    subscribeSay: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    stopSay: () => {
      if (sayState === 'idle') return false;
      playback.interrupt();
      publish('idle');
      return true;
    },
    say: async (ctx) => {
      if (ctx.signal?.aborted) return { status: 'cancelled' };
      controller.stopSay();
      const epoch = playback.captureEpoch();
      const current = () => playback.isEpochCurrent(epoch);
      const abort = () => { if (current()) controller.stopSay(); };
      publish('preparing');
      ctx.signal?.addEventListener('abort', abort, { once: true });
      try {
        await controller.speak({ ...ctx, registerPlaybackStopper: playback.registerStopper.captureAttempt!(),
          onSpeaking: () => { if (current()) { publish('speaking'); ctx.onSpeaking(); } },
        });
        return { status: current() ? 'completed' : 'cancelled' };
      } catch (error) {
        if (!current()) return { status: 'cancelled' };
        throw error;
      } finally {
        ctx.signal?.removeEventListener('abort', abort);
        if (current()) publish('idle');
      }
    },
  };
  return controller;
}

let sharedController: LocalVoiceTtsController | null = null;

// Provider declarations are read on first use, after the storage/runtime import graph has loaded.
export const localVoiceTtsController: LocalVoiceTtsController = {
  speak: (ctx) => {
    sharedController ??= createLocalVoiceTtsController();
    return sharedController.speak(ctx);
  },
  say: (ctx) => {
    sharedController ??= createLocalVoiceTtsController();
    return sharedController.say(ctx);
  },
  stopSay: () => sharedController?.stopSay() ?? false,
  readSay: () => sharedController?.readSay() ?? 'idle',
  subscribeSay: (listener) => {
    sharedController ??= createLocalVoiceTtsController();
    return sharedController.subscribeSay(listener);
  },
};
