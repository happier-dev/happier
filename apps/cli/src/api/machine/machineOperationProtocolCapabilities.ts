import axios from 'axios';
import {
  MachineOperationProtocolCapabilitiesV1Schema,
  type MachineOperationProtocolCapabilitiesV1,
} from '@happier-dev/protocol';

import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import {
  createAuthenticationHttpStatusError,
  isAuthenticationStatus,
} from '@/api/client/httpStatusError';
import type { StoredCredentials } from '@/persistence';

export type MachineOperationProtocolCapabilitiesProjectionV1 = Readonly<{
  capabilities: MachineOperationProtocolCapabilitiesV1;
  revision: number;
}>;

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

/**
 * Parses the one server-owned exact-Machine capability projection. Any absent,
 * malformed, revoked, or replaced record is intentionally incompatible.
 */
export function readMachineOperationProtocolCapabilitiesProjectionV1(params: Readonly<{
  machineId: string;
  value: unknown;
}>): MachineOperationProtocolCapabilitiesProjectionV1 | null {
  const machineId = params.machineId.trim();
  const value = asRecord(params.value);
  if (!machineId || value?.id !== machineId) return null;
  if (value.revokedAt !== null || value.replacedByMachineId !== null) return null;

  const capabilities = MachineOperationProtocolCapabilitiesV1Schema.safeParse(
    value.operationProtocolCapabilities,
  );
  const revision = value.operationProtocolCapabilitiesRevision;
  if (
    !capabilities.success
    || typeof revision !== 'number'
    || !Number.isInteger(revision)
    || revision <= 0
  ) {
    return null;
  }

  return {
    capabilities: capabilities.data,
    revision,
  };
}

/**
 * Reads one exact target Machine from the configured active server. This is the
 * persisted preflight input only; callers must still negotiate their operation
 * with the live daemon immediately before causing an effect.
 */
export async function readMachineOperationProtocolCapabilitiesV1(params: Readonly<{
  credentials: Pick<StoredCredentials, 'token'>;
  machineId: string;
  signal?: AbortSignal;
}>): Promise<MachineOperationProtocolCapabilitiesProjectionV1 | null> {
  params.signal?.throwIfAborted();
  const machineId = params.machineId.trim();
  if (!machineId) return null;

  const response = await axios.get(
    `${resolveServerHttpBaseUrl()}/v1/machines/${encodeURIComponent(machineId)}`,
    {
      headers: {
        ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        Authorization: `Bearer ${params.credentials.token}`,
      },
      timeout: 15_000,
      validateStatus: () => true,
      ...(params.signal ? { signal: params.signal } : {}),
    },
  );

  if (response.status === 404 || response.status === 410) return null;
  if (isAuthenticationStatus(response.status)) {
    throw createAuthenticationHttpStatusError(
      response.status,
      `Authentication failed while reading Machine capability snapshot (${response.status})`,
    );
  }
  if (response.status !== 200) {
    throw new Error(`Failed to read Machine capability snapshot: ${response.status}`);
  }
  const responseData = asRecord(response.data);
  return readMachineOperationProtocolCapabilitiesProjectionV1({
    machineId,
    value: responseData?.machine,
  });
}
