import {
  createDefaultLocalVoiceTtsProviderControllers,
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
      const controller = controllers.get(ctx.tts.provider);
      if (controller) {
        await controller.speak(ctx);
        return;
      }
      if (await speakWithBundledSpeechTts(ctx.tts.provider, ctx)) return;
      throw Object.assign(new Error('voice_tts_provider_unavailable'), { code: 'provider_unavailable' });
    },
  };
}

export const localVoiceTtsController = createLocalVoiceTtsController();
