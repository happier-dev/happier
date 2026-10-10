import { ProviderSettingsLimitError } from '@happier-dev/protocol/providers/settings/v1';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { DaemonProviderConnectionsDescribeRequestV1, DaemonProviderContributionAuthoringPreviewV1 } from '@happier-dev/protocol/rpc/providers';
import { DaemonProviderConnectionMutationResponseV1Schema, DaemonProviderModelSettingsMutationResponseV1Schema, DaemonProviderConnectionsDescribeResponseV1Schema,
  type DaemonProviderConnectionMutationRequestV1 } from '@happier-dev/protocol/rpc/providers';
import { isProviderActionMachineRequiredV1, parseProviderActionRequestV1, PROVIDER_CONNECTION_ACTION_ID_BY_OPERATION_V1,
  PROVIDER_MODEL_SETTINGS_ACTION_ID_BY_OPERATION_V1, type ProviderActionRequestV1 } from '@happier-dev/protocol/providers/providerActionsV1';
import { ProviderErrorV1Schema } from '@happier-dev/protocol/providers/errors';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ZodError } from 'zod';

import { createProviderAuthoringOperations } from './service/authoringOperations';
import { createProviderConnectionServiceContext } from './service/context';
import { createProviderAccessOperations } from './service/accessOperations';
import { createProviderLocalOperations } from './service/localOperations';
import { resolveProviderContributionRegistryEntry } from '@/providers/registry/lookup';
import {
  ProviderConnectionValidationError,
  parseProviderError,
} from './service/settings';
import type {
  ProviderConnectionServiceDeps,
  ProviderConnectionCreateInput,
  ProviderConnectionView,
  ProviderConnectionServiceResult,
  ProviderModelSettingsMutationIntent,
} from './service/types';

type ConnectionIntent<A extends DaemonProviderConnectionMutationRequestV1['action']> =
  Omit<Extract<DaemonProviderConnectionMutationRequestV1, { action: A }>, 'connectionId'> & { connectionId: string };

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
 * canonical Provider row mutation dependency.
 */
export function createProviderConnectionService(deps: ProviderConnectionServiceDeps) {
  const context = createProviderConnectionServiceContext(deps);
  const authoring = createProviderAuthoringOperations(context);
  const grants = createProviderAccessOperations(context);
  const local = createProviderLocalOperations(context);

  async function normalizeMutationResult<T extends object>(
    connectionId: string,
    operation: () => Promise<ProviderConnectionServiceResult<T>>,
  ): Promise<ProviderConnectionServiceResult<T>> {
    try {
      return await operation();
    } catch (error) {
      const providerError = parseProviderError(error);
      if (providerError) return { status: 'error', error: providerError };
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

  const machine = Object.freeze({
    describe: (input: DaemonProviderConnectionsDescribeRequestV1) =>
      normalizeMutationResult(input.connectionId ?? input.authoringPreview?.connectionId ?? '', async () => {
        const described = await context.describe({
          machineId: input.machineId,
          ...(input.connectionId ? { connectionId: input.connectionId } : {}),
        });
        if (described.status === 'error' || !input.authoringPreview) return described;
        const preview = await previewCreateContribution({
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
    setEndpointOverride: (input: Parameters<typeof authoring.setEndpointOverride>[0]) =>
      normalizeMutationResult(input.connectionId, () => authoring.setEndpointOverride(input)),
    setEnabled: (input: Parameters<typeof grants.setEnabled>[0]) => normalizeMutationResult(
      input.connectionId,
      () => grants.setEnabled(input),
    ),
    bindSecret: (input: Parameters<typeof grants.bindSecret>[0]) =>
      normalizeMutationResult(input.connectionId, () => grants.bindSecret(input)),
  });
  const executeAccount = async (request: ProviderActionRequestV1,
    preparedSavedSecret?: ProviderConnectionCreateInput['preparedSavedSecret']): Promise<ActionExecuteResult> => {
    if (!deps.featureGate.isEnabled('providers')) return { ok: false, errorCode: 'provider_feature_disabled', error: 'provider_feature_disabled',
      details: createProviderErrorV1('provider_feature_disabled', { machineId: deps.machineId }) };
    if ('machineId' in request.input && request.input.machineId !== undefined && request.input.machineId !== deps.machineId) {
      return { ok: false, errorCode: 'provider_not_enabled_on_machine', error: 'provider_not_enabled_on_machine',
        details: createProviderErrorV1('provider_not_enabled_on_machine', { machineId: request.input.machineId }) };
    }
    if (!deps.accountProviderActionExecute) return { ok: false, errorCode: 'provider_catalog_unavailable', error: 'provider_catalog_unavailable',
      details: createProviderErrorV1('provider_settings_invalid', { machineId: deps.machineId }) };
    if (preparedSavedSecret && (preparedSavedSecret.id !== preparedSavedSecret.record.id
      || !('savedSecretId' in request.input) || request.input.savedSecretId !== preparedSavedSecret.id)) {
      return { ok: false, errorCode: 'provider_connection_invalid', error: 'provider_connection_invalid',
        details: createProviderErrorV1('provider_connection_invalid', { machineId: deps.machineId }) };
    }
    return deps.accountProviderActionExecute(request, preparedSavedSecret);
  };
  const accountFailure = (result: Extract<Awaited<ReturnType<typeof executeAccount>>, { ok: false }>) => {
    const typed = ProviderErrorV1Schema.safeParse(result.details);
    return { status: 'error' as const, error: typed.success ? typed.data : createProviderErrorV1(
      result.errorCode === 'provider_catalog_conflict' || result.errorCode === 'provider_catalog_settings-conflict'
        ? 'provider_connection_changed'
        : result.errorCode === 'provider_catalog_outcome_unknown' ? 'provider_rpc_mutation_outcome_unknown'
        : result.errorCode === 'provider_catalog_invalid-reference' ? 'provider_secret_missing' : 'provider_settings_invalid',
      { machineId: deps.machineId },
    ) };
  };
  const connectionMutation = async (request: ProviderActionRequestV1,
    preparedSavedSecret?: ProviderConnectionCreateInput['preparedSavedSecret']) => {
    const result = await executeAccount(request, preparedSavedSecret);
    return result.ok ? DaemonProviderConnectionMutationResponseV1Schema.parse(result.result) : accountFailure(result);
  };
  const flatAccountMutation = async (request: ProviderActionRequestV1,
    preparedSavedSecret?: ProviderConnectionCreateInput['preparedSavedSecret']) => {
    const result = await connectionMutation(request, preparedSavedSecret);
    if (result.status === 'error') return result;
    if ('connection' in result) return { status: 'success' as const, ...result.connection };
    return { status: 'error' as const, error: createProviderErrorV1('provider_rpc_response_invalid', { machineId: deps.machineId }) };
  };
  const requestFor = (value: Readonly<{ action: DaemonProviderConnectionMutationRequestV1['action'] }>) =>
    parseProviderActionRequestV1(PROVIDER_CONNECTION_ACTION_ID_BY_OPERATION_V1[value.action], value);
  const withIntent = <T extends object>(value: Readonly<{ action: DaemonProviderConnectionMutationRequestV1['action']; connectionId: string }>,
    run: (request: ProviderActionRequestV1) => Promise<ProviderConnectionServiceResult<T>>) =>
    normalizeMutationResult(value.connectionId, () => run(requestFor(value)));
  const previewCreateContribution = (value: Parameters<typeof authoring.previewCreateContribution>[0]): Promise<ProviderConnectionServiceResult<Readonly<{
    connectionId: string; created: boolean; authoringPreview: DaemonProviderContributionAuthoringPreviewV1;
  }>>> => normalizeMutationResult(value.connectionId, async () => {
      if (!deps.featureGate.isEnabled('providers')) return { status: 'error', error: createProviderErrorV1('provider_feature_disabled', { machineId: deps.machineId }) };
      if (value.machineId !== deps.machineId) return { status: 'error', error: createProviderErrorV1('provider_not_enabled_on_machine', { machineId: value.machineId }) };
      const source = resolveProviderContributionRegistryEntry((await deps.loadSnapshot()).registry, value.contributionKey);
      const needsSelection = !value.endpointOverrides?.length && source?.contribution.definition.endpointTemplates.some(endpoint =>
        'localUrlCandidates' in endpoint && endpoint.localUrlCandidates && endpoint.localUrlCandidates.length > 1);
      if (value.selectedCandidateId != null || needsSelection) return machine.previewCreateContribution(value);
      const request = parseProviderActionRequestV1('providers.connections.describe', { authoringPreview: {
        connectionId: value.connectionId, contributionKey: value.contributionKey, displayName: value.displayName,
        selectedCandidateId: null, endpointOverrides: value.endpointOverrides ?? [],
      } });
      const result = await executeAccount(request);
      if (!result.ok) return accountFailure(result);
      const described = DaemonProviderConnectionsDescribeResponseV1Schema.parse(result.result);
      if (described.status === 'success' && described.authoringPreview?.status === 'resolved') return {
        status: 'success', connectionId: described.authoringPreview.connectionId, created: described.authoringPreview.created,
        authoringPreview: described.authoringPreview,
      };
      return { status: 'error', error: createProviderErrorV1('provider_rpc_response_invalid', { machineId: deps.machineId }) };
    });
  return Object.freeze({
    ...machine,
    previewCreateContribution,
    create: async (value: ProviderConnectionCreateInput): Promise<ProviderConnectionServiceResult<{ connection: ProviderConnectionView; created: boolean }>> => {
      const { preparedSavedSecret, ...intent } = value;
      return withIntent(intent, async request => {
        if (isProviderActionMachineRequiredV1(request)) return machine.create(value);
        const result = await connectionMutation(request, preparedSavedSecret);
        if (result.status === 'error') return result;
        if ('connection' in result) return { status: 'success', connection: result.connection, created: result.created ?? false };
        return { status: 'error', error: createProviderErrorV1('provider_rpc_response_invalid', { machineId: deps.machineId }) };
      });
    },
    update: (value: Extract<DaemonProviderConnectionMutationRequestV1, { action: 'update' }>) => withIntent(value, flatAccountMutation),
    duplicate: (value: Omit<ConnectionIntent<'duplicate'>, 'newConnectionId'> & { newConnectionId: string }) => withIntent(value, flatAccountMutation),
    delete: async (value: ConnectionIntent<'delete'>): Promise<ProviderConnectionServiceResult<{ connectionId: string }>> => {
      return withIntent(value, async request => {
        const result = await connectionMutation(request);
        if (result.status === 'error') return result;
        if ('deletedConnectionId' in result) return { status: 'success', connectionId: result.deletedConnectionId };
        return { status: 'error', error: createProviderErrorV1('provider_rpc_response_invalid', { machineId: deps.machineId }) };
      });
    },
    setEndpointOverride: (value: ConnectionIntent<'setEndpointOverride'>) => withIntent(value, request => isProviderActionMachineRequiredV1(request)
      ? machine.setEndpointOverride(value) : flatAccountMutation(request)),
    setEnabled: (value: ConnectionIntent<'setEnabled'>) => withIntent(value, request => isProviderActionMachineRequiredV1(request)
      ? machine.setEnabled(value) : flatAccountMutation(request)),
    bindSecret: (value: ConnectionIntent<'bindSecret'> & { preparedSavedSecret?: ProviderConnectionCreateInput['preparedSavedSecret'] }) => {
      const { preparedSavedSecret, ...intent } = value;
      return withIntent(intent, request => isProviderActionMachineRequiredV1(request) ? machine.bindSecret(value)
        : flatAccountMutation(request, preparedSavedSecret));
    },
    mutateModelSettings: async (value: ProviderModelSettingsMutationIntent) => {
      const intent = value.action === 'manualAdd' ? (({ expectedManualSource: _source, ...request }) => request)(value) : value;
      const request = parseProviderActionRequestV1(PROVIDER_MODEL_SETTINGS_ACTION_ID_BY_OPERATION_V1[intent.action], intent);
      const result = await executeAccount(request);
      return result.ok ? DaemonProviderModelSettingsMutationResponseV1Schema.parse(result.result) : accountFailure(result);
    },
  });
}
