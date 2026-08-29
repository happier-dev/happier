import type {
  AgentExternalSessionTakeoverContribution,
  AgentExternalSessionTakeoverResolveLaunchRequest,
  AgentExternalSessionTakeoverResolveLaunchResult,
} from '@happier-dev/plugin-sdk/sessions/external';

import { projectOpenCodeExternalSessionSource } from './client.js';
import { buildOpenCodeAgentRuntimeDescriptorV1 } from '../../../identity/runtimeDescriptor.js';

function invocationFailure(
  request: AgentExternalSessionTakeoverResolveLaunchRequest,
): AgentExternalSessionTakeoverResolveLaunchResult | null {
  if (request.signal.aborted) {
    return {
      ok: false,
      code: 'cancelled',
      message: 'OpenCode external-session takeover launch resolution was cancelled.',
    };
  }
  if (Date.now() >= request.deadlineAtMs) {
    return {
      ok: false,
      code: 'timeout',
      message: 'OpenCode external-session takeover launch resolution timed out.',
    };
  }
  return null;
}

async function resolveLaunch(
  request: AgentExternalSessionTakeoverResolveLaunchRequest,
): Promise<AgentExternalSessionTakeoverResolveLaunchResult> {
  const stopped = invocationFailure(request);
  if (stopped) return stopped;
  const source = projectOpenCodeExternalSessionSource(request.source);
  if (!source) {
    return {
      ok: false,
      code: 'source_invalid',
      message: 'OpenCode external-session takeover requires an opencodeServer source.',
    };
  }

  return {
    ok: true,
    value: {
      runtimeDescriptorV1: buildOpenCodeAgentRuntimeDescriptorV1({
        backendMode: 'server',
        providerSessionId: request.remoteSessionId,
      }),
    },
  };
}

export const openCodeExternalSessionTakeoverContribution = Object.freeze({
  resolveLaunch,
}) satisfies AgentExternalSessionTakeoverContribution;
