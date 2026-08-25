import {
  DaemonPluginInvocationLogReadRequestV1Schema,
  DaemonPluginInvocationLogReadResponseV1Schema,
  isRpcMethodNotAvailableError,
  isRpcMethodNotFoundError,
  type DaemonPluginInvocationLogReadResponseV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveCurrentAccountMachineTarget } from '@/api/machine/resolveCurrentAccountMachineTarget';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { readStoredCredentials } from '@/persistence';
import { callMachineRpc } from '@/session/transport/rpc/machineRpc';
import type { PluginInvocationLogQuery } from '@/ui/logger';

export type PluginInvocationLogMachineTarget = Readonly<{
  serverIdentityId: string;
  serverLabel: string;
  machineId: string;
  machineLabel: string;
}>;

export type PluginInvocationLogTargetResolution =
  | Readonly<{ kind: 'selected'; target: PluginInvocationLogMachineTarget }>
  | Readonly<{
      kind: 'selection_required';
      candidates: readonly PluginInvocationLogMachineTarget[];
    }>
  | Readonly<{
      kind: 'unavailable';
      code: string;
      message: string;
    }>;

export type MachinePluginInvocationLogReadResult =
  | Extract<DaemonPluginInvocationLogReadResponseV1, { kind: 'available' }>
  | Readonly<{ kind: 'unavailable'; code: string }>;

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function unavailable(code: string, message: string): PluginInvocationLogTargetResolution {
  return { kind: 'unavailable', code, message };
}

function projectCurrentMachineTarget(params: Readonly<{
  machineId: string;
  machineLabel: string;
  serverIdentityId: string;
  serverLabel: string;
}>): PluginInvocationLogMachineTarget {
  return {
    serverIdentityId: params.serverIdentityId,
    serverLabel: params.serverLabel,
    machineId: params.machineId,
    machineLabel: params.machineLabel,
  };
}

/**
 * Selects one exact current daemon from the authenticated machine inventory.
 * The result carries the host-stamped server identity that the target daemon
 * validates again on the RPC boundary; no local-daemon fallback is permitted.
 */
export async function resolvePluginInvocationLogTarget(params: Readonly<{
  requestedMachineId?: string;
  signal?: AbortSignal;
}>): Promise<PluginInvocationLogTargetResolution> {
  params.signal?.throwIfAborted();
  const credentials = await readStoredCredentials().catch(() => null);
  params.signal?.throwIfAborted();
  if (!credentials) {
    return unavailable('not_authenticated', 'Sign in before reading plugin logs from a machine.');
  }

  const snapshot = await fetchServerFeaturesSnapshot({
    serverUrl: resolveServerHttpBaseUrl(),
    timeoutMs: 1_500,
  });
  params.signal?.throwIfAborted();
  const serverIdentityId = snapshot.status === 'ready'
    ? snapshot.features.capabilities.serverIdentity.serverIdentityId
    : null;
  if (!serverIdentityId) {
    return unavailable('server_identity_unavailable', 'The current server identity is unavailable.');
  }

  if (snapshot.status !== 'ready') {
    return unavailable('server_identity_unavailable', 'The current server identity is unavailable.');
  }
  const canonicalServerUrl = snapshot.features.capabilities.server?.canonicalServerUrl;
  const serverLabel = nonEmptyString(canonicalServerUrl) ?? resolveServerHttpBaseUrl();
  const resolved = await resolveCurrentAccountMachineTarget({
    token: credentials.token,
    ...(params.requestedMachineId !== undefined ? { requestedMachineId: params.requestedMachineId } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (resolved.kind === 'unavailable') return resolved;
  if (resolved.kind === 'selection_required') {
    return {
      kind: 'selection_required',
      candidates: resolved.candidates.map((candidate) => projectCurrentMachineTarget({
        ...candidate,
        serverIdentityId,
        serverLabel,
      })),
    };
  }
  return {
    kind: 'selected',
    target: projectCurrentMachineTarget({
      ...resolved.target,
      serverIdentityId,
      serverLabel,
    }),
  };
}

/**
 * Executes one exact-machine log read. The daemon remains the only query
 * owner; this adapter only preserves target identity, wire validation, and
 * truthful compatibility/transport outcomes.
 */
export async function readPluginInvocationLogsOnMachine(params: Readonly<{
  target: PluginInvocationLogMachineTarget;
  request: PluginInvocationLogQuery;
  signal?: AbortSignal;
}>): Promise<MachinePluginInvocationLogReadResult> {
  params.signal?.throwIfAborted();
  const credentials = await readStoredCredentials().catch(() => null);
  params.signal?.throwIfAborted();
  if (!credentials) return { kind: 'unavailable', code: 'not_authenticated' };

  const request = DaemonPluginInvocationLogReadRequestV1Schema.parse({
    version: 1,
    target: {
      serverIdentityId: params.target.serverIdentityId,
      machineId: params.target.machineId,
    },
    query: params.request,
  });

  try {
    const raw = await callMachineRpc({
      credentials,
      machineId: params.target.machineId,
      method: RPC_METHODS.DAEMON_PLUGIN_INVOCATION_LOGS_READ,
      request,
      timeoutMs: 30_000,
      ...(params.signal ? { signal: params.signal } : {}),
    });
    params.signal?.throwIfAborted();
    const response = DaemonPluginInvocationLogReadResponseV1Schema.safeParse(raw);
    if (!response.success) {
      return { kind: 'unavailable', code: 'daemon_plugin_log_read_unsupported' };
    }
    if (response.data.kind === 'unavailable') {
      return { kind: 'unavailable', code: `daemon_${response.data.code}` };
    }
    return response.data;
  } catch (error) {
    params.signal?.throwIfAborted();
    if (isRpcMethodNotFoundError(error) || isRpcMethodNotAvailableError(error)) {
      return { kind: 'unavailable', code: 'daemon_plugin_log_read_unsupported' };
    }
    return { kind: 'unavailable', code: 'daemon_plugin_log_read_unavailable' };
  }
}
