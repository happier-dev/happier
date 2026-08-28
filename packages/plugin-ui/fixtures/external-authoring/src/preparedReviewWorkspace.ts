import type {
  PluginUiHostApi,
  PluginUiJsonObjectV1,
  PluginUiTargetedContributionOperationV1,
} from '@happier-dev/plugin-sdk/ui';

/**
 * Public-only external-author proof for the positive prepared-workspace flow.
 * The selected operation remains the authority; authors never supply a raw
 * materialized path or a provider-specific host callback.
 */
export async function openPreparedReviewWorkspaceFromExternalPlugin(input: Readonly<{
  hostApi: Pick<PluginUiHostApi, 'selectActionInput' | 'openNewSession'>;
  operation: PluginUiTargetedContributionOperationV1;
  draft: PluginUiJsonObjectV1;
  prompt?: string;
  signal?: AbortSignal;
}>): Promise<'opened' | 'cancelled' | 'unavailable'> {
  const selected = await input.hostApi.selectActionInput(
    { operation: input.operation, draft: input.draft },
    input.signal === undefined ? undefined : { signal: input.signal },
  );
  if (selected.kind === 'cancelled') return 'cancelled';
  if (selected.kind !== 'submitted') return 'unavailable';
  await input.hostApi.openNewSession(
    {
      checkoutIntent: 'preparedReviewWorkspace',
      ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
    },
    {
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      preparedReviewWorkspace: { operation: input.operation, result: selected },
    },
  );
  return 'opened';
}
