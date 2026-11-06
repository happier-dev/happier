import { readGitHubRepositoryV1, RegistryFetchErrorV1, type RegistrySourceV1 } from '@happier-dev/protocol/registries';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createHostScmHostingProviderRuntimeServices } from '@/scm/hostingProviders/runtimeServices';
import { deriveScmHostingProviderConnectedAccountPurposeAuthorization } from '@/daemon/connectedServices/purposeBindings/deriveRegistryConnectedAccountPurposeAuthorizations';
import { createRequesterConnectedAccountPurposeBindingRuntime } from '@/daemon/connectedServices/purposeBindings/createRequesterConnectedAccountPurposeBindingRuntime';
import { createConnectedServiceCredentialApi } from '@/api/client/connectedServiceCredentialApi';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { resolveQualifiedConnectedAccountAtomicV4Negotiation } from '@/api/client/qualifiedConnectedAccountApi';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import type { RegistryHttpCredentialV1 } from './registryHttp';

type HostingRegistry = Parameters<typeof createHostScmHostingProviderRuntimeServices>[0];

/** The forge owner selects the existing purpose binding; a catalog read cannot select an account. */
export async function readRegistryHostingTokenV1(input: Readonly<{
  registry: HostingRegistry; source: RegistrySourceV1; signal?: AbortSignal; allowNativeAccountCredentials?: boolean;
}>): Promise<RegistryHttpCredentialV1 | null> {
  if (!readGitHubRepositoryV1(input.source.url)) return null;
  const services = createHostScmHostingProviderRuntimeServices(input.registry);
  const providers = await services.resolveScmHostingProviderRegistry!({ signal: input.signal });
  const detected = providers.detectRemote({ remoteName: null, remoteUrl: input.source.url });
  if (detected.kind !== 'resolved') return null;
  const registered = input.registry.scmHostingProvidersById.get(detected.provider.id);
  if (!registered) return null;
  const contribution = input.registry.contributes.scmHostingProviders?.find(entry => entry.pluginId === registered.pluginId
    && entry.definition.id === registered.registration.id);
  const authorization = contribution && deriveScmHostingProviderConnectedAccountPurposeAuthorization(contribution);
  const owner = input.registry.resolveConnectedAccountPurposeBindingOwner?.();
  if (!authorization || !owner?.getBinding) return null;
  const signal = input.signal ?? new AbortController().signal;
  const binding = await owner.getBinding({ ...authorization, signal });
  if (!binding && !input.allowNativeAccountCredentials) return null;
  // Materialize for the actual API origin. This grant cannot be forwarded to
  // raw-content hosts or redirects merely because they belong to GitHub.
  const origin = 'https://api.github.com';
  const result = await owner.materialize({ ...authorization,
    ...(binding ? { expectedAccount: binding.account } : { nativeService: authorization.serviceRefs[0] }),
    request: { kind: 'httpHeaders', origin, headerNames: ['authorization'] }, signal }).catch((error: unknown) => {
    signal.throwIfAborted();
    if (!binding && error instanceof PluginError && error.code === 'plugin_connected_account_native_unavailable') return null;
    throw error;
  });
  if (!result) return null;
  if (result.kind !== 'httpHeaders') throw new RegistryFetchErrorV1({ state: 'auth_failed' });
  const value = new Headers(result.headers).get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!value) throw new RegistryFetchErrorV1({ state: 'auth_failed' });
  return { value, origin };
}

/** Keep Connected Accounts requester-qualified; Machine native login follows the retained admission. */
export async function readRegistryConnectedAccountTokenV1(input: Readonly<{
  source: RegistrySourceV1; operationContext: SavedSecretOperationContextV1;
  controller: PluginReloadController; signal?: AbortSignal;
}>): Promise<RegistryHttpCredentialV1 | null> {
  if (!readGitHubRepositoryV1(input.source.url)) return null;
  const operation = input.operationContext;
  const accountId = readAccountIdFromToken(operation.credentials.token);
  if (!accountId || operation.machineAdmission && operation.machineAdmission.actorAccountId !== accountId)
    throw new RegistryFetchErrorV1({ state: 'auth_failed' });
  const admission = operation.machineAdmission;
  const allowNativeAccountCredentials = admission !== undefined
    && (accountId === admission.custodianAccountId || admission.role === 'manage');
  const lease = input.controller.tryAcquireRuntimeRegistry();
  if (!lease) return null;
  try {
    const features = await fetchServerFeaturesSnapshot({ serverUrl: operation.serverHttpBaseUrl,
      token: operation.credentials.token, signal: input.signal });
    const api = createConnectedServiceCredentialApi(operation.credentials);
    const runtime = createRequesterConnectedAccountPurposeBindingRuntime({ operationContext: operation, accountId,
      reloadController: input.controller, signal: input.signal, isCurrent: operation.isCurrent,
      allowNativeAccountCredentials,
      getAccountEncryptionMode: options => runWithServerHttpBaseUrl(operation.serverHttpBaseUrl, () => api.getAccountEncryptionMode(options)),
      resolveQualifiedConnectedAccountV4Support: () => resolveQualifiedConnectedAccountAtomicV4Negotiation(features) });
    await lease.registry.activateContributionsOnDemand((lease.registry.contributes.scmHostingProviders ?? []).flatMap(entry =>
      entry.pluginId ? [{ pluginId: entry.pluginId, family: 'scmHostingProviders' as const, localId: entry.definition.id }] : []));
    return await readRegistryHostingTokenV1({ ...input, allowNativeAccountCredentials, registry: { ...lease.registry,
      resolveConnectedAccountPurposeBindingOwner: () => runtime.purposes.owner } });
  } catch (error) {
    input.signal?.throwIfAborted();
    if (error instanceof RegistryFetchErrorV1) throw error;
    throw new RegistryFetchErrorV1({ state: 'unreachable' });
  } finally { await lease.release(); }
}
