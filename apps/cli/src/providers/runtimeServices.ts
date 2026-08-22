import {
  DaemonProviderBindingStatusRequestV1Schema,
  DaemonProviderBindingStatusResponseV1Schema,
  DaemonProviderConnectionMutationRequestV1Schema,
  DaemonProviderConnectionMutationResponseV1Schema,
  DaemonProviderConnectionsDescribeRequestV1Schema,
  DaemonProviderConnectionsDescribeResponseV1Schema,
  DaemonProviderModelLoadRequestV1Schema,
  DaemonProviderModelLoadResponseV1Schema,
  DaemonProviderModelProjectionRequestV1Schema,
  DaemonProviderModelProjectionResponseV1Schema,
  DaemonProviderModelsRequestV1Schema,
  DaemonProviderModelsResponseV1Schema,
  DaemonProviderModelSettingsMutationRequestV1Schema,
  DaemonProviderModelSettingsMutationResponseV1Schema,
  DaemonProviderProbeRequestV1Schema,
  DaemonProviderProbeResponseV1Schema,
  DaemonProviderProfileMigrationConfirmRequestV1Schema,
  DaemonProviderProfileMigrationConfirmResponseV1Schema,
  DaemonProviderProfileMigrationConflictConfirmRequestV1Schema,
  DaemonProviderProfileMigrationConflictConfirmResponseV1Schema,
  DaemonProviderProfileMigrationPreviewRequestV1Schema,
  DaemonProviderProfileMigrationPreviewResponseV1Schema,
  type DaemonProviderModelLoadResponseV1,
} from '@happier-dev/protocol/rpc';
import {
  createProviderErrorV1,
  ProviderErrorV1Schema,
  type ProviderErrorV1,
} from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginCancellationOptions } from '@happier-dev/plugin-sdk';
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
  ProvidersService,
} from '@happier-dev/plugin-sdk/providers';

import type { MachineProviderRpcServices } from '@/api/machine/rpcHandlers.providers';

export type RuntimeProviderOperationsBinding = Readonly<{
  signal: AbortSignal;
  isCurrent(): boolean;
}>;

export type RuntimeProviderOperationsProducer = Readonly<{
  machineServices: MachineProviderRpcServices;
  bind(binding: RuntimeProviderOperationsBinding): ProvidersService;
}>;

export type RuntimeProviderOperationsSource = Readonly<{
  bind(binding: RuntimeProviderOperationsBinding): ProvidersService;
}>;

export type RuntimeProviderOperationsFeatureGate = Readonly<{
  isEnabled(featureId: 'providers'): boolean;
}>;

function generationStale(): PluginError {
  return new PluginError({
    code: 'plugin_generation_stale',
    message: 'Plugin generation is stale',
  });
}

function operationAborted(): PluginError {
  return new PluginError({
    code: 'plugin_operation_aborted',
    message: 'Provider operation was aborted',
  });
}

function providerOperationsUnavailable(): PluginError {
  return new PluginError({
    code: 'plugin_service_unavailable',
    message: 'Provider operations are unavailable',
  });
}

/**
 * Keeps the invocation's exact lifetime binding while machine bootstrap
 * installs the single canonical Provider producer. Registry publication is a
 * prerequisite of that bootstrap, so resolving the producer when each method
 * is invoked prevents an early service snapshot from staying unavailable.
 */
export function createCurrentRuntimeProviderOperationsSource(
  readProducer: () => RuntimeProviderOperationsProducer | null,
): RuntimeProviderOperationsSource {
  return Object.freeze({
    bind(binding) {
      const readBound = (): ProvidersService => {
        const producer = readProducer();
        if (!producer) throw providerOperationsUnavailable();
        return producer.bind(binding);
      };
      const service: ProvidersService = {
        connections: {
          describe: async (request, options) =>
            await readBound().connections.describe(request, options),
          mutate: async (request, options) =>
            await readBound().connections.mutate(request, options),
          bindingStatus: async (request, options) =>
            await readBound().connections.bindingStatus(request, options),
        },
        catalog: {
          probe: async (request, options) =>
            await readBound().catalog.probe(request, options),
          listModels: async (request, options) =>
            await readBound().catalog.listModels(request, options),
          setModelLoad: async (request, options) =>
            await readBound().catalog.setModelLoad(request, options),
          projectModels: async (request, options) =>
            await readBound().catalog.projectModels(request, options),
          mutateModelSettings: async (request, options) =>
            await readBound().catalog.mutateModelSettings(request, options),
        },
        migrations: {
          preview: async (request, options) =>
            await readBound().migrations.preview(request, options),
          confirm: async (request, options) =>
            await readBound().migrations.confirm(request, options),
          confirmConflict: async (request, options) =>
            await readBound().migrations.confirmConflict(request, options),
        },
      };
      Object.freeze(service.connections);
      Object.freeze(service.catalog);
      Object.freeze(service.migrations);
      return Object.freeze(service);
    },
  });
}

function isBindingCurrent(binding: RuntimeProviderOperationsBinding): boolean {
  if (binding.signal.aborted) return false;
  try {
    return binding.isCurrent() === true;
  } catch {
    return false;
  }
}

function assertPreAdmissionCurrent(
  binding: RuntimeProviderOperationsBinding,
  options?: PluginCancellationOptions,
): void {
  assertInvocationCurrent(binding);
  if (options?.signal?.aborted) throw operationAborted();
}

function assertInvocationCurrent(binding: RuntimeProviderOperationsBinding): void {
  if (!isBindingCurrent(binding)) throw generationStale();
}

function readInterruption(
  binding: RuntimeProviderOperationsBinding,
): PluginError {
  return isBindingCurrent(binding) ? operationAborted() : generationStale();
}

async function waitForReadResult<TResult>(
  result: Promise<TResult>,
  binding: RuntimeProviderOperationsBinding,
  options?: PluginCancellationOptions,
): Promise<TResult> {
  const signals = options?.signal && options.signal !== binding.signal
    ? [binding.signal, options.signal]
    : [binding.signal];
  let onAbort: (() => void) | null = null;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(readInterruption(binding));
    for (const signal of signals) signal.addEventListener('abort', onAbort, { once: true });
    if (signals.some((signal) => signal.aborted)) onAbort();
  });
  try {
    const value = await Promise.race([result, interrupted]);
    assertPreAdmissionCurrent(binding, options);
    return value;
  } finally {
    if (onAbort) {
      for (const signal of signals) signal.removeEventListener('abort', onAbort);
    }
  }
}

async function executeRead<TRequest, TResult>(input: Readonly<{
  binding: RuntimeProviderOperationsBinding;
  options: PluginCancellationOptions | undefined;
  prepare(): TRequest;
  dispatch(request: TRequest): Promise<unknown>;
  parseResult(value: unknown): TResult;
}>): Promise<TResult> {
  assertPreAdmissionCurrent(input.binding, input.options);
  const request = input.prepare();
  assertPreAdmissionCurrent(input.binding, input.options);
  const result = input.dispatch(request).then(input.parseResult);
  return await waitForReadResult(result, input.binding, input.options);
}

async function executeMutation<TRequest, TResult>(input: Readonly<{
  binding: RuntimeProviderOperationsBinding;
  options: PluginCancellationOptions | undefined;
  prepare(): TRequest;
  dispatch(request: TRequest): Promise<unknown>;
  parseResult(value: unknown): TResult;
  failure(error: ProviderErrorV1): TResult;
  errorContext(request: TRequest): Readonly<{
    connectionId?: string;
    machineId?: string;
    sourceProfileId?: string;
  }>;
}>): Promise<TResult> {
  assertPreAdmissionCurrent(input.binding, input.options);
  const request = input.prepare();
  assertPreAdmissionCurrent(input.binding, input.options);
  try {
    return input.parseResult(await input.dispatch(request));
  } catch (error) {
    const typed = ProviderErrorV1Schema.safeParse(error);
    return input.failure(typed.success
      ? typed.data
      : createProviderErrorV1('provider_rpc_mutation_outcome_unknown', input.errorContext(request)));
  }
}

function composeOperationSignal(
  binding: RuntimeProviderOperationsBinding,
  options?: PluginCancellationOptions,
): AbortSignal {
  return options?.signal && options.signal !== binding.signal
    ? AbortSignal.any([binding.signal, options.signal])
    : binding.signal;
}

function modelLoadCancelled(): DaemonProviderModelLoadResponseV1 {
  return { status: 'cancelled', providerMayContinue: true };
}

async function dispatchWhenProvidersEnabled<TRequest>(input: Readonly<{
  featureGate: RuntimeProviderOperationsFeatureGate;
  request: TRequest & Readonly<{
    machineId: string;
    sourceProfileId?: string;
  }>;
  dispatch(): Promise<unknown>;
}>): Promise<unknown> {
  if (input.featureGate.isEnabled('providers')) return await input.dispatch();
  return {
    status: 'error',
    error: createProviderErrorV1('provider_feature_disabled', {
      machineId: input.request.machineId,
      ...(input.request.sourceProfileId
        ? { sourceProfileId: input.request.sourceProfileId }
        : {}),
    }),
  };
}

/**
 * Internal Provider-domain handoff between the canonical machine operation
 * owners and invocation-service assembly. Public SDK names and DTO aliases are
 * deliberately owned elsewhere; this producer only stamps ambient machine
 * identity and preserves the existing strict Protocol boundaries.
 */
export function createRuntimeProviderOperationsProducer(input: Readonly<{
  machineId: string;
  machineServices: MachineProviderRpcServices;
  featureGate: RuntimeProviderOperationsFeatureGate;
}>): RuntimeProviderOperationsProducer {
  return Object.freeze({
    machineServices: input.machineServices,
    bind(binding: RuntimeProviderOperationsBinding): ProvidersService {
      return Object.freeze({
        connections: Object.freeze({
          describe: async (request: ProviderConnectionsDescribeRequest, options?: PluginCancellationOptions) =>
            await executeRead({
              binding,
              options,
              prepare: () => DaemonProviderConnectionsDescribeRequestV1Schema.parse({
                ...request,
                machineId: input.machineId,
              }),
              dispatch: async (parsed) => await input.machineServices.describeConnections(parsed),
              parseResult: (value) => DaemonProviderConnectionsDescribeResponseV1Schema.parse(value),
            }),
          mutate: async (request: ProviderConnectionMutationRequest, options?: PluginCancellationOptions) =>
            await executeMutation({
              binding,
              options,
              prepare: () => DaemonProviderConnectionMutationRequestV1Schema.parse(
                request.action === 'startLocal'
                  ? {
                      action: request.action,
                      contributionKey: request.contributionKey,
                      machineId: input.machineId,
                    }
                  : {
                      ...request,
                      machineId: input.machineId,
                    },
              ),
              dispatch: async (parsed) => await input.machineServices.mutateConnection(parsed),
              parseResult: (value) => DaemonProviderConnectionMutationResponseV1Schema.parse(value),
              failure: (error) => DaemonProviderConnectionMutationResponseV1Schema.parse({
                status: 'error',
                error,
              }),
              errorContext: (parsed) => ({
                machineId: parsed.machineId,
                connectionId: parsed.connectionId,
              }),
            }),
          bindingStatus: async (request: ProviderBindingStatusRequest, options?: PluginCancellationOptions) =>
            await executeRead({
              binding,
              options,
              prepare: () => DaemonProviderBindingStatusRequestV1Schema.parse({
                ...request,
                machineId: input.machineId,
              }),
              dispatch: async (parsed) => await input.machineServices.resolveBindingStatus(parsed),
              parseResult: (value) => DaemonProviderBindingStatusResponseV1Schema.parse(value),
            }),
        }),
        catalog: Object.freeze({
          probe: async (request: ProviderProbeRequest, options?: PluginCancellationOptions) =>
            await executeRead({
              binding,
              options,
              prepare: () => DaemonProviderProbeRequestV1Schema.parse({
                ...request,
                machineId: input.machineId,
              }),
              dispatch: async (parsed) => {
                const waiterLifetime = {
                  signal: composeOperationSignal(binding, options),
                  isCurrent: () => isBindingCurrent(binding) && options?.signal?.aborted !== true,
                };
                return 'kind' in parsed
                  ? await input.machineServices.probeDraft(parsed, waiterLifetime)
                  : await input.machineServices.probe(parsed, waiterLifetime);
              },
              parseResult: (value) => DaemonProviderProbeResponseV1Schema.parse(value),
            }),
          listModels: async (request: ProviderModelsRequest, options?: PluginCancellationOptions) =>
            await executeRead({
              binding,
              options,
              prepare: () => DaemonProviderModelsRequestV1Schema.parse({
                ...request,
                machineId: input.machineId,
              }),
              dispatch: async (parsed) => await input.machineServices.models(parsed),
              parseResult: (value) => DaemonProviderModelsResponseV1Schema.parse(value),
            }),
          setModelLoad: async (request: ProviderModelLoadRequest, options?: PluginCancellationOptions) => {
            assertInvocationCurrent(binding);
            if (options?.signal?.aborted) return modelLoadCancelled();
            const parsed = DaemonProviderModelLoadRequestV1Schema.parse({
              ...request,
              machineId: input.machineId,
            });
            assertInvocationCurrent(binding);
            if (options?.signal?.aborted) return modelLoadCancelled();
            const signal = composeOperationSignal(binding, options);
            if (signal.aborted) return modelLoadCancelled();
            try {
              const result = parsed.action === 'load'
                ? await input.machineServices.loadModel({ ...parsed, signal })
                : await input.machineServices.cancelModelLoad({ ...parsed, signal });
              if (signal.aborted || !isBindingCurrent(binding)) return modelLoadCancelled();
              return DaemonProviderModelLoadResponseV1Schema.parse(result);
            } catch (error) {
              if (signal.aborted || !isBindingCurrent(binding)) return modelLoadCancelled();
              const typed = ProviderErrorV1Schema.safeParse(error);
              return DaemonProviderModelLoadResponseV1Schema.parse({
                status: 'error',
                error: typed.success
                  ? typed.data
                  : createProviderErrorV1('provider_rpc_mutation_outcome_unknown', {
                    machineId: parsed.machineId,
                    connectionId: parsed.connectionId,
                  }),
              });
            }
          },
          projectModels: async (request: ProviderModelProjectionRequest, options?: PluginCancellationOptions) =>
            await executeRead({
              binding,
              options,
              prepare: () => DaemonProviderModelProjectionRequestV1Schema.parse({
                ...request,
                machineId: input.machineId,
              }),
              dispatch: async (parsed) => await input.machineServices.projectModels(parsed),
              parseResult: (value) => DaemonProviderModelProjectionResponseV1Schema.parse(value),
            }),
          mutateModelSettings: async (request: ProviderModelSettingsMutationRequest, options?: PluginCancellationOptions) =>
            await executeMutation({
              binding,
              options,
              prepare: () => DaemonProviderModelSettingsMutationRequestV1Schema.parse({
                ...request,
                machineId: input.machineId,
              }),
              dispatch: async (parsed) => await input.machineServices.mutateModelSettings(parsed),
              parseResult: (value) => DaemonProviderModelSettingsMutationResponseV1Schema.parse(value),
              failure: (error) => DaemonProviderModelSettingsMutationResponseV1Schema.parse({
                status: 'error',
                error,
              }),
              errorContext: (parsed) => ({ machineId: parsed.machineId }),
            }),
        }),
        migrations: Object.freeze({
          preview: async (request: ProviderProfileMigrationPreviewRequest, options?: PluginCancellationOptions) =>
            await executeRead({
              binding,
              options,
              prepare: () => DaemonProviderProfileMigrationPreviewRequestV1Schema.parse({
                ...request,
                machineId: input.machineId,
              }),
              dispatch: async (parsed) => await dispatchWhenProvidersEnabled({
                featureGate: input.featureGate,
                request: parsed,
                dispatch: async () => await input.machineServices.previewProfileMigration(parsed),
              }),
              parseResult: (value) => DaemonProviderProfileMigrationPreviewResponseV1Schema.parse(value),
            }),
          confirm: async (request: ProviderProfileMigrationConfirmRequest, options?: PluginCancellationOptions) =>
            await executeMutation({
              binding,
              options,
              prepare: () => DaemonProviderProfileMigrationConfirmRequestV1Schema.parse({
                ...request,
                machineId: input.machineId,
              }),
              dispatch: async (parsed) => await dispatchWhenProvidersEnabled({
                featureGate: input.featureGate,
                request: parsed,
                dispatch: async () => await input.machineServices.confirmProfileMigration(parsed),
              }),
              parseResult: (value) => DaemonProviderProfileMigrationConfirmResponseV1Schema.parse(value),
              failure: (error) => DaemonProviderProfileMigrationConfirmResponseV1Schema.parse({
                status: 'error',
                error,
              }),
              errorContext: (parsed) => ({
                machineId: parsed.machineId,
                sourceProfileId: parsed.sourceProfileId,
              }),
            }),
          confirmConflict: async (request: ProviderProfileMigrationConflictConfirmRequest, options?: PluginCancellationOptions) =>
            await executeMutation({
              binding,
              options,
              prepare: () => DaemonProviderProfileMigrationConflictConfirmRequestV1Schema.parse({
                ...request,
                machineId: input.machineId,
              }),
              dispatch: async (parsed) => await dispatchWhenProvidersEnabled({
                featureGate: input.featureGate,
                request: parsed,
                dispatch: async () => await input.machineServices.confirmProfileMigrationConflict(parsed),
              }),
              parseResult: (value) => DaemonProviderProfileMigrationConflictConfirmResponseV1Schema.parse(value),
              failure: (error) => DaemonProviderProfileMigrationConflictConfirmResponseV1Schema.parse({
                status: 'error',
                error,
              }),
              errorContext: (parsed) => ({
                machineId: parsed.machineId,
                sourceProfileId: parsed.sourceProfileId,
              }),
            }),
        }),
      });
    },
  });
}
