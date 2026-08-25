import {
  ProviderErrorV1Schema,
  ProviderSettingsLimitError,
  createProviderErrorV1,
} from '@happier-dev/protocol';
import type { DaemonProviderConnectionsDescribeRequestV1 } from '@happier-dev/protocol/rpc';
import { ZodError } from 'zod';

import { createProviderAuthoringOperations } from './service/authoringOperations';
import { createProviderConnectionServiceContext } from './service/context';
import { createProviderAccessOperations } from './service/accessOperations';
import { createProviderLocalOperations } from './service/localOperations';
import { createProviderModelSettingsOperations } from './service/modelSettingsOperations';
import {
  ProviderConnectionValidationError,
  isProviderError,
} from './service/settings';
import type {
  ProviderConnectionServiceDeps,
  ProviderConnectionServiceResult,
  ProviderModelSettingsMutationIntent,
} from './service/types';

export type {
  ProviderConnectionCreateInput,
  ProviderConnectionRuntimeProjection,
  ProviderConnectionRegistryProjection,
  ProviderConnectionRuntimeSummary,
  ProviderConnectionRuntimeSummaryInput,
  ProviderConnectionServiceResult,
  ProviderConnectionView,
  ProviderDetectedEnableInput,
  ProviderModelSettingsMutationIntent,
} from './service/types';

/**
 * Single public Provider-connection facade. Operation modules own cohesive
 * behavior; this boundary owns shared error normalization and the one injected
 * account-settings CAS dependency.
 */
export function createProviderConnectionService(deps: ProviderConnectionServiceDeps) {
  const context = createProviderConnectionServiceContext(deps);
  const authoring = createProviderAuthoringOperations(context);
  const grants = createProviderAccessOperations(context);
  const local = createProviderLocalOperations(context);
  const modelSettings = createProviderModelSettingsOperations(context);

  async function normalizeMutationResult<T extends object>(
    connectionId: string,
    operation: () => Promise<ProviderConnectionServiceResult<T>>,
  ): Promise<ProviderConnectionServiceResult<T>> {
    try {
      return await operation();
    } catch (error) {
      if (isProviderError(error)) return { status: 'error', error };
      if (error instanceof ProviderSettingsLimitError) {
        return { status: 'error', error: createProviderErrorV1('provider_settings_limit_exceeded', {
          connectionId, machineId: deps.machineId,
        }) };
      }
      if (error instanceof ProviderConnectionValidationError || error instanceof ZodError) {
        return { status: 'error', error: createProviderErrorV1('provider_connection_invalid', {
          ...(connectionId ? { connectionId } : {}), machineId: deps.machineId,
        }) };
      }
      throw error;
    }
  }

  async function normalizeModelSettingsMutation(
    input: ProviderModelSettingsMutationIntent,
  ) {
    const connectionId = 'connectionId' in input ? input.connectionId : '';
    try {
      return await modelSettings.mutate(input);
    } catch (error) {
      const providerError = ProviderErrorV1Schema.safeParse(error);
      if (providerError.success) return { status: 'error' as const, error: providerError.data };
      return {
        status: 'error' as const,
        error: createProviderErrorV1(
          error instanceof ProviderSettingsLimitError
            ? 'provider_settings_limit_exceeded'
            : 'provider_settings_invalid',
          {
            ...(connectionId ? { connectionId } : {}),
            machineId: deps.machineId,
          },
        ),
      };
    }
  }

  return Object.freeze({
    describe: (input: DaemonProviderConnectionsDescribeRequestV1) =>
      normalizeMutationResult(input.connectionId ?? input.authoringPreview?.connectionId ?? '', async () => {
        const described = await context.describe({
          machineId: input.machineId,
          ...(input.connectionId ? { connectionId: input.connectionId } : {}),
        });
        if (described.status === 'error' || !input.authoringPreview) return described;
        const preview = await authoring.previewCreateContribution({
          machineId: input.machineId,
          ...input.authoringPreview,
        });
        return preview.status === 'error'
          ? preview
          : { ...described, authoringPreview: preview.authoringPreview };
      }),
    previewCreateContribution: (input: Parameters<typeof authoring.previewCreateContribution>[0]) =>
      normalizeMutationResult(input.connectionId, () => authoring.previewCreateContribution(input)),
    create: (input: Parameters<typeof authoring.create>[0]) =>
      normalizeMutationResult(input.connectionId, () => authoring.create(input)),
    enableDetected: (input: Parameters<typeof local.enableDetected>[0]) =>
      normalizeMutationResult(input.connectionId, () => local.enableDetected(input)),
    startLocal: (input: Parameters<typeof local.startLocal>[0]) =>
      normalizeMutationResult(input.connectionId ?? '', () => local.startLocal(input)),
    update: (input: Parameters<typeof authoring.update>[0]) =>
      normalizeMutationResult(input.connectionId, () => authoring.update(input)),
    setEndpointOverride: (input: Parameters<typeof authoring.setEndpointOverride>[0]) =>
      normalizeMutationResult(input.connectionId, () => authoring.setEndpointOverride(input)),
    duplicate: (input: Parameters<typeof authoring.duplicate>[0]) =>
      normalizeMutationResult(input.connectionId, () => authoring.duplicate(input)),
    setEnabled: (input: Parameters<typeof grants.setEnabled>[0]) => normalizeMutationResult(
      input.connectionId,
      () => grants.setEnabled(input),
    ),
    bindSecret: (input: Parameters<typeof grants.bindSecret>[0]) =>
      normalizeMutationResult(input.connectionId, () => grants.bindSecret(input)),
    delete: (input: Parameters<typeof authoring.delete>[0]) =>
      normalizeMutationResult(input.connectionId, () => authoring.delete(input)),
    mutateModelSettings: (input: ProviderModelSettingsMutationIntent) =>
      normalizeModelSettingsMutation(input),
  });
}
