import {
  DaemonProviderModelProjectionResponseV1Schema,
  DaemonProviderModelsResponseV1Schema,
  DaemonProviderModelsRequestV1Schema,
  DaemonProviderProbeResponseV1Schema,
  type DaemonProviderModelProjectionRequestV1,
  type DaemonProviderModelProjectionResponseV1,
  type DaemonProviderModelsRequestV1,
  type DaemonProviderModelsResponseV1,
  type DaemonProviderProbeResponseV1,
} from '@happier-dev/protocol/rpc/providers';
import type { ProviderErrorV1 } from '@happier-dev/protocol';
import { randomUUID } from 'node:crypto';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createProviderErrorV1, providerErrorFromRpcFailure } from '@happier-dev/protocol/providers/errors';
import type { StoredCredentials } from '@/persistence';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { ProviderRuntimeModelProjectionReader } from '../spawn/runtimeCatalog';
import { logger } from '@/ui/logger';

/** Transport only: the caller owns Home/Account admission. The requested
 * operation retains source observation or selected-worker compatibility. */
export type AccountScopedProviderReadInput = Readonly<{
  serverUrl: string;
  readCredentials(): Promise<StoredCredentials | null>;
  readAccountSettingsSnapshot(): Promise<ActiveAccountSettingsSnapshot | null>;
  isCurrent(): boolean | Promise<boolean>;
}>;

function createAccountScopedProviderReader<TRequest extends Readonly<{ machineId: string }>,
  TResponse extends Readonly<{ status: string; error?: ProviderErrorV1 }>>(
  input: AccountScopedProviderReadInput,
  operation: Readonly<{
    method: string;
    context(request: TRequest): Readonly<{ machineId: string; connectionId?: string;
      connectedAccountTarget?: ProviderErrorV1['connectedAccountTarget'] }>;
    parse(value: unknown, request: TRequest): TResponse | null;
  }>,
): (request: TRequest, signal: AbortSignal) => Promise<TResponse | Readonly<{ status: 'error'; error: ProviderErrorV1 }>> {
  return async (request: TRequest, signal: AbortSignal) => {
    const context = operation.context(request);
    const unavailable = () => ({
      status: 'error' as const, error: createProviderErrorV1('provider_authorization_changed', context),
    });
    const projectionId = randomUUID();
    let phase: 'account_before' | 'machine_rpc' | 'account_after' | 'response' = 'account_before';
    let phaseStartedAt = performance.now();
    const record = (status: 'started' | 'completed' | 'failed', reason?: string) => logger.infoFile('[PROVIDER] Remote model projection phase', {
      projectionId, ...context, phase, status, durationMs: Math.round(performance.now() - phaseStartedAt),
      ...(reason ? { reason } : {}),
    });
    const nextPhase = (next: typeof phase) => {
      record('completed');
      phase = next;
      phaseStartedAt = performance.now();
      record('started');
    };
    const readCurrent = async () => {
      signal.throwIfAborted();
      const [credentials, snapshot, current] = await Promise.all([
        input.readCredentials(), input.readAccountSettingsSnapshot(), input.isCurrent(),
      ]);
      signal.throwIfAborted();
      return current && credentials && snapshot?.scopeKey === resolveAccountSettingsScopeKey(credentials)
        ? { credentials, scopeKey: snapshot.scopeKey } : null;
    };
    record('started');
    try {
      const admitted = await readCurrent();
      if (!admitted) { record('failed', 'provider_authorization_changed'); return unavailable(); }
      nextPhase('machine_rpc');
      const value = await callExactMachineRpc({
        credentials: admitted.credentials, serverUrl: input.serverUrl,
        machineId: request.machineId, requireCurrentMachine: true, requiredMachineKind: 'persistent',
        method: operation.method, request, signal,
        // The caller's admitted operation owns acknowledgement lifetime. The
        // existing transport retains its own connection/setup budgets.
        timeoutMs: null,
      });
      nextPhase('account_after');
      const current = await readCurrent();
      if (!current || current.scopeKey !== admitted.scopeKey
        || current.credentials.token !== admitted.credentials.token) {
        record('failed', 'provider_authorization_changed'); return unavailable();
      }
      nextPhase('response');
      const parsed = operation.parse(value, request);
      if (!parsed) {
        record('failed', 'provider_rpc_response_invalid');
        return { status: 'error', error: createProviderErrorV1('provider_rpc_response_invalid', context) };
      }
      record(parsed.status === 'error' ? 'failed' : 'completed', parsed.error?.code);
      return parsed.status === 'error' && parsed.error
        ? { ...parsed, error: providerErrorFromRpcFailure(parsed.error, context) } : parsed;
    } catch (error) {
      const refusal = providerErrorFromRpcFailure(error, context);
      record('failed', signal.aborted ? 'cancelled' : refusal.code);
      signal.throwIfAborted();
      return { status: 'error', error: refusal };
    }
  };
}

export function createAccountScopedProviderModelProjectionReader(input: AccountScopedProviderReadInput): ProviderRuntimeModelProjectionReader {
  return createAccountScopedProviderReader<DaemonProviderModelProjectionRequestV1, DaemonProviderModelProjectionResponseV1>(input, {
    method: RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION,
    context: request => ({ machineId: request.machineId,
      ...(request.providerConnection ? { connectionId: request.providerConnection.connectionId } : {}),
      ...(request.connectedAccountTarget ? { connectedAccountTarget: request.connectedAccountTarget } : {}) }),
    parse: (value, request) => {
      const parsed = DaemonProviderModelProjectionResponseV1Schema.safeParse(value);
      return parsed.success && (parsed.data.status !== 'success' || parsed.data.agentTargetKey === request.agentTargetKey)
        ? parsed.data : null;
    },
  });
}

/** Explicit catalog reads use the same exact-Home/Account transport as Session
 * projections. Placement and both Machines' grants remain domain decisions. */
export function createAccountScopedProviderCatalogReader(input: AccountScopedProviderReadInput): Readonly<{
  probe(request: Readonly<{ connectionId: string; machineId: string }>, signal: AbortSignal): Promise<DaemonProviderProbeResponseV1>;
  models(request: Readonly<{ connectionId: string; machineId: string }>, signal: AbortSignal): Promise<DaemonProviderModelsResponseV1>;
}> {
  const probe = createAccountScopedProviderReader(input, {
    method: RPC_METHODS.DAEMON_PROVIDERS_PROBE,
    context: (request: DaemonProviderModelsRequestV1) => request,
    parse: value => {
      const parsed = DaemonProviderProbeResponseV1Schema.safeParse(value);
      return parsed.success ? parsed.data : null;
    },
  });
  const models = createAccountScopedProviderReader(input, {
    method: RPC_METHODS.DAEMON_PROVIDERS_MODELS,
    context: (request: DaemonProviderModelsRequestV1) => request,
    parse: (value, request) => {
      const parsed = DaemonProviderModelsResponseV1Schema.safeParse(value);
      return parsed.success && (parsed.data.status !== 'success' || parsed.data.connectionId === request.connectionId)
        ? parsed.data : null;
    },
  });
  return Object.freeze({
    probe: (request, signal) => probe(DaemonProviderModelsRequestV1Schema.parse(request), signal),
    models: (request, signal) => models(DaemonProviderModelsRequestV1Schema.parse(request), signal),
  });
}
