import axios from 'axios';
import { z } from 'zod';

import {
  DaemonPluginInvocationLogReadRequestV1Schema,
  DaemonPluginInvocationLogReadResponseV1Schema,
  isRpcMethodNotAvailableError,
  isRpcMethodNotFoundError,
  type DaemonPluginInvocationLogReadResponseV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { readStoredCredentials } from '@/persistence';
import { callMachineRpc } from '@/session/transport/rpc/machineRpc';
import type { PluginInvocationLogQuery } from '@/ui/logger';

const MACHINE_INVENTORY_ROW_SCHEMA = z.object({
  id: z.string().trim().min(1),
  metadata: z.string(),
  active: z.boolean(),
  revokedAt: z.number().nullable(),
  replacedByMachineId: z.string().nullable(),
}).passthrough();

const MACHINE_INVENTORY_SCHEMA = z.array(MACHINE_INVENTORY_ROW_SCHEMA);

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

function readMachineLabel(metadata: string, fallback: string): string {
  try {
    const value: unknown = JSON.parse(metadata);
    if (!value || typeof value !== 'object') return fallback;
    const host = nonEmptyString((value as Readonly<Record<string, unknown>>).host);
    return host ?? fallback;
  } catch {
    return fallback;
  }
}

function unavailable(code: string, message: string): PluginInvocationLogTargetResolution {
  return { kind: 'unavailable', code, message };
}

function projectCurrentMachineTarget(params: Readonly<{
  row: z.infer<typeof MACHINE_INVENTORY_ROW_SCHEMA>;
  serverIdentityId: string;
  serverLabel: string;
}>): PluginInvocationLogMachineTarget | null {
  const { row } = params;
  if (!row.active || row.revokedAt !== null || row.replacedByMachineId !== null) return null;
  return {
    serverIdentityId: params.serverIdentityId,
    serverLabel: params.serverLabel,
    machineId: row.id,
    machineLabel: readMachineLabel(row.metadata, row.id),
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

  let rawInventory: unknown;
  try {
    const response = await axios.get<unknown>(`${resolveServerHttpBaseUrl()}/v1/machines`, {
      headers: {
        ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        Authorization: `Bearer ${credentials.token}`,
      },
      timeout: 20_000,
      ...(params.signal ? { signal: params.signal } : {}),
    });
    rawInventory = response.data;
  } catch (error) {
    params.signal?.throwIfAborted();
    return unavailable('machine_inventory_unavailable', 'The current machine inventory is unavailable.');
  }
  params.signal?.throwIfAborted();

  const inventory = MACHINE_INVENTORY_SCHEMA.safeParse(rawInventory);
  if (!inventory.success) {
    return unavailable('machine_inventory_unavailable', 'The current machine inventory is unavailable.');
  }

  if (snapshot.status !== 'ready') {
    return unavailable('server_identity_unavailable', 'The current server identity is unavailable.');
  }
  const canonicalServerUrl = snapshot.features.capabilities.server?.canonicalServerUrl;
  const serverLabel = nonEmptyString(canonicalServerUrl) ?? resolveServerHttpBaseUrl();
  const requestedMachineId = nonEmptyString(params.requestedMachineId);
  if (params.requestedMachineId !== undefined && !requestedMachineId) {
    return unavailable('machine_not_current', 'The selected machine is no longer active.');
  }

  if (requestedMachineId) {
    const selected = inventory.data.find((row) => row.id === requestedMachineId) ?? null;
    const target = selected
      ? projectCurrentMachineTarget({ row: selected, serverIdentityId, serverLabel })
      : null;
    return target
      ? { kind: 'selected', target }
      : unavailable('machine_not_current', 'The selected machine is no longer active.');
  }

  const candidates = inventory.data.flatMap((row) => {
    const target = projectCurrentMachineTarget({ row, serverIdentityId, serverLabel });
    return target ? [target] : [];
  });
  if (candidates.length === 0) {
    return unavailable('no_current_machine', 'No current machine is available to read plugin logs.');
  }
  if (candidates.length > 1) {
    return { kind: 'selection_required', candidates };
  }
  return { kind: 'selected', target: candidates[0]! };
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
