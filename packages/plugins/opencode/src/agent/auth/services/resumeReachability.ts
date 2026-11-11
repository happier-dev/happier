import type { AgentConnectedAccountResumeReachabilityInputV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { OPEN_CODE_SYSTEM_TOOL_ID } from '../../systemTool.js';

export async function verifyOpenCodeResumeReachable(
  input: AgentConnectedAccountResumeReachabilityInputV1,
) {
  if (!input.vendorResumeId) return { ok: false as const, reason: 'vendor_resume_id_missing' };
  if (!input.nativeInspection) return { ok: false as const, reason: 'opencode_resume_inspection_unavailable' };
  try {
    await input.nativeInspection.withDeclaredJsonRpcClient({ toolId: OPEN_CODE_SYSTEM_TOOL_ID, args: ['acp'] }, async (client) => {
      await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
      await client.request('session/load', { sessionId: input.vendorResumeId, cwd: input.nativeInspection!.cwd, mcpServers: [] });
    });
    return { ok: true as const, proof: 'native_session' as const };
  } catch {
    return { ok: false as const, reason: 'opencode_resume_unreachable' };
  }
}
