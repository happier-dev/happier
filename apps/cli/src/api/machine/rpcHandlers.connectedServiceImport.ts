import { CONNECTED_SERVICE_IMPORT_TIMEOUT_MS, ConnectedServiceImportParamsSchema, type ConnectedServiceImportResult } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { AGENTS_CORE } from '@happier-dev/agents';
import { AGENTS } from '@/backends/catalog';
import type { Credentials } from '@/persistence';
import type { ConnectedServiceCredentialStorageApi } from '@/cloud/connectedServices/storeConnectedServiceCredentialForAccount';
import { ConnectedServiceImportProviderError } from '@/cloud/connectedServices/connectedServiceImportProviderError';
import { buildConnectedAccountOauthCredentialRecord } from '@/daemon/connectedServices/descriptors/buildConnectedAccountCredentialRecord';
import { ConnectedServiceCredentialStorageResultUnknownError, ConnectedServiceCredentialIdentityMismatchError, ConnectedServiceCredentialStorageSupersededError, storeConnectedServiceCredentialForAccount } from '@/cloud/connectedServices/storeConnectedServiceCredentialForAccount';
import type { RpcHandlerContext, RpcHandlerRegistrar } from '../rpc/types';

export type ConnectedServiceImportAccount = Readonly<{
  api: ConnectedServiceCredentialStorageApi;
  credentials: Credentials;
}>;

/** Imports through the selected service's catalog owner; the RPC returns status, never credentials. */
export function registerMachineConnectedServiceImportRpcHandlers(params: Readonly<{ rpcHandlerManager: RpcHandlerRegistrar; account?: ConnectedServiceImportAccount }>): void {
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_CONNECTED_SERVICE_IMPORT, async (raw: unknown, _compat?: unknown, context?: RpcHandlerContext): Promise<ConnectedServiceImportResult> => {
    const parsed = ConnectedServiceImportParamsSchema.safeParse(raw);
    if (!parsed.success) return { success: false, errorCode: 'invalid_parameters', error: 'Invalid connected-service import parameters' };
    const remainingMs = Math.min(CONNECTED_SERVICE_IMPORT_TIMEOUT_MS, (parsed.data.deadlineAtMs ?? Date.now() + CONNECTED_SERVICE_IMPORT_TIMEOUT_MS) - Date.now());
    if (remainingMs <= 0) return { success: false, errorCode: 'cancelled', error: 'Connected-service import was cancelled.' };
    const deadline = AbortSignal.timeout(remainingMs);
    const signal = context?.signal ? AbortSignal.any([context.signal, deadline]) : deadline;
    try {
      signal.throwIfAborted();
      const account = params.account;
      if (!account) return { success: false, errorCode: 'authentication_required', error: 'Authenticate this machine with Happier first' };
      const entry = Object.values(AGENTS).find((candidate) => candidate?.getCloudConnectTarget
        && AGENTS_CORE[candidate.id].connectedServices?.supportedServiceIds.some((serviceId) => serviceId === parsed.data.serviceId));
      const target = await entry?.getCloudConnectTarget?.();
      if (!target?.importCredentials) return { success: false, errorCode: 'unsupported', error: 'This machine does not support connected-service import' };
      const imported = await target.importCredentials({ source: parsed.data.source, projectId: parsed.data.projectId, signal });
      const payload = imported.oauth;
      const record = buildConnectedAccountOauthCredentialRecord({ now: Date.now(), serviceId: parsed.data.serviceId, profileId: parsed.data.profileId, payload });
      await storeConnectedServiceCredentialForAccount({ ...account, record, requireSameProviderAccount: target.requireSameProviderAccount, signal });
      return { success: true, serviceId: parsed.data.serviceId, profileId: parsed.data.profileId, requiresBrowserReauthorization: imported.requiresBrowserReauthorization };
    } catch (error) {
      if (error instanceof ConnectedServiceCredentialStorageResultUnknownError) return { success: false, errorCode: 'storage_result_unknown', error: 'The import result is unknown. Refresh the profile before retrying.' };
      if (signal.aborted) return { success: false, errorCode: 'cancelled', error: 'Connected-service import was cancelled.' };
      if (error instanceof ConnectedServiceImportProviderError) return { success: false, errorCode: error.code, error: error.code === 'account_ineligible' ? 'This account is not eligible for personal OAuth access.' : 'This provider requires a verified project. Enter a project or connect in the browser.' };
      if (error instanceof ConnectedServiceCredentialIdentityMismatchError) return { success: false, errorCode: 'identity_mismatch', error: 'This profile belongs to a different account. Import into a new profile.' };
      if (error instanceof ConnectedServiceCredentialStorageSupersededError) return { success: false, errorCode: 'credential_superseded', error: 'This profile changed during import. Retry the import.' };
      // Provider responses and filesystem errors can contain secrets or private paths.
      return { success: false, errorCode: 'import_failed', error: 'Connected-service import failed. Check the selected machine login and project, or connect in your browser.' };
    }
  });
}
