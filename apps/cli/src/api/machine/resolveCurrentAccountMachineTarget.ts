import axios from 'axios';
import { z } from 'zod';

import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

const ACCOUNT_MACHINE_ROW_SCHEMA = z.object({
  id: z.string().trim().min(1),
  metadata: z.string().optional(),
  active: z.boolean(),
  revokedAt: z.number().nullable(),
  replacedByMachineId: z.string().nullable(),
}).passthrough();

const ACCOUNT_MACHINE_INVENTORY_SCHEMA = z.array(ACCOUNT_MACHINE_ROW_SCHEMA);

export type CurrentAccountMachineTarget = Readonly<{
  machineId: string;
  machineLabel: string;
}>;

export type CurrentAccountMachineTargetResolution =
  | Readonly<{ kind: 'selected'; target: CurrentAccountMachineTarget }>
  | Readonly<{ kind: 'selection_required'; candidates: readonly CurrentAccountMachineTarget[] }>
  | Readonly<{ kind: 'unavailable'; code: string; message: string }>;

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readMachineLabel(metadata: string | undefined, fallback: string): string {
  if (!metadata) return fallback;
  try {
    const value: unknown = JSON.parse(metadata);
    if (!value || typeof value !== 'object') return fallback;
    return nonEmptyString((value as Readonly<Record<string, unknown>>).host) ?? fallback;
  } catch {
    return fallback;
  }
}

function unavailable(code: string, message: string): CurrentAccountMachineTargetResolution {
  return { kind: 'unavailable', code, message };
}

function projectCurrentMachineTarget(
  row: z.infer<typeof ACCOUNT_MACHINE_ROW_SCHEMA>,
): CurrentAccountMachineTarget | null {
  if (!row.active || row.revokedAt !== null || row.replacedByMachineId !== null) return null;
  return { machineId: row.id, machineLabel: readMachineLabel(row.metadata, row.id) };
}

/**
 * Resolves an automatic current-daemon target from the authenticated account inventory.
 *
 * This is the single API-inventory owner for callers without an explicit
 * target or daemon-local default. An explicit machine id already names the
 * Action target, so it must not depend on inventory availability; the Action
 * ingress owns validating that target. Automatic selection accepts both the
 * stored credential inventory shape and the API-token bootstrap shape, whose
 * rows deliberately omit machine metadata.
 */
export async function resolveCurrentAccountMachineTarget(params: Readonly<{
  token: string;
  requestedMachineId?: string;
  signal?: AbortSignal;
}>): Promise<CurrentAccountMachineTargetResolution> {
  params.signal?.throwIfAborted();
  const requestedMachineId = nonEmptyString(params.requestedMachineId);
  if (params.requestedMachineId !== undefined) {
    return requestedMachineId
      ? {
        kind: 'selected',
        target: { machineId: requestedMachineId, machineLabel: requestedMachineId },
      }
      : unavailable('machine_not_current', 'The selected machine is no longer active.');
  }

  let rawInventory: unknown;
  try {
    const response = await axios.get<unknown>(`${resolveServerHttpBaseUrl()}/v1/machines`, {
      headers: {
        ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        Authorization: `Bearer ${params.token}`,
      },
      timeout: 20_000,
      ...(params.signal ? { signal: params.signal } : {}),
    });
    rawInventory = response.data;
  } catch {
    params.signal?.throwIfAborted();
    return unavailable('machine_inventory_unavailable', 'The current machine inventory is unavailable.');
  }
  params.signal?.throwIfAborted();

  const inventory = ACCOUNT_MACHINE_INVENTORY_SCHEMA.safeParse(rawInventory);
  if (!inventory.success) {
    return unavailable('machine_inventory_unavailable', 'The current machine inventory is unavailable.');
  }

  const candidates = inventory.data.flatMap((row) => {
    const target = projectCurrentMachineTarget(row);
    return target ? [target] : [];
  });
  if (candidates.length === 0) {
    return unavailable('no_current_machine', 'No current machine is available.');
  }
  if (candidates.length > 1) return { kind: 'selection_required', candidates };
  return { kind: 'selected', target: candidates[0]! };
}
