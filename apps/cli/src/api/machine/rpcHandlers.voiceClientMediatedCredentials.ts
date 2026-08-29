import {
  DaemonVoiceClientMediatedCredentialMaterializeRequestV1Schema,
  DaemonVoiceClientMediatedCredentialMaterializeResponseV1Schema,
  deriveVoiceCredentialBindingIdentityV1,
  resolveAccountSettingsVoiceCredentialSource,
  resolveVoiceCredentialOperationAuthorization,
  sameQualifiedConnectedAccountRef,
  type PluginContributionIdentityV1,
  type QualifiedConnectedAccountPurposeBindingTargetV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';

import {
  getActiveAccountSettingsSnapshot,
  type ActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { readStoredCredentials } from '@/persistence';
import { warmActiveAccountSettingsSnapshotBestEffort } from '@/settings/accountSettings/warmActiveAccountSettingsSnapshot';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { RpcHandlerContext, RpcHandlerRegistrar } from '../rpc/types';

export type MachineVoiceClientMediatedCredentialRpcRegistration = Readonly<{
  dispose(): Promise<void>;
}>;

function sameContribution(
  left: PluginContributionIdentityV1,
  right: PluginContributionIdentityV1,
): boolean {
  return left.pluginId === right.pluginId && left.localId === right.localId;
}

function failure(error: unknown) {
  if (isPluginError(error)
    && error.code === 'plugin_voice_provider_result_invalid') {
    return Object.freeze({ ok: false as const, errorCode: 'plugin_voice_provider_result_invalid' as const });
  }
  if (isPluginError(error)
    && error.code === 'plugin_voice_provider_operation_failed') {
    return Object.freeze({ ok: false as const, errorCode: 'plugin_voice_provider_operation_failed' as const });
  }
  return Object.freeze({ ok: false as const, errorCode: 'plugin_voice_credential_access_unavailable' as const });
}

function targetService(
  target: QualifiedConnectedAccountPurposeBindingTargetV1,
): PluginContributionIdentityV1 {
  return target.kind === 'account' ? target.account.service : target.service;
}

function sameSelectedTarget(
  left: QualifiedConnectedAccountPurposeBindingTargetV1,
  right: QualifiedConnectedAccountPurposeBindingTargetV1,
): boolean {
  if (left.kind === 'account') {
    return right.kind === 'account'
      && sameQualifiedConnectedAccountRef(left.account, right.account);
  }
  return right.kind === 'group'
    && sameContribution(left.service, right.service)
    && left.groupId === right.groupId;
}

function exactHeaders(
  raw: Readonly<Record<string, string>>,
  requiredHeaderNames: readonly string[],
  allowedHeaderNames: readonly string[],
): Readonly<Record<string, string>> | null {
  const allowed = new Set(allowedHeaderNames.map((name) => name.toLowerCase()));
  const normalized = new Map<string, string>();
  for (const [rawName, value] of Object.entries(raw)) {
    const name = rawName.trim().toLowerCase();
    if (
      !allowed.has(name)
      || normalized.has(name)
      || value.length === 0
      || /[\r\n]/u.test(value)
    ) return null;
    normalized.set(name, value);
  }
  if (requiredHeaderNames.some((name) => !normalized.has(name.toLowerCase()))) return null;
  return Object.freeze(Object.fromEntries(normalized));
}

export function registerMachineVoiceClientMediatedCredentialRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
  getAccountSettingsSnapshot?: () => ActiveAccountSettingsSnapshot | null;
  ensureAccountSettingsSnapshot?: () => Promise<void>;
}>): MachineVoiceClientMediatedCredentialRpcRegistration {
  const getSnapshot = params.getAccountSettingsSnapshot ?? getActiveAccountSettingsSnapshot;
  const ensureAccountSettingsSnapshot = params.ensureAccountSettingsSnapshot ?? (async () => {
    const credentials = await readStoredCredentials();
    if (!credentials) return;
    await warmActiveAccountSettingsSnapshotBestEffort({ credentials });
  });
  params.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_VOICE_CLIENT_MEDIATED_CREDENTIAL_MATERIALIZE,
    async (raw: unknown, context?: RpcHandlerContext) => {
      const request = DaemonVoiceClientMediatedCredentialMaterializeRequestV1Schema.safeParse(raw);
      if (!request.success) {
        return Object.freeze({
          ok: false as const,
          errorCode: 'plugin_voice_provider_result_invalid' as const,
        });
      }
      const signal = context?.signal ?? new AbortController().signal;
      const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
      try {
        signal.throwIfAborted();
        // The caller's declaration authority is checked before any provider or
        // Connected Account work: a client running a projection this daemon has
        // already replaced must never reach materialization, because its
        // approved operation projection is not the one resolved here.
        const declarationAuthority = request.data.declarationAuthority;
        if (declarationAuthority.kind === 'projected') {
          const cacheIdentity = declarationAuthority.cacheIdentity;
          if (
            cacheIdentity.pluginId !== request.data.contribution.pluginId
            || cacheIdentity.contributionId !== request.data.contribution.localId
            || cacheIdentity.platform !== request.data.platform
            || lease.registry.generation !== cacheIdentity.projectionGeneration
          ) return failure(null);
        }
        const provider = lease.registry.contributes.voiceProviders?.find((candidate) => (
          candidate.identity.pluginId === request.data.contribution.pluginId
          && candidate.identity.localId === request.data.contribution.localId
          && candidate.definition.kind === 'conversation'
          && candidate.definition.platforms.includes(request.data.platform)
        )) ?? null;
        const declaration = provider?.definition;
        if (!provider || !declaration || declaration.kind !== 'conversation') return failure(null);
        const lifecycle = lease.registry.resolveVoiceProviderRuntimeLifecycle?.(
          provider.identity,
        ) ?? null;
        if (!lifecycle?.isCurrent()) return failure(null);
        const identity = deriveVoiceCredentialBindingIdentityV1({
          pluginId: provider.pluginId,
          contribution: declaration,
        });
        if (!identity || !sameContribution(identity.contribution, request.data.contribution)) {
          return failure(null);
        }
        const operation = declaration.credentials?.hostMediated?.operations.find((candidate) => (
          candidate.id === request.data.operationId
          && candidate.credentialSlotId === identity.credentialSlotId
        ));
        let beforeSnapshot = getSnapshot();
        if (!beforeSnapshot && operation) {
          await ensureAccountSettingsSnapshot();
          signal.throwIfAborted();
          if (!lifecycle.isCurrent()) return failure(null);
          beforeSnapshot = getSnapshot();
        }
        if (!operation || !beforeSnapshot) return failure(null);
        const before = resolveAccountSettingsVoiceCredentialSource(beforeSnapshot.settings, {
          contribution: identity.contribution,
          credentialSlotId: identity.credentialSlotId,
          purpose: identity.purpose,
          machineId: null,
        });
        if (before.selection.kind !== 'connectedAccount') return failure(null);
        // Both processes resolve the selected source independently and each one
        // is internally consistent, so only comparing the caller's captured
        // selection against this daemon's can catch a switch that happened on
        // one side alone.
        if (!sameSelectedTarget(before.selection.target, request.data.expectedSelection)) {
          return failure(null);
        }
        const selectedService = targetService(before.selection.target);
        const authorization = resolveVoiceCredentialOperationAuthorization({
          pluginId: provider.pluginId,
          contributionId: provider.identity.localId,
          contribution: declaration,
          selectedSource: { kind: 'connectedAccount', service: selectedService },
          phase: request.data.phase,
          operationId: operation.id,
        });
        if (!authorization || authorization.projection.kind !== 'materializedHttpHeaders') {
          return failure(null);
        }
        const projection = authorization.projection;
        const connectedAccounts = lease.registry.resolveConnectedAccountPurposeBindingOwner?.() ?? null;
        if (!connectedAccounts) return failure(null);
        // The Account Settings snapshot read above and the Connected Account
        // binding store the owner resolves from are separate readers. Handing
        // the owner the exact account the caller captured makes it fence its own
        // resolution against that authority before and after materialization.
        const expectedSelection = request.data.expectedSelection;
        const materialization = await connectedAccounts.materialize({
          // The slot purpose owns both source selection and binding lookup.
          // The distinct operation purpose was consumed above when resolving
          // the exact operation projection and must not redirect the binding.
          purpose: identity.purpose,
          serviceRefs: Object.freeze([selectedService]),
          ...(expectedSelection.kind === 'account'
            ? { expectedAccount: expectedSelection.account }
            : {}),
          request: projection.request,
          signal,
        });
        signal.throwIfAborted();
        if (!lifecycle.isCurrent() || materialization.kind !== 'httpHeaders') return failure(null);
        const afterSnapshot = getSnapshot();
        if (!afterSnapshot) return failure(null);
        const after = resolveAccountSettingsVoiceCredentialSource(afterSnapshot.settings, {
          contribution: identity.contribution,
          credentialSlotId: identity.credentialSlotId,
          purpose: identity.purpose,
          machineId: null,
        });
        if (JSON.stringify(after.selection) !== JSON.stringify(before.selection)) return failure(null);
        const headers = exactHeaders(
          materialization.headers,
          projection.requiredHeaderNames,
          projection.allowedHeaderNames,
        );
        if (!headers) {
          return Object.freeze({
            ok: false as const,
            errorCode: 'plugin_voice_provider_operation_failed' as const,
          });
        }
        return DaemonVoiceClientMediatedCredentialMaterializeResponseV1Schema.parse({
          ok: true,
          headers,
        });
      } catch (error) {
        signal.throwIfAborted();
        return DaemonVoiceClientMediatedCredentialMaterializeResponseV1Schema.parse(failure(error));
      } finally {
        await lease.release();
      }
    },
  );
  return Object.freeze({ async dispose() {} });
}
