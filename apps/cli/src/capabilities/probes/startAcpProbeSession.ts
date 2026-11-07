import type { AcpProbeBackend } from '@/agent/acp/runtime/acpRuntimeBackendContract';
import type { StartSessionResult } from '@/agent/core/AgentTypes';

/** Models, modes and configuration share the same configured ACP probe startup budget. */
export async function startAcpProbeSession(params: Readonly<{ backend: AcpProbeBackend; timeoutMs: number }>): Promise<StartSessionResult> {
  const timeoutMs = Math.max(250, params.timeoutMs);
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => reject(new Error(`ACP startSession timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([params.backend.startSession(), timeout]);
  } finally {
    if (timerId !== undefined) clearTimeout(timerId);
  }
}
