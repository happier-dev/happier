import {
  DaemonProviderModelProjectionResponseV1Schema,
} from '@happier-dev/protocol/rpc/providers';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createProviderErrorV1, providerErrorFromRpcFailure } from '@happier-dev/protocol/providers/errors';
import type { StoredCredentials } from '@/persistence';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { ProviderRuntimeModelProjectionReader } from '../spawn/runtimeCatalog';

/** Transport only: the caller owns Home/Account admission and the target owns
 * source projection, compatibility, probing and managed consumer custody. */
export function createAccountScopedProviderModelProjectionReader(input: Readonly<{
  serverUrl: string;
  readCredentials(): Promise<StoredCredentials | null>;
  readAccountSettingsSnapshot(): Promise<ActiveAccountSettingsSnapshot | null>;
  isCurrent(): boolean | Promise<boolean>;
}>): ProviderRuntimeModelProjectionReader {
  return async (request, signal) => {
    const context = {
      machineId: request.machineId,
      ...(request.providerConnection ? { connectionId: request.providerConnection.connectionId } : {}),
    };
    const unavailable = () => ({
      status: 'error' as const, error: createProviderErrorV1('provider_authorization_changed', context),
    });
    const readCurrent = async () => {
      signal.throwIfAborted();
      const [credentials, snapshot, current] = await Promise.all([
        input.readCredentials(), input.readAccountSettingsSnapshot(), input.isCurrent(),
      ]);
      signal.throwIfAborted();
      return current && credentials && snapshot?.scopeKey === resolveAccountSettingsScopeKey(credentials)
        ? { credentials, scopeKey: snapshot.scopeKey } : null;
    };
    try {
      const admitted = await readCurrent();
      if (!admitted) return unavailable();
      const value = await callExactMachineRpc({
        credentials: admitted.credentials, serverUrl: input.serverUrl,
        machineId: request.machineId, requireCurrentMachine: true, requiredMachineKind: 'persistent',
        method: RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, request, signal,
        // The caller's admitted operation owns acknowledgement lifetime. The
        // existing transport retains its own connection/setup budgets.
        timeoutMs: null,
      });
      const current = await readCurrent();
      if (!current || current.scopeKey !== admitted.scopeKey
        || current.credentials.token !== admitted.credentials.token) return unavailable();
      const parsed = DaemonProviderModelProjectionResponseV1Schema.safeParse(value);
      if (!parsed.success || parsed.data.status === 'success' && parsed.data.agentTargetKey !== request.agentTargetKey) {
        return { status: 'error', error: createProviderErrorV1('provider_rpc_response_invalid', context) };
      }
      return parsed.data;
    } catch (error) {
      signal.throwIfAborted();
      return { status: 'error', error: providerErrorFromRpcFailure(error, context) };
    }
  };
}
