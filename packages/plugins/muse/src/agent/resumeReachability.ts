import type { AgentConnectedAccountResumeReachabilityInputV1, AgentConnectedAccountResumeReachabilityResultV1 } from '@happier-dev/plugin-sdk/agents/runtime';

import { MUSE_MODEL_COMMAND } from './catalog.js';
import { readMuseRecord } from './events.js';
import { initializeMuseMsp } from './msp.js';

/** Muse owns its opaque conversation identity; the host owns launch and disposal. */
export async function verifyMuseResumeReachable(
  input: AgentConnectedAccountResumeReachabilityInputV1,
): Promise<AgentConnectedAccountResumeReachabilityResultV1> {
  const nativeSessionId = input.vendorResumeId;
  if (!nativeSessionId || !input.nativeInspection) return { ok: false, reason: 'resume_native_session_unavailable' };
  try {
    return await input.nativeInspection.withDeclaredJsonRpcClient<AgentConnectedAccountResumeReachabilityResultV1>(MUSE_MODEL_COMMAND, async (client, signal) => {
      await initializeMuseMsp(client, { signal });
      const result = readMuseRecord(await client.request('session/read', { sessionId: nativeSessionId, excludeItems: true }));
      return readMuseRecord(result.session).sessionId === nativeSessionId
        ? { ok: true, proof: 'native_session' }
        : { ok: false, reason: 'resume_native_session_unavailable' };
    });
  } catch {
    return { ok: false, reason: 'resume_native_session_unavailable' };
  }
}
