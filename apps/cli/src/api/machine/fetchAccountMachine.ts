import axios from 'axios';
import { z } from 'zod';

import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { accountMachineSchema, type AccountMachineInventoryRow } from './fetchAccountMachines';
import { lazySchema } from '@happier-dev/protocol';

const accountMachineResponseSchema = lazySchema(() => z.object({ machine: accountMachineSchema }));

/** Reads the exact Account-owned row; transport uncertainty is never absence. */
export async function fetchAccountMachine(params: Readonly<{
  credentials: Readonly<{ token: string }>;
  machineId: string;
  timeoutMs?: number;
}>): Promise<AccountMachineInventoryRow | null> {
  const response = await axios.get<unknown>(
    `${resolveServerHttpBaseUrl()}/v1/machines/${encodeURIComponent(params.machineId)}`,
    {
      headers: { Authorization: `Bearer ${params.credentials.token}` },
      ...(params.timeoutMs && params.timeoutMs > 0 ? { timeout: params.timeoutMs } : {}),
      validateStatus: () => true,
    },
  );
  if (response.status === 404) return null;
  if (response.status !== 200) {
    throw Object.assign(new Error(`Unable to read machine: HTTP ${response.status}`), { status: response.status });
  }
  const { machine } = accountMachineResponseSchema.parse(response.data);
  if (machine.id !== params.machineId) throw new Error('Machine response identity mismatch');
  return machine;
}
