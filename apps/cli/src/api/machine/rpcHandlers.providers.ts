import {
  DaemonProviderModelLoadResponseV1Schema,
  DaemonProviderConnectionsDescribeRequestV1Schema,
  DaemonProviderConnectionsDescribeResponseV1Schema,
  DaemonProviderConnectionMutationRequestV1Schema,
  DaemonProviderConnectionMutationResponseV1Schema,
  DaemonProviderProbeRequestV1Schema,
  DaemonProviderModelsResponseV1Schema,
  DaemonProviderProbeResponseV1Schema,
  DaemonProviderModelProjectionRequestV1Schema,
  DaemonProviderModelProjectionResponseV1Schema,
  DaemonProviderModelSettingsMutationRequestV1Schema,
  DaemonProviderModelSettingsMutationResponseV1Schema,
  DaemonProviderBindingStatusRequestV1Schema,
  DaemonProviderBindingStatusResponseV1Schema,
  DaemonProviderProfileMigrationPreviewRequestV1Schema,
  DaemonProviderProfileMigrationPreviewResponseV1Schema,
  DaemonProviderProfileMigrationConfirmRequestV1Schema,
  DaemonProviderProfileMigrationConfirmResponseV1Schema,
  DaemonProviderProfileMigrationConflictConfirmRequestV1Schema,
  DaemonProviderProfileMigrationConflictConfirmResponseV1Schema,
  RPC_METHODS,
} from '@happier-dev/protocol/rpc';
import { createProviderErrorV1 } from '@happier-dev/protocol';
import type { ProviderCatalogRefreshResult } from '@/providers/probe/catalog';
import type {
  ProviderModelLoadRequest,
  ProviderModelLoadResult,
} from '@/providers/modelManagement/load';
import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { createProviderModelLoadRpcHandler } from '@/providers/modelManagement/rpc';
import {
  createProviderSavedModelsRpcHandler,
} from '@/providers/probe/rpc';
import type {
  ProviderProbeWaiterLifetime,
  ProviderSavedModelsRpcResult,
} from '@/providers/probe/rpc';
import type { DaemonProviderDraftProbeRequestV1 } from '@happier-dev/protocol/rpc';
import type {
  DaemonProviderConnectionMutationRequestV1,
  DaemonProviderConnectionMutationResponseV1,
  DaemonProviderConnectionsDescribeRequestV1,
  DaemonProviderConnectionsDescribeResponseV1,
  DaemonProviderModelProjectionRequestV1,
  DaemonProviderModelProjectionResponseV1,
  DaemonProviderModelSettingsMutationRequestV1,
  DaemonProviderModelSettingsMutationResponseV1,
  DaemonProviderBindingStatusRequestV1,
  DaemonProviderBindingStatusResponseV1,
  DaemonProviderProfileMigrationPreviewRequestV1,
  DaemonProviderProfileMigrationPreviewResponseV1,
  DaemonProviderProfileMigrationConfirmRequestV1,
  DaemonProviderProfileMigrationConfirmResponseV1,
  DaemonProviderProfileMigrationConflictConfirmRequestV1,
  DaemonProviderProfileMigrationConflictConfirmResponseV1,
} from '@happier-dev/protocol/rpc';

export type MachineProviderRpcServices = Readonly<{
  probe(
    input: Readonly<{ connectionId: string; machineId: string }>,
    waiterLifetime?: ProviderProbeWaiterLifetime,
  ): Promise<ProviderCatalogRefreshResult>;
  probeDraft(
    input: DaemonProviderDraftProbeRequestV1,
    waiterLifetime?: ProviderProbeWaiterLifetime,
  ): Promise<ProviderCatalogRefreshResult>;
  models(input: Readonly<{ connectionId: string; machineId: string }>): Promise<ProviderSavedModelsRpcResult>;
  loadModel(input: ProviderModelLoadRequest): Promise<ProviderModelLoadResult>;
  cancelModelLoad(input: ProviderModelLoadRequest): Promise<ProviderModelLoadResult>;
  describeConnections(input: DaemonProviderConnectionsDescribeRequestV1): Promise<DaemonProviderConnectionsDescribeResponseV1>;
  mutateConnection(input: DaemonProviderConnectionMutationRequestV1): Promise<DaemonProviderConnectionMutationResponseV1>;
  projectModels(input: DaemonProviderModelProjectionRequestV1): Promise<DaemonProviderModelProjectionResponseV1>;
  mutateModelSettings(input: DaemonProviderModelSettingsMutationRequestV1): Promise<DaemonProviderModelSettingsMutationResponseV1>;
  resolveBindingStatus(input: DaemonProviderBindingStatusRequestV1): Promise<DaemonProviderBindingStatusResponseV1>;
  previewProfileMigration(input: DaemonProviderProfileMigrationPreviewRequestV1): Promise<DaemonProviderProfileMigrationPreviewResponseV1>;
  confirmProfileMigration(input: DaemonProviderProfileMigrationConfirmRequestV1): Promise<DaemonProviderProfileMigrationConfirmResponseV1>;
  confirmProfileMigrationConflict(input: DaemonProviderProfileMigrationConflictConfirmRequestV1): Promise<DaemonProviderProfileMigrationConflictConfirmResponseV1>;
}>;

/** Strict identity-only daemon RPC adapter; all provider behavior stays in services. */
export function registerMachineProviderRpcHandlers(input: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  machineId: string;
  services: MachineProviderRpcServices;
  featureGate: Readonly<{ isEnabled(featureId: 'providers'): boolean }>;
}>): void {
  const featureDisabled = (request: Readonly<{
    connectionId?: string;
    machineId: string;
    sourceProfileId?: string;
  }>) => ({
    status: 'error' as const,
    error: createProviderErrorV1('provider_feature_disabled', {
      ...(request.connectionId ? { connectionId: request.connectionId } : {}),
      machineId: request.machineId,
      ...(request.sourceProfileId ? { sourceProfileId: request.sourceProfileId } : {}),
    }),
  });
  input.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
    async (raw) => {
      const request = DaemonProviderConnectionsDescribeRequestV1Schema.parse(raw);
      const result = !input.featureGate.isEnabled('providers')
        ? featureDisabled(request)
        : request.machineId !== input.machineId
          ? { status: 'error' as const, error: createProviderErrorV1('provider_not_enabled_on_machine', {
              ...(request.connectionId ? { connectionId: request.connectionId } : {}),
              machineId: request.machineId,
            }) }
          : await input.services.describeConnections(request);
      return DaemonProviderConnectionsDescribeResponseV1Schema.parse(result);
    },
  );
  input.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_PREVIEW,
    async (raw) => {
      const request = DaemonProviderProfileMigrationPreviewRequestV1Schema.parse(raw);
      const result = !input.featureGate.isEnabled('providers')
        ? featureDisabled(request)
        : request.machineId !== input.machineId
          ? {
              status: 'error' as const,
              error: createProviderErrorV1('provider_not_enabled_on_machine', {
                machineId: request.machineId,
                sourceProfileId: request.sourceProfileId,
              }),
            }
          : await input.services.previewProfileMigration(request);
      return DaemonProviderProfileMigrationPreviewResponseV1Schema.parse(result);
    },
  );
  input.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_CONFIRM,
    async (raw) => {
      const request = DaemonProviderProfileMigrationConfirmRequestV1Schema.parse(raw);
      const result = !input.featureGate.isEnabled('providers')
        ? featureDisabled(request)
        : request.machineId !== input.machineId
          ? {
              status: 'error' as const,
              error: createProviderErrorV1('provider_not_enabled_on_machine', {
                machineId: request.machineId,
                sourceProfileId: request.sourceProfileId,
              }),
            }
          : await input.services.confirmProfileMigration(request);
      return DaemonProviderProfileMigrationConfirmResponseV1Schema.parse(result);
    },
  );
  input.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_CONFLICT_CONFIRM,
    async (raw) => {
      const request = DaemonProviderProfileMigrationConflictConfirmRequestV1Schema.parse(raw);
      const result = !input.featureGate.isEnabled('providers')
        ? featureDisabled(request)
        : request.machineId !== input.machineId
          ? {
              status: 'error' as const,
              error: createProviderErrorV1('provider_not_enabled_on_machine', {
                machineId: request.machineId,
                sourceProfileId: request.sourceProfileId,
              }),
            }
          : await input.services.confirmProfileMigrationConflict(request);
      return DaemonProviderProfileMigrationConflictConfirmResponseV1Schema.parse(result);
    },
  );
  input.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE,
    async (raw) => {
      const request = DaemonProviderConnectionMutationRequestV1Schema.parse(raw);
      const result = !input.featureGate.isEnabled('providers')
        ? featureDisabled(request)
        : request.machineId !== input.machineId
          ? { status: 'error' as const, error: createProviderErrorV1('provider_not_enabled_on_machine', request) }
          : await input.services.mutateConnection(request);
      return DaemonProviderConnectionMutationResponseV1Schema.parse(result);
    },
  );
  input.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_PROVIDERS_PROBE,
    async (raw, context) => {
      const request = DaemonProviderProbeRequestV1Schema.parse(raw);
      const identity = 'kind' in request
        ? { connectionId: request.draftConnectionId, machineId: request.machineId }
        : request;
      const result = !input.featureGate.isEnabled('providers')
        ? featureDisabled(identity)
        : identity.machineId !== input.machineId
        ? {
            status: 'error' as const,
            error: createProviderErrorV1('provider_not_enabled_on_machine', identity),
          }
        : 'kind' in request
            ? context?.signal
              ? await input.services.probeDraft(request, { signal: context.signal })
              : await input.services.probeDraft(request)
            : context?.signal
              ? await input.services.probe(request, { signal: context.signal })
              : await input.services.probe(request);
      return DaemonProviderProbeResponseV1Schema.parse(result);
    },
  );
  input.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_PROVIDERS_MODELS,
    async (raw) => DaemonProviderModelsResponseV1Schema.parse(
      await createProviderSavedModelsRpcHandler({
        machineId: input.machineId,
        models: async (request) => input.featureGate.isEnabled('providers')
          ? input.services.models(request)
          : featureDisabled(request),
      })(raw),
    ),
  );
  input.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_PROVIDERS_MODEL_LOAD,
    async (raw, context) => DaemonProviderModelLoadResponseV1Schema.parse(
      await createProviderModelLoadRpcHandler({
        machineId: input.machineId,
        loadNow: async (request) => input.featureGate.isEnabled('providers')
          ? input.services.loadModel(request)
          : featureDisabled(request),
        cancelNow: input.services.cancelModelLoad,
      })(raw, context),
    ),
  );
  input.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION,
    async (raw) => {
      const request = DaemonProviderModelProjectionRequestV1Schema.parse(raw);
      const result = !input.featureGate.isEnabled('providers')
        ? featureDisabled(request)
        : request.machineId !== input.machineId
          ? { status: 'error' as const, error: createProviderErrorV1('provider_not_enabled_on_machine', {
              machineId: request.machineId,
            }) }
          : await input.services.projectModels(request);
      return DaemonProviderModelProjectionResponseV1Schema.parse(result);
    },
  );
  input.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_PROVIDERS_MODEL_SETTINGS_MUTATE,
    async (raw) => {
      const request = DaemonProviderModelSettingsMutationRequestV1Schema.parse(raw);
      const connectionId = 'connectionId' in request ? request.connectionId : undefined;
      const result = !input.featureGate.isEnabled('providers')
        ? featureDisabled({ machineId: request.machineId, ...(connectionId ? { connectionId } : {}) })
        : request.machineId !== input.machineId
          ? { status: 'error' as const, error: createProviderErrorV1('provider_not_enabled_on_machine', {
              machineId: request.machineId, ...(connectionId ? { connectionId } : {}),
            }) }
          : await input.services.mutateModelSettings(request);
      return DaemonProviderModelSettingsMutationResponseV1Schema.parse(result);
    },
  );
  input.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_PROVIDERS_BINDING_STATUS,
    async (raw) => {
      const request = DaemonProviderBindingStatusRequestV1Schema.parse(raw);
      const result = !input.featureGate.isEnabled('providers')
        ? {
            status: 'disabled' as const,
            error: createProviderErrorV1('provider_feature_disabled', {
              connectionId: request.launchBinding.connectionId,
              machineId: request.machineId,
            }),
          }
        : request.machineId !== input.machineId
          ? {
              status: 'disabled' as const,
              error: createProviderErrorV1('provider_not_enabled_on_machine', {
                connectionId: request.launchBinding.connectionId,
                machineId: request.machineId,
              }),
            }
          : await input.services.resolveBindingStatus(request);
      return DaemonProviderBindingStatusResponseV1Schema.parse(result);
    },
  );
}
