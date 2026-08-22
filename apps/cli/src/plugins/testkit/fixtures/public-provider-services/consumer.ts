import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type {
  ProviderBindingStatusRequest,
  ProviderConnectionMutationRequest,
  ProviderConnectionsDescribeRequest,
  ProviderModelLoadRequest,
  ProviderModelProjectionRequest,
  ProviderModelsRequest,
  ProviderModelSettingsMutationRequest,
  ProviderProbeRequest,
  ProviderProfileMigrationConfirmRequest,
  ProviderProfileMigrationConflictConfirmRequest,
  ProviderProfileMigrationPreviewRequest,
} from '@happier-dev/plugin-sdk/providers';

export type PublicProviderOperationRequests = Readonly<{
  describe: ProviderConnectionsDescribeRequest;
  mutate: ProviderConnectionMutationRequest;
  bindingStatus: ProviderBindingStatusRequest;
  probe: ProviderProbeRequest;
  listModels: ProviderModelsRequest;
  setModelLoad: ProviderModelLoadRequest;
  projectModels: ProviderModelProjectionRequest;
  mutateModelSettings: ProviderModelSettingsMutationRequest;
  previewMigration: ProviderProfileMigrationPreviewRequest;
  confirmMigration: ProviderProfileMigrationConfirmRequest;
  confirmMigrationConflict: ProviderProfileMigrationConflictConfirmRequest;
}>;

export const PUBLIC_PROVIDER_OPERATION_IDS = Object.freeze([
  'connections.describe',
  'connections.mutate',
  'connections.bindingStatus',
  'catalog.probe',
  'catalog.listModels',
  'catalog.setModelLoad',
  'catalog.projectModels',
  'catalog.mutateModelSettings',
  'migrations.preview',
  'migrations.confirm',
  'migrations.confirmConflict',
] as const);

/** External-shaped consumer: imports only public SDK paths and reaches every
 * Provider operation through the ordinary invocation context authors receive. */
export async function runPublicProviderOperations(
  context: Pick<PluginInvocationContext, 'services'>,
  requests: PublicProviderOperationRequests,
): Promise<readonly Readonly<{ operation: string; result: unknown }>[]> {
  const providers = context.services.providers;
  return Object.freeze([
    { operation: 'connections.describe', result: await providers.connections.describe(requests.describe) },
    { operation: 'connections.mutate', result: await providers.connections.mutate(requests.mutate) },
    { operation: 'connections.bindingStatus', result: await providers.connections.bindingStatus(requests.bindingStatus) },
    { operation: 'catalog.probe', result: await providers.catalog.probe(requests.probe) },
    { operation: 'catalog.listModels', result: await providers.catalog.listModels(requests.listModels) },
    { operation: 'catalog.setModelLoad', result: await providers.catalog.setModelLoad(requests.setModelLoad) },
    { operation: 'catalog.projectModels', result: await providers.catalog.projectModels(requests.projectModels) },
    { operation: 'catalog.mutateModelSettings', result: await providers.catalog.mutateModelSettings(requests.mutateModelSettings) },
    { operation: 'migrations.preview', result: await providers.migrations.preview(requests.previewMigration) },
    { operation: 'migrations.confirm', result: await providers.migrations.confirm(requests.confirmMigration) },
    { operation: 'migrations.confirmConflict', result: await providers.migrations.confirmConflict(requests.confirmMigrationConflict) },
  ]);
}
