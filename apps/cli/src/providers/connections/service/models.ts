import {
  addOrUpdateProviderManualModelV1,
  type ProviderSettingsV1,
} from '@happier-dev/protocol';

export function addInitialProviderManualModels(input: Readonly<{
  settings: ProviderSettingsV1;
  connectionId: string;
  models: readonly Readonly<{ id: string; name?: string }>[];
  addedAt: number;
}>): ProviderSettingsV1 {
  return input.models.reduce(
    (settings, model) => addOrUpdateProviderManualModelV1(settings, {
      connectionId: input.connectionId,
      model,
      addedAt: input.addedAt,
    }),
    input.settings,
  );
}
