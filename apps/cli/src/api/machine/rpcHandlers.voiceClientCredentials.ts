import {
  DaemonVoiceClientRawCredentialMaterializeRequestV1Schema,
  DaemonVoiceClientRawCredentialMaterializeResponseV1Schema,
  type ConnectedServiceCredentialRevisionV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';

import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import {
  createDaemonPluginRawCredentialMaterializer,
} from '@/plugins/runtime/credentials/daemonRawCredentialMaterializer';
import type {
  CurrentPluginInstallReviewPrincipalReader,
  CurrentPluginPermissionGrantAuthoritySourceReader,
  PluginPermissionGrantListReader,
} from '@/plugins/runtime/credentials/rawCredentialMaterializer';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { RpcHandlerContext, RpcHandlerRegistrar } from '../rpc/types';

export type MachineVoiceClientCredentialRpcRegistration = Readonly<{
  dispose(): Promise<void>;
}>;

type RawCredentialDependencies = Readonly<{
  credentials?: StoredCredentials;
  currentInstallReviewPrincipal?: CurrentPluginInstallReviewPrincipalReader;
  readCurrentGrantAuthoritySource?: CurrentPluginPermissionGrantAuthoritySourceReader;
  grants?: PluginPermissionGrantListReader;
  getAccountSettingsSnapshot?: () => ActiveAccountSettingsSnapshot | null;
  ensureAccountSettingsSnapshot?: () => Promise<void>;
}>;

function failure(error: unknown) {
  if (isPluginError(error)) {
    if (error.code === 'plugin_voice_provider_result_invalid') {
      return Object.freeze({ ok: false as const, errorCode: error.code });
    }
    if (error.code === 'plugin_voice_provider_operation_failed') {
      return Object.freeze({ ok: false as const, errorCode: error.code });
    }
  }
  return Object.freeze({
    ok: false as const,
    errorCode: 'plugin_voice_credential_access_unavailable' as const,
  });
}

export function registerMachineVoiceClientCredentialRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
  machineId: string | null;
  resolveRawCredentialDependencies?(): Promise<RawCredentialDependencies | null>;
}>): MachineVoiceClientCredentialRpcRegistration {
  const resolveRawCredentialDependencies: () => Promise<RawCredentialDependencies | null> =
    params.resolveRawCredentialDependencies ?? (async () => {
      const storedCredentials = await readStoredCredentials();
      if (!storedCredentials) return null;
      return Object.freeze({ credentials: storedCredentials });
    });

  params.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_MATERIALIZE,
    async (raw: unknown, context?: RpcHandlerContext) => {
      const request = DaemonVoiceClientRawCredentialMaterializeRequestV1Schema.safeParse(raw);
      if (!request.success) {
        return Object.freeze({
          ok: false as const,
          errorCode: 'plugin_voice_provider_result_invalid' as const,
        });
      }
      const callbackBasisRequest: Readonly<
        Pick<typeof request.data, 'cacheIdentity'> & {
          expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
        }
      > = request.data;
      const carriesCredentialRevisionBasis = Object.hasOwn(
        callbackBasisRequest,
        'expectedCredentialRevision',
      );
      let capturedCredentialRevision: ConnectedServiceCredentialRevisionV1 | null = null;
      const credentialRevisionBasis = carriesCredentialRevisionBasis
        ? Object.freeze({
            expectedCredentialRevision:
              callbackBasisRequest.expectedCredentialRevision ?? null,
            captureCredentialRevision(credentialRevision: ConnectedServiceCredentialRevisionV1) {
              capturedCredentialRevision = credentialRevision;
            },
          })
        : null;
      const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
      try {
        const identity = request.data.cacheIdentity;
        if (
          identity.platform !== 'web'
          && identity.platform !== 'ios'
          && identity.platform !== 'android'
        ) {
          return Object.freeze({
            ok: false as const,
            errorCode: 'plugin_voice_provider_result_invalid' as const,
          });
        }
        const realm = identity.platform;
        if (lease.registry.generation !== identity.projectionGeneration) return failure(null);
        const provider = lease.registry.contributes.voiceProviders?.find((candidate) => (
          candidate.identity.pluginId === identity.pluginId
          && candidate.identity.localId === identity.contributionId
          && candidate.definition.kind === 'conversation'
          && candidate.definition.platforms.includes(realm)
        )) ?? null;
        if (!provider) return failure(null);
        const lifecycle = lease.registry.resolveVoiceProviderRuntimeLifecycle?.(
          provider.identity,
        ) ?? null;
        if (
          !lifecycle
          || !lifecycle.isCurrent()
        ) return failure(null);
        const targets = lease.registry.contributes.activationTargets.filter((candidate) => (
          candidate.pluginId === provider.pluginId
        ));
        const target = targets.length === 1 ? targets[0] : null;
        const declaredProvider = target?.manifest.contributes.voiceProviders?.find((candidate) => (
          candidate.id === provider.identity.localId
          && candidate.kind === provider.definition.kind
        ));
        if (!target || !declaredProvider || JSON.stringify(declaredProvider) !== JSON.stringify(provider.definition)) {
          return failure(null);
        }
        const dependencies = await resolveRawCredentialDependencies();
        if (!dependencies || !lifecycle.isCurrent()) return failure(null);
        const connectedAccounts = lease.registry.resolveConnectedAccountPurposeBindingOwner?.() ?? null;
        if (!connectedAccounts) return failure(null);
        const materializer = createDaemonPluginRawCredentialMaterializer({
          binding: {
            manifest: target.manifest,
            contribution: {
              pluginId: provider.identity.pluginId,
              localId: provider.identity.localId,
            },
            realm,
            phase: request.data.phase,
            machineId: params.machineId,
            immutableGenerationId: lifecycle.generation,
            isRuntimeAuthorityCurrent: lifecycle.isCurrent,
          },
          ...(dependencies.credentials ? { credentials: dependencies.credentials } : {}),
          ...(dependencies.currentInstallReviewPrincipal
            ? { currentInstallReviewPrincipal: dependencies.currentInstallReviewPrincipal }
            : {}),
          ...(dependencies.readCurrentGrantAuthoritySource
            ? { readCurrentGrantAuthoritySource: dependencies.readCurrentGrantAuthoritySource }
            : {}),
          ...(dependencies.grants ? { grants: dependencies.grants } : {}),
          connectedAccounts,
          ...(dependencies.getAccountSettingsSnapshot
            ? { getAccountSettingsSnapshot: dependencies.getAccountSettingsSnapshot }
            : {}),
          ...(dependencies.ensureAccountSettingsSnapshot
            ? { ensureAccountSettingsSnapshot: dependencies.ensureAccountSettingsSnapshot }
            : {}),
        });
        const materialization = await materializer.materialize(request.data.request, {
          ...(context?.signal ? { signal: context.signal } : {}),
          ...(credentialRevisionBasis ? { credentialRevisionBasis } : {}),
        });
        if (!lifecycle.isCurrent() || materialization.kind !== 'httpHeaders') return failure(null);
        return DaemonVoiceClientRawCredentialMaterializeResponseV1Schema.parse({
          ok: true,
          materialization: {
            kind: 'httpHeaders',
            headers: { ...materialization.headers },
          },
          ...(credentialRevisionBasis
            ? { credentialRevision: capturedCredentialRevision }
            : {}),
        });
      } catch (error) {
        context?.signal?.throwIfAborted();
        return DaemonVoiceClientRawCredentialMaterializeResponseV1Schema.parse(failure(error));
      } finally {
        await lease.release();
      }
    },
  );

  return Object.freeze({
    async dispose() {},
  });
}
