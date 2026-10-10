import {
  createDefaultLocalVoiceTtsProviderControllers,
  prepareLocalVoiceTtsRequest,
  reportTtsFailure,
  speakWithBundledSpeechTts,
  type LocalVoiceTtsController,
  type LocalVoiceTtsProviderController,
  type LocalVoiceTtsProviderId,
} from './localVoiceTtsProviderControllers';

export function createLocalVoiceTtsController(options?: Readonly<{
  controllers?: Partial<Record<LocalVoiceTtsProviderId, LocalVoiceTtsProviderController>>;
}>): LocalVoiceTtsController {
  const controllers = new Map(createDefaultLocalVoiceTtsProviderControllers());
  for (const [providerId, controller] of Object.entries(options?.controllers ?? {})) {
    if (controller) controllers.set(providerId, controller);
  }

  return {
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
  };
}

export const localVoiceTtsController = createLocalVoiceTtsController();
