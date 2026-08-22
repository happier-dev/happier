import axios from 'axios';
import { type MachineReplacementRecord } from '@happier-dev/protocol';

import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

/**
 * The Account's machine rows, reduced to the identity a REPLACEMENT walk needs.
 *
 * A replaced machine keeps its row and gains a forward pointer; nothing re-homes
 * the Sessions that named it. The daemon therefore cannot tell a Session it
 * inherited from its own predecessor apart from one belonging to an unrelated
 * machine without the Account's chain, and the chain lives only on the server —
 * the registration-time `replacesMachineId` candidate is consumed once the
 * server acknowledges it, and a MANUAL replacement (a genuinely new host, which
 * is what replacing a machine means) never passes through this daemon at all.
 *
 * One list read answers the whole walk, so callers never pay per hop. Callers
 * must ask only when the cheap identity comparison already failed.
 */
export async function fetchAccountMachineReplacements(params: Readonly<{
  credentials: Readonly<{ token: string }>;
  timeoutMs?: number;
}>): Promise<readonly MachineReplacementRecord[] | null> {
  try {
    const response = await axios.get(`${resolveServerHttpBaseUrl()}/v1/machines`, {
      headers: { Authorization: `Bearer ${params.credentials.token}` },
      timeout: params.timeoutMs && params.timeoutMs > 0 ? params.timeoutMs : 15_000,
    });
    if (!Array.isArray(response.data)) return null;
    // Only `id` and `replacedByMachineId` are read. Projecting here keeps the
    // encrypted metadata and key blobs the endpoint also serialises out of the
    // resolution entirely.
    return response.data.flatMap((row: unknown): MachineReplacementRecord[] => {
      if (!row || typeof row !== 'object') return [];
      const id = (row as { id?: unknown }).id;
      if (typeof id !== 'string' || id.trim().length === 0) return [];
      const replacedByMachineId = (row as { replacedByMachineId?: unknown }).replacedByMachineId;
      return [{
        id,
        ...(typeof replacedByMachineId === 'string' ? { replacedByMachineId } : {}),
      }];
    });
  } catch {
    // An unreadable chain proves nothing, and the caller's fallback is the
    // pre-existing refusal, so failing here fails closed.
    return null;
  }
}
