import type {
  AgentExternalSessionTakeoverContribution,
  AgentExternalSessionTakeoverResolveLaunchRequest,
  AgentExternalSessionTakeoverResolveLaunchResult,
} from '@happier-dev/plugin-sdk/experimental/sessions';

import {
  getOpenCodeExternalSessionVerifiedWorkingDirectory,
} from './candidates.js';

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
  if (request.source.kind !== 'opencodeServer') {
    return {
      ok: false,
      code: 'source_invalid',
      message: 'OpenCode external-session takeover requires an opencodeServer source.',
    };
  }

  const verifiedDirectory = await getOpenCodeExternalSessionVerifiedWorkingDirectory({
    source: request.source,
    providerSessionId: request.remoteSessionId,
    signal: request.signal,
    baseUrlAuthority: 'canonical',
  });
  const after = invocationFailure(request);
  if (after) return after;

  const sourceDirectory = typeof request.source.directory === 'string'
    ? request.source.directory.trim()
    : '';
  const directory = verifiedDirectory
    || sourceDirectory
    || request.linkedDirectory?.trim()
    || '';
  if (!directory) {
    return {
      ok: false,
      code: 'unavailable',
      message: 'OpenCode external-session takeover requires a working directory.',
    };
  }

  return {
    ok: true,
    value: {
      directory,
      backendModeHint: 'server',
    },
  };
}

export const openCodeExternalSessionTakeoverContribution = Object.freeze({
  resolveLaunch,
}) satisfies AgentExternalSessionTakeoverContribution;
