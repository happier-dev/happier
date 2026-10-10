import type { ProviderContributionV1 } from '../contributions/v1.js';
import { readOwnRecordValue } from '../ownRecordValue.js';

export type ProviderModelPickerSourceKind = ProviderContributionV1['kind'] | 'custom';

/** Presentation policy only; it never grants access or changes a selected route. */
export function resolveProviderModelPickerVisibility(input: Readonly<{
  connectionId: string;
  kind: ProviderModelPickerSourceKind;
  modelPickerVisibilityByConnectionId?: Readonly<Record<string, boolean>>;
}>) {
  const defaultShown = input.kind !== 'aggregator';
  const override = readOwnRecordValue(input.modelPickerVisibilityByConnectionId, input.connectionId);
  return {
    shown: override ?? defaultShown,
    defaultShown,
    defaultReason: input.kind === 'aggregator' ? 'manyModels' as const : input.kind === 'local' ? 'local' as const : 'direct' as const,
  };
}
