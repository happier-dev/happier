/** @moduleRealm any */
import { ScmHostingOperationSchemasV1 } from '@happier-dev/protocol/scm/hostingProviderOperations';
import type { ScmHostingOperationActionsV1, ScmHostingOperationV1 } from '@happier-dev/protocol/plugins/contributions/scmHostingProviders';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import type { PluginAccountActionContext } from '../actions/contracts.js';
import type { PluginActionDeclaration, PluginActionDefinition } from '../definePlugin.js';
import type { PluginContributionRef } from '../identity.js';
import { PluginError, isPluginError } from '../errors.js';
import type { HostingProviderRuntimeAdapter, HostingProviderRuntimeServices } from './hostingProvider.js';
import type { ScmHostingProviderRef } from './hostingProvider.js';
import { readScmHostingBearerToken, readScmHostingBasicCredentials } from './hostingCredentials.js';

/** Same method owner for legacy in-process hosting and declared remote Actions. */
function readHostingProviderOperationHandler(adapter: HostingProviderRuntimeAdapter, operation: ScmHostingOperationV1):
  ((input: unknown) => Promise<unknown>) | undefined {
  for (const capability of [adapter.pullRequests, adapter.pullRequestCheckout, adapter.repositoryPublishing, adapter.repositoryClone]) {
    if (!capability) continue;
    const handler: unknown = Reflect.get(capability, operation);
    if (typeof handler === 'function') return async input => await Reflect.apply(handler, capability, [input]);
  }
  return undefined;
}

type AccountActionDefinition = PluginActionDefinition<Extract<PluginActionDeclaration,
  Readonly<{ execution: Readonly<{ target: 'account' }> }>>>;

/**
 * Declares the existing provider HTTP methods as Account Actions. Credentials
 * remain inside the executor's admitted Connected Account purpose; no material
 * is included in Action input or output. Provider parsers and recovery stay with
 * the existing adapters.
 */
export function createHostingProviderOperationActions<const TOperations extends ScmHostingOperationActionsV1>(input: Readonly<{
  operationActions: TOperations;
  adapter: HostingProviderRuntimeAdapter;
  purpose: string;
  service: PluginContributionRef;
  hostAccess: readonly string[];
  execution: Extract<PluginActionDeclaration, Readonly<{ execution: Readonly<{ target: 'account' }> }>>['execution'];
}>): Readonly<Record<Extract<TOperations[keyof TOperations], string>, AccountActionDefinition>> {
  return Object.fromEntries(Object.entries(input.operationActions).map(([operationKey, localId]) => {
    const operation = operationKey as ScmHostingOperationV1;
    const schemas = ScmHostingOperationSchemasV1[operation];
    const handler = readHostingProviderOperationHandler(input.adapter, operation);
    if (!handler) throw new TypeError(`scm_hosting_operation_unavailable:${operation}`);
    const writes = operation === 'createPullRequest' || operation === 'createRepository';
    const definition: AccountActionDefinition = {
      title: operation,
      description: `Execute the hosting provider ${operation} operation.`,
      surfaces: ['ui', 'voice', 'agent', 'mcp', 'cli', 'plugin'],
      placementBindings: [], dangerLevel: writes ? 'writesRemote' : 'safe', readOnly: !writes,
      ...(writes ? { confirmation: operation === 'createRepository'
        ? { title: 'Create this repository?', body: 'Create the requested repository on the selected hosting provider with the reviewed owner, name and visibility.', confirmLabel: 'Create repository' }
        : { title: 'Create this pull request?', body: 'Create the requested pull request on the selected hosting provider with the reviewed branches, title and description.', confirmLabel: 'Create pull request' } } : {}),
      execution: input.execution,
      hostAccess: input.hostAccess,
      inputSchema: schemas.input.jsonSchema,
      resultSchema: schemas.result.jsonSchema,
      async run(raw, context: PluginAccountActionContext) {
        const operationInput = schemas.input.parse(raw);
        const binding = await context.services.connectedAccounts.getBinding(input.purpose, { signal: context.signal });
        const materializeHeaders = async (provider: ScmHostingProviderRef, signal: AbortSignal) =>
          await context.services.connectedAccounts.materialize(input.purpose,
            { kind: 'httpHeaders', origin: new URL(provider.baseUrl).origin, headerNames: ['authorization'] },
            { signal, ...(binding ? { expectedAccount: binding.account } : { nativeService: input.service }) });
        const runtimeServices: HostingProviderRuntimeServices = {
          async resolveScmHostingTokenMaterialization(request, options) {
            const material = await materializeHeaders(request.provider, options?.signal ?? context.signal);
            if (material.kind !== 'httpHeaders') return { kind: 'missing', reason: 'unsupported_materialization' };
            const token = readScmHostingBearerToken(material.headers);
            return token ? { kind: 'available', token, ...(binding ? { account: binding.account } : {}) }
              : { kind: 'missing', reason: 'credential_unavailable' };
          },
          async resolveScmHostingBasicAuthMaterialization(request, options) {
            const material = await materializeHeaders(request.provider, options?.signal ?? context.signal);
            if (material.kind !== 'httpHeaders') return { kind: 'missing', reason: 'unsupported_materialization' };
            const credentials = readScmHostingBasicCredentials(material.headers);
            return credentials ? { kind: 'available', ...credentials } : { kind: 'missing', reason: 'credential_unavailable' };
          },
        };
        try {
          return projectNativeJsonValueForTransport(await handler({ ...operationInput, signal: context.signal, runtimeServices }));
        } catch (error) {
          context.signal.throwIfAborted();
          if (isPluginError(error)) throw error;
          const errorCode: unknown = error instanceof Error ? Reflect.get(error, 'errorCode') : undefined;
          if (typeof errorCode !== 'string') throw error;
          const effectNotApplied: unknown = Reflect.get(error, 'effectNotApplied');
          const retryNotBeforeMs: unknown = Reflect.get(error, 'retryNotBeforeMs');
          throw new PluginError({ code: errorCode, message: error instanceof Error ? error.message : errorCode,
            details: { ...(effectNotApplied === true ? { effectNotApplied: true } : {}),
              ...(typeof retryNotBeforeMs === 'number' ? { retryNotBeforeMs } : {}) } }, { cause: error });
        }
      },
    };
    return [localId, definition];
  })) as Readonly<Record<Extract<TOperations[keyof TOperations], string>, AccountActionDefinition>>;
}
