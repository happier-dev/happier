import type { z } from 'zod';
import { DaemonAgentInstallStartResponseSchema, DaemonAgentInstallReadResponseSchema, DaemonAgentInstallCancelResponseSchema, DaemonAgentInstallListResponseSchema } from '@happier-dev/protocol/daemon/agent-install-jobs';
import type { DaemonAgentInstallStartRequest, DaemonAgentInstallReadRequest, DaemonAgentInstallCancelRequest } from '@happier-dev/protocol/daemon/agent-install-jobs';
import { daemonPost, type DaemonControlRequestOptions } from './controlHttp';

export type AgentInstallTransportError = { ok: false; errorCode: 'daemon_unavailable' | 'invalid_daemon_response'; error: string };

async function requestJob<T>(path: string, body: unknown, schema: z.ZodType<T>, options: DaemonControlRequestOptions): Promise<T | AgentInstallTransportError> {
  const raw: unknown = await daemonPost(path, body, options);
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  if (raw && typeof raw === 'object' && 'error' in raw && typeof raw.error === 'string') {
    return { ok: false, errorCode: 'daemon_unavailable', error: `${raw.error}. Start the local daemon with happier daemon start, then retry.` };
  }
  return { ok: false, errorCode: 'invalid_daemon_response', error: 'The daemon returned an invalid agent install job response. Update the daemon, then retry.' };
}

export function startDaemonAgentInstallJob(request: DaemonAgentInstallStartRequest, options: DaemonControlRequestOptions = {}) {
  return requestJob('/agents/install/start', request, DaemonAgentInstallStartResponseSchema, options);
}
export function readDaemonAgentInstallJob(request: DaemonAgentInstallReadRequest, options: DaemonControlRequestOptions = {}) {
  return requestJob('/agents/install/read', request, DaemonAgentInstallReadResponseSchema, options);
}
export function cancelDaemonAgentInstallJob(request: DaemonAgentInstallCancelRequest, options: DaemonControlRequestOptions = {}) {
  return requestJob('/agents/install/cancel', request, DaemonAgentInstallCancelResponseSchema, options);
}
export function listDaemonAgentInstallJobs(options: DaemonControlRequestOptions = {}) {
  return requestJob('/agents/install/list', {}, DaemonAgentInstallListResponseSchema, options);
}
