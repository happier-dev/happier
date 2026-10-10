import type { SessionInputLiveWork } from '@/agent/runtime/session/input/_types';
import { requestSessionInputLiveWork } from '@/agent/runtime/session/input/sessionProviderInputAdmissionRpc';
import { withTrackedSessionRpc } from '../sessionEncryption/withTrackedSessionRpc';

/** The existing Session-input observer; the live inventory remains its sole census. */
export async function readTrackedSessionInputLiveWork(input: Parameters<typeof withTrackedSessionRpc>[0]): Promise<SessionInputLiveWork> {
  const unknown = { session: 'unknown', input: 'unknown' } as const;
  try {
    return await withTrackedSessionRpc(input, callRpc => requestSessionInputLiveWork({ callRpc })) ?? unknown;
  } catch { return unknown; }
}
