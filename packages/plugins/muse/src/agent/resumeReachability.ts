import type { AgentConnectedAccountResumeReachabilityInputV1, AgentConnectedAccountResumeReachabilityResultV1 } from '@happier-dev/plugin-sdk/agents/runtime';

import { MUSE_MODEL_COMMAND } from './catalog.js';
import { initializeMuseMsp, isMuseMspSessionNotFound, readMuseMspErrorKind } from './msp.js';
import { readMuseRecord } from './nativeInput.js';

/** Muse owns its opaque conversation identity; the host owns launch and disposal. */
export async function verifyMuseResumeReachable(
  input: AgentConnectedAccountResumeReachabilityInputV1,
): Promise<AgentConnectedAccountResumeReachabilityResultV1> {
  const nativeSessionId = input.vendorResumeId;
  if (!nativeSessionId || !input.nativeInspection) return { ok: false, reason: 'resume_native_session_unavailable' };
  return input.nativeInspection.withDeclaredJsonRpcClient<AgentConnectedAccountResumeReachabilityResultV1>(MUSE_MODEL_COMMAND, async (client, signal) => {
    await initializeMuseMsp(client, { signal });
    try {
      const result = readMuseRecord(await client.request('session/read', { sessionId: nativeSessionId, excludeItems: true }));
      return readMuseRecord(result.session).sessionId === nativeSessionId
        ? { ok: true, proof: 'native_session' }
        : { ok: false, reason: 'resume_reachability_check_failed' };
    } catch (error) {
      if (isMuseMspSessionNotFound(readMuseMspErrorKind(error))) {
        return { ok: false, reason: 'resume_native_session_unavailable' };
      }
      throw error;
    }
  });
}
