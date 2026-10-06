import { isDeepStrictEqual } from 'node:util';

import { DaemonVoiceClientAccountOperationRequestV1Schema, DaemonVoiceClientAccountOperationResponseV1Schema } from '@happier-dev/protocol/daemon/voiceCredentials';
import { deriveVoiceCredentialBindingIdentityV1 } from '@happier-dev/protocol/plugins/contributions/voice';
import { resolveAccountSettingsVoiceCredentialSource } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type { PluginContributionIdentityV1, QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { isPluginError } from '@happier-dev/plugin-sdk';
import { classifyVoiceProviderHttpFailure } from '@happier-dev/plugin-sdk/voice';

import {
  getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken,
  type ActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { readStoredCredentials } from '@/persistence';
import { warmActiveAccountSettingsSnapshotBestEffort } from '@/settings/accountSettings/warmActiveAccountSettingsSnapshot';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { createVoiceCredentialResolver } from '@/daemon/voice/credentials/resolver';
import { createGlobalFetchRuntime } from '@/plugins/runtime/fetch/globalFetchRuntime';
import { createVoiceAccountOperationService } from '@/plugins/runtime/fetch/voiceAccountCredentialBinding';
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
    && (error.code === 'plugin_voice_provider_operation_failed'
      || error.code === 'plugin_fetch_voice_account_operation_failed'
      || error.code === 'plugin_fetch_voice_client_auth_artifact_invalid'
      || error.code === 'plugin_fetch_voice_catalog_artifact_invalid')) {
    return Object.freeze({ ok: false as const, errorCode: 'plugin_voice_provider_operation_failed' as const });
  }
  return Object.freeze({ ok: false as const, errorCode: 'plugin_voice_credential_access_unavailable' as const });
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
    RPC_METHODS.DAEMON_VOICE_CLIENT_ACCOUNT_OPERATION,
    async (raw: unknown, context?: RpcHandlerContext) => {
      const request = DaemonVoiceClientAccountOperationRequestV1Schema.safeParse(raw);
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
        // Resolve the exact live declaration before any credential or HTTP work.
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
        const capturedSnapshot = beforeSnapshot;
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
        const connectedAccounts = lease.registry.resolveConnectedAccountPurposeBindingOwner?.() ?? null;
        if (!connectedAccounts) return failure(null);
        const snapshotLifetime = getActiveAccountSettingsSnapshotLifetimeToken();
        const isCredentialCurrent = () => {
          const current = getSnapshot();
          if (!current || getActiveAccountSettingsSnapshotLifetimeToken() !== snapshotLifetime) return false;
          if (capturedSnapshot.scopeKey === undefined || current.scopeKey === undefined) {
            if (current !== capturedSnapshot) return false;
          } else if (current.scopeKey !== capturedSnapshot.scopeKey) return false;
          try {
            return isDeepStrictEqual(before, resolveAccountSettingsVoiceCredentialSource(current.settings, {
              contribution: identity.contribution,
              credentialSlotId: identity.credentialSlotId,
              purpose: identity.purpose,
              machineId: null,
            }));
          } catch { return false; }
        };
        const operationSignal = AbortSignal.any([signal, lifecycle.retirementSignal]);
        let httpFailure: ReturnType<typeof classifyVoiceProviderHttpFailure> = null;
        const operations = createVoiceAccountOperationService({
          voiceProviders: lease.registry.contributes.voiceProviders ?? [],
          provider: provider.identity,
          kind: 'conversation',
          phase: request.data.phase,
          credentialResolver: createVoiceCredentialResolver({ machineId: null, getSnapshot }),
          connectedAccounts,
          isCurrent: lifecycle.isCurrent,
          isCredentialCurrent,
          signal: operationSignal,
          transport: createGlobalFetchRuntime(),
          recordResponseDiagnostic: (diagnostic) => {
            httpFailure = classifyVoiceProviderHttpFailure(diagnostic.status);
          },
        });
        const response = await operations.request({
          operationId: request.data.operationId,
          parameters: request.data.parameters,
          signal: operationSignal,
        }).catch((error: unknown) => {
          if (httpFailure === 'credential_unavailable') {
            throw Object.assign(new Error('credential_unavailable'), { code: 'credential_unavailable' });
          }
          throw error;
        });
        signal.throwIfAborted();
        return DaemonVoiceClientAccountOperationResponseV1Schema.parse({
          ok: true,
          response: {
            status: response.status,
            finalUrl: response.finalUrl,
            headers: response.headers,
            bodyBase64: Buffer.from(response.body).toString('base64'),
          },
        });
      } catch (error) {
        signal.throwIfAborted();
        return DaemonVoiceClientAccountOperationResponseV1Schema.parse(failure(error));
      } finally {
        await lease.release();
      }
    },
  );
  return Object.freeze({ async dispose() {} });
}
