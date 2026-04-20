import {
  createDefaultLocalVoiceTtsProviderControllers,
  type LocalVoiceTtsController,
  type LocalVoiceTtsProviderController,
  type LocalVoiceTtsProviderId,
} from './localVoiceTtsProviderControllers';

export function createLocalVoiceTtsController(options?: Readonly<{
  controllers?: Partial<Record<LocalVoiceTtsProviderId, LocalVoiceTtsProviderController>>;
}>): LocalVoiceTtsController {
  const defaultControllers = createDefaultLocalVoiceTtsProviderControllers();
  const controllers: Record<LocalVoiceTtsProviderId, LocalVoiceTtsProviderController> = {
    device: options?.controllers?.device ?? defaultControllers.device,
    google_cloud: options?.controllers?.google_cloud ?? defaultControllers.google_cloud,
    local_neural: options?.controllers?.local_neural ?? defaultControllers.local_neural,
    openai_compat: options?.controllers?.openai_compat ?? defaultControllers.openai_compat,
  };

  return {
    speak: async (ctx) => {
      await controllers[ctx.tts.provider].speak(ctx);
    },
  };
}

export const localVoiceTtsController = createLocalVoiceTtsController();
