import {
  DaemonVoiceClientRawCredentialAuthorizationInspectResponseV1Schema,
  DaemonVoiceClientRawCredentialAuthorizationRequestResponseV1Schema,
  DaemonVoiceClientRawCredentialAuthorizationRequestV1Schema,
  type DaemonVoiceClientRawCredentialAuthorizationRequestV1,
  type DaemonVoiceClientRawCredentialReviewV1,
  type PluginContributionIdentityV1,
  type PluginPermissionGrantRequestV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { isDeepStrictEqual } from 'node:util';

import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import { readPluginManifest, type ReadPluginManifestResult } from '@/plugins/manifest/read';
import { pluginSourceProvenanceForKind } from '@/plugins/manifest/sourceProvenance';
import type { ResolvedVoiceProviderContribution } from '@/plugins/projection/registry/types';
import {
  createDaemonPluginRawCredentialMaterializer,
} from '@/plugins/runtime/credentials/daemonRawCredentialMaterializer';
import {
  type CurrentPluginInstallReviewPrincipal,
  type CurrentPluginInstallReviewPrincipalReader,
  type CurrentPluginPermissionGrantAuthoritySourceReader,
  type PluginRawCredentialAuthorizationInspection,
} from '@/plugins/runtime/credentials/rawCredentialMaterializer';
import { pluginInstallReviewPrincipalPresentationMatchesDigest } from '@/plugins/daemon/installReviewPrincipal';
import type { PluginPermissionGrantRequester } from '@/plugins/runtime/lifecycle/permissions/pluginPermissionGrantRequester';
import { createServerPluginPermissionGrantRequester } from '@/plugins/runtime/lifecycle/permissions/pluginPermissionGrantRequester';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import type { RpcHandlerRegistrar } from '../rpc/types';

type AuthorizationRequest = DaemonVoiceClientRawCredentialAuthorizationRequestV1;

export type VoiceRawCredentialAuthorizationReview = Readonly<{
  authorization: PluginRawCredentialAuthorizationInspection;
  review: DaemonVoiceClientRawCredentialReviewV1;
}>;

export type VoiceRawCredentialAuthorizationRequestReview = VoiceRawCredentialAuthorizationReview & Readonly<{
  pendingRequest: PluginPermissionGrantRequestV1;
}>;

export type MachineVoiceClientCredentialAuthorizationService = Readonly<{
  inspect(
    input: AuthorizationRequest,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<VoiceRawCredentialAuthorizationReview>;
  request(
    input: AuthorizationRequest,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<VoiceRawCredentialAuthorizationRequestReview>;
}>;

type AuthorizationServiceDependencies = Readonly<{
  machineId: string | null;
  acquireRuntimeLease?: typeof acquireAuthoritativePluginRuntimeRegistryLease;
  readManifest?: (input: Readonly<{ manifestPath: string }>) => Promise<ReadPluginManifestResult>;
  currentInstallReviewPrincipal?: CurrentPluginInstallReviewPrincipalReader;
  readCurrentGrantAuthoritySource?: CurrentPluginPermissionGrantAuthoritySourceReader;
  readStoredCredentials?: () => Promise<StoredCredentials | null>;
  createGrantRequester?: (input: Readonly<{ credentials: StoredCredentials }>) => PluginPermissionGrantRequester;
  getAccountSettingsSnapshot?: typeof getActiveAccountSettingsSnapshot;
  ensureAccountSettingsSnapshot?: () => Promise<void>;
}>;

type CurrentAuthorizationContext = VoiceRawCredentialAuthorizationReview & Readonly<{
  inspectAgain(): Promise<PluginRawCredentialAuthorizationInspection>;
}>;

function credentialUnavailable(): Error & { code: string } {
  return Object.assign(new Error('Voice raw credential access is unavailable'), {
    code: 'plugin_voice_credential_access_unavailable',
  });
}

function requestFailed(): Error & { code: string } {
  return Object.assign(new Error('Voice raw credential access review could not be requested'), {
    code: 'plugin_voice_credential_access_request_failed',
  });
}

function localizedFallback(value: string | Readonly<{ fallback: string }>): string {
  return typeof value === 'string' ? value : value.fallback;
}

function contributionMatches(
  candidate: ResolvedVoiceProviderContribution,
  contribution: PluginContributionIdentityV1,
): boolean {
  return candidate.identity.pluginId === contribution.pluginId
    && candidate.identity.localId === contribution.localId;
}

function representativeRawGrant(
  contribution: ResolvedVoiceProviderContribution,
): Readonly<{ realm: 'web' | 'ios' | 'android' | 'daemon'; phase: 'settings' | 'prepare' | 'connection' | 'speech' }> | null {
  const grants: Array<Readonly<{
    realm: 'web' | 'ios' | 'android' | 'daemon';
    phase: 'settings' | 'prepare' | 'connection' | 'speech';
    request: unknown;
  }>> = [];
  for (const source of contribution.definition.credentials?.sources ?? []) {
    for (const grant of source.rawGrants ?? []) {
      grants.push(Object.freeze({
        realm: grant.realm,
        phase: grant.phase,
        request: grant.request,
      }));
    }
  }
  grants.sort((left, right) => {
    const leftKey = JSON.stringify(left);
    const rightKey = JSON.stringify(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const grant = grants[0];
  return grant ? Object.freeze({ realm: grant.realm, phase: grant.phase }) : null;
}

function reviewPresentation(
  provider: ResolvedVoiceProviderContribution,
  manifest: ReadPluginManifestResult & Readonly<{ ok: true }>,
  principal: CurrentPluginInstallReviewPrincipal,
): DaemonVoiceClientRawCredentialReviewV1 {
  const credentials = provider.definition.credentials;
  if (!credentials) throw credentialUnavailable();
  const presentation = principal.presentation
    && pluginInstallReviewPrincipalPresentationMatchesDigest(principal.digest, principal.presentation)
    ? principal.presentation
    : null;
  if (presentation && presentation.packageIdentity.pluginId !== provider.pluginId) {
    throw credentialUnavailable();
  }
  const isBundledFirstParty = provider.provenance === 'first_party'
    && provider.source.kind === 'bundled';
  const publisher = isBundledFirstParty
    ? Object.freeze({ status: 'bundled_first_party' as const, identity: 'Happier' as const })
    : presentation?.publisherIdentity.status === 'unverified'
      ? Object.freeze({ ...presentation.publisherIdentity })
      : Object.freeze({ status: 'unavailable' as const });
  const packageSignature = presentation?.packageSignature.status === 'verified'
    ? Object.freeze({ ...presentation.packageSignature })
    : Object.freeze({ status: 'unavailable' as const });
  const distribution = isBundledFirstParty
    ? Object.freeze({ kind: 'bundled' as const })
    : presentation?.distributionIdentity.kind === 'npm'
      ? Object.freeze({
          kind: 'npm' as const,
          packageName: presentation.distributionIdentity.packageName,
          registryOrigin: presentation.distributionIdentity.registryOrigin,
        })
      : presentation?.distributionIdentity ?? Object.freeze({ kind: 'unavailable' as const });
  return Object.freeze({
    plugin: Object.freeze({
      id: provider.pluginId,
      name: localizedFallback(manifest.manifest.displayName),
      version: manifest.manifest.version,
    }),
    package: Object.freeze({
      identity: presentation?.packageIdentity.packageName ?? provider.pluginId,
    }),
    distribution,
    publisher,
    packageSignature,
    contribution: Object.freeze({
      identity: Object.freeze({ ...provider.identity }),
      name: localizedFallback(provider.definition.title),
    }),
    credentialSlot: Object.freeze({
      id: credentials.slot.id,
      name: localizedFallback(credentials.slot.title),
      purpose: credentials.slot.purpose,
    }),
  });
}

function sameAuthorization(
  left: PluginRawCredentialAuthorizationInspection,
  right: PluginRawCredentialAuthorizationInspection,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactPendingRequest(
  pendingRequest: PluginPermissionGrantRequestV1,
  authorization: PluginRawCredentialAuthorizationInspection,
): boolean {
  return pendingRequest.pluginId === authorization.pluginId
    && pendingRequest.capability === authorization.capability
    && JSON.stringify(pendingRequest.targetScope) === JSON.stringify(authorization.targetScope)
    && JSON.stringify(pendingRequest.subject) === JSON.stringify(authorization.subject)
    && pendingRequest.requester.kind === 'plugin'
    && pendingRequest.requester.pluginId === authorization.pluginId;
}

export function createMachineVoiceClientCredentialAuthorizationService(
  dependencies: AuthorizationServiceDependencies,
): MachineVoiceClientCredentialAuthorizationService {
  const acquireRuntimeLease = dependencies.acquireRuntimeLease
    ?? acquireAuthoritativePluginRuntimeRegistryLease;
  const readManifest = dependencies.readManifest ?? readPluginManifest;
  const readCredentials = dependencies.readStoredCredentials ?? readStoredCredentials;
  const createGrantRequester = dependencies.createGrantRequester
    ?? createServerPluginPermissionGrantRequester;
  const getAccountSettingsSnapshot = dependencies.getAccountSettingsSnapshot
    ?? getActiveAccountSettingsSnapshot;

  const withCurrentAuthorization = async <T>(
    rawInput: AuthorizationRequest,
    signal: AbortSignal,
    use: (context: CurrentAuthorizationContext) => Promise<T>,
  ): Promise<T> => {
    signal.throwIfAborted();
    const input = DaemonVoiceClientRawCredentialAuthorizationRequestV1Schema.parse(rawInput);
    let lease: PluginRuntimeRegistryLease | null = null;
    try {
      lease = await acquireRuntimeLease();
      signal.throwIfAborted();
      const provider = lease.registry.contributes.voiceProviders?.find((candidate) => (
        contributionMatches(candidate, input.contribution)
      )) ?? null;
      if (!provider || provider.pluginId !== input.contribution.pluginId) {
        throw credentialUnavailable();
      }
      const rawGrant = representativeRawGrant(provider);
      const lifecycle = lease.registry.resolveVoiceProviderRuntimeLifecycle?.(
        provider.identity,
      ) ?? null;
      if (!rawGrant || !lifecycle?.isCurrent()) throw credentialUnavailable();
      const connectedAccounts = lease.registry.resolveConnectedAccountPurposeBindingOwner?.();
      const manifest = await readManifest({
        manifestPath: provider.manifestPath,
        sourceProvenance: pluginSourceProvenanceForKind(provider.sourceSpec?.kind),
      });
      signal.throwIfAborted();
      const manifestProvider = manifest.ok
        ? manifest.manifest.contributes.voiceProviders?.find((candidate) => (
            candidate.id === provider.identity.localId
          ))
        : null;
      if (
        !manifest.ok
        || manifest.manifest.id !== provider.pluginId
        || !manifestProvider
        || !isDeepStrictEqual(manifestProvider, provider.definition)
        || !lifecycle.isCurrent()
      ) {
        throw credentialUnavailable();
      }
      const inspector = createDaemonPluginRawCredentialMaterializer({
        mode: 'authorization',
        binding: {
          manifest: manifest.manifest,
          contribution: input.contribution,
          realm: rawGrant.realm,
          phase: rawGrant.phase,
          machineId: dependencies.machineId,
          immutableGenerationId: lifecycle.generation,
          isRuntimeAuthorityCurrent: lifecycle.isCurrent,
        },
        ...(dependencies.currentInstallReviewPrincipal
          ? { currentInstallReviewPrincipal: dependencies.currentInstallReviewPrincipal }
          : {}),
        ...(dependencies.readCurrentGrantAuthoritySource
          ? { readCurrentGrantAuthoritySource: dependencies.readCurrentGrantAuthoritySource }
          : {}),
        ...(connectedAccounts ? { connectedAccounts } : {}),
        getAccountSettingsSnapshot,
        readStoredCredentials: readCredentials,
        ...(dependencies.ensureAccountSettingsSnapshot
          ? { ensureAccountSettingsSnapshot: dependencies.ensureAccountSettingsSnapshot }
          : {}),
      });
      const authorization = await inspector.inspectAuthorization({ signal });
      const principal = await inspector.currentInstallReviewPrincipal.readCurrent({
        pluginId: provider.pluginId,
        signal,
      });
      if (
        !principal
        || authorization.subject.kind !== 'credential_access_disclosure'
        || principal.digest !== authorization.subject.installReviewPrincipalDigest
      ) {
        throw credentialUnavailable();
      }
      const review = reviewPresentation(provider, manifest, principal);
      return await use(Object.freeze({
        authorization,
        review,
        inspectAgain: () => inspector.inspectAuthorization({ signal }),
      }));
    } finally {
      await lease?.release();
    }
  };

  return Object.freeze({
    async inspect(input, options = {}) {
      const signal = options.signal ?? new AbortController().signal;
      return await withCurrentAuthorization(input, signal, async (context) => {
        const current = await context.inspectAgain();
        if (!sameAuthorization(context.authorization, current)) throw credentialUnavailable();
        return Object.freeze({ authorization: current, review: context.review });
      });
    },
    async request(input, options = {}) {
      const signal = options.signal ?? new AbortController().signal;
      return await withCurrentAuthorization(input, signal, async (context) => {
        const credentials = await readCredentials();
        signal.throwIfAborted();
        if (!credentials) throw requestFailed();
        let output;
        try {
          output = await createGrantRequester({ credentials }).request({
            pluginId: context.authorization.pluginId,
            capability: context.authorization.capability,
            targetScope: context.authorization.targetScope,
            subject: context.authorization.subject,
            requester: { kind: 'plugin', pluginId: context.authorization.pluginId },
            reason: 'Voice provider raw credential access review',
          }, { signal });
        } catch (error) {
          signal.throwIfAborted();
          throw requestFailed();
        }
        const current = await context.inspectAgain();
        if (
          !sameAuthorization(context.authorization, current)
          || !exactPendingRequest(output.pendingRequest, current)
        ) {
          throw credentialUnavailable();
        }
        return Object.freeze({
          authorization: current,
          review: context.review,
          pendingRequest: output.pendingRequest,
        });
      });
    },
  });
}

export function registerMachineVoiceClientCredentialAuthorizationRpcHandlers(input: Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
  machineId?: string | null;
  service?: MachineVoiceClientCredentialAuthorizationService;
}>): void {
  const service = input.service ?? createMachineVoiceClientCredentialAuthorizationService({
    machineId: input.machineId ?? null,
  });
  input.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_AUTHORIZATION_INSPECT,
    async (raw: unknown, context) => {
      const parsed = DaemonVoiceClientRawCredentialAuthorizationRequestV1Schema.safeParse(raw);
      if (!parsed.success) return DaemonVoiceClientRawCredentialAuthorizationInspectResponseV1Schema.parse({
        ok: false,
        errorCode: 'invalid_request',
      });
      try {
        return DaemonVoiceClientRawCredentialAuthorizationInspectResponseV1Schema.parse({
          ok: true as const,
          ...await service.inspect(parsed.data, context?.signal ? { signal: context.signal } : {}),
        });
      } catch (error) {
        context?.signal.throwIfAborted();
        return DaemonVoiceClientRawCredentialAuthorizationInspectResponseV1Schema.parse({
          ok: false as const,
          errorCode: (error as { code?: unknown })?.code === 'plugin_voice_credential_access_unavailable'
            ? 'unavailable' as const
            : 'internal_error' as const,
        });
      }
    },
  );
  input.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_AUTHORIZATION_REQUEST,
    async (raw: unknown, context) => {
      const parsed = DaemonVoiceClientRawCredentialAuthorizationRequestV1Schema.safeParse(raw);
      if (!parsed.success) return DaemonVoiceClientRawCredentialAuthorizationRequestResponseV1Schema.parse({
        ok: false,
        errorCode: 'invalid_request',
      });
      try {
        return DaemonVoiceClientRawCredentialAuthorizationRequestResponseV1Schema.parse({
          ok: true as const,
          ...await service.request(parsed.data, context?.signal ? { signal: context.signal } : {}),
        });
      } catch (error) {
        context?.signal.throwIfAborted();
        const code = (error as { code?: unknown })?.code;
        return DaemonVoiceClientRawCredentialAuthorizationRequestResponseV1Schema.parse({
          ok: false as const,
          errorCode: code === 'plugin_voice_credential_access_unavailable'
            ? 'unavailable' as const
            : code === 'plugin_voice_credential_access_request_failed'
              ? 'request_failed' as const
              : 'internal_error' as const,
        });
      }
    },
  );
}
