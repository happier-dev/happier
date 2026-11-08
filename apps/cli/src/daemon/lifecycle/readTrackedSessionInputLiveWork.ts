import type { SessionInputLiveWork } from '@/agent/runtime/session/input/_types';
import { requestSessionInputLiveWork } from '@/agent/runtime/session/input/sessionProviderInputAdmissionRpc';
import { withTrackedSessionRpc, withTrackedSessionRpcContext } from '../sessionEncryption/withTrackedSessionRpc';

/** Read the existing Session-input authority without hiding transport failures. */
export async function readTrackedSessionInputLiveWorkRequired(input: Parameters<typeof withTrackedSessionRpc>[0]): Promise<SessionInputLiveWork> {
  // Passive activity observations reuse the runner's held RPC encryption; they read no Session record.
  const work = await withTrackedSessionRpcContext(input, callRpc => requestSessionInputLiveWork({ callRpc }));
  if (!work) throw new Error('Session input activity observation is unavailable');
  return work;
}

/** Inventory readers retain their existing unknown projection on failed observations. */
export async function readTrackedSessionInputLiveWork(input: Parameters<typeof withTrackedSessionRpc>[0]): Promise<SessionInputLiveWork> {
  try {
    return await readTrackedSessionInputLiveWorkRequired(input);
  } catch { return { session: 'unknown', input: 'unknown' }; }
}
