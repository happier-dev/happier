import type {
  ProviderCatalogRefreshResult,
} from '@/providers/probe/catalog';
import type { SavedSecret } from '@happier-dev/protocol';
import type {
  DaemonProviderModelSettingsMutationRequestV1,
  DaemonProviderModelSettingsMutationResponseV1,
} from '@happier-dev/protocol/rpc';
import type { ProviderContributionRegistryView } from '@/providers/registry';
import type { ProviderModelLoadResult } from '@/providers/modelManagement/load';
import type { createProviderConnectionService } from '@/providers/connections/service';

export type ProviderCliModelRow = Readonly<{
  id: string;
  name?: string;
  source: 'manual' | 'static' | 'probe';
  stale: boolean;
  loadState: 'loaded' | 'unloaded' | 'unknown';
}>;

export type ProviderCliSnapshot = Readonly<{
  accountSettings: Readonly<Record<string, unknown>>;
  machineId: string;
  registry: ProviderContributionRegistryView;
}>;

export type ProviderCliConnectionDependencies = Pick<
  ReturnType<typeof createProviderConnectionService>,
  | 'describe'
  | 'previewCreateContribution'
  | 'create'
  | 'update'
  | 'setEndpointOverride'
  | 'setEnabled'
  | 'bindSecret'
  | 'delete'
>;

export type ProviderCliDependencies = Readonly<{
  assertProvidersFeatureEnabled(): void;
  connections: ProviderCliConnectionDependencies;
  loadSnapshot(): Promise<ProviderCliSnapshot>;
  allocateConnectionId(): string;
  probe(input: Readonly<{ connectionId: string; machineId: string }>): Promise<ProviderCatalogRefreshResult>;
  models(input: Readonly<{ connectionId: string; machineId: string }>): Promise<readonly ProviderCliModelRow[]>;
  loadModel(input: Readonly<{
    connectionId: string;
    machineId: string;
    modelId: string;
    signal?: AbortSignal;
  }>): Promise<ProviderModelLoadResult>;
  mutateModelSettings(input: DaemonProviderModelSettingsMutationRequestV1): Promise<DaemonProviderModelSettingsMutationResponseV1>;
  readJsonFile(path: string): Promise<unknown>;
  prompt(label: string): Promise<string>;
  promptSecret(label: string): Promise<string>;
  createSavedSecret(input: Readonly<{ name: string; value: string }>): Promise<Readonly<{
    id: string;
    record: SavedSecret;
  }>>;
}>;

export type ProviderCliResult =
  | Readonly<{ ok: true; kind: string; data: unknown }>
  | Readonly<{ ok: false; kind: string; error: Readonly<{ code: string; message: string; details?: unknown }> }>;

export class ProviderCliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ProviderCliError';
  }
}
