import type {
  AgentExternalSessionTakeoverContribution,
  AgentExternalSessionTakeoverResolveLaunchRequest,
  AgentExternalSessionTakeoverResolveLaunchResult,
} from '@happier-dev/plugin-sdk/sessions/external';

import { OH_MY_PI_SESSION_FILE_STORE_DESCRIPTOR_V1 } from '../../../sessionFileStoreDescriptor.js';
import {
  projectOhMyPiExternalSessionSource,
  resolveOhMyPiAgentDir,
} from './source.js';

function invocationFailure(
  request: AgentExternalSessionTakeoverResolveLaunchRequest,
): AgentExternalSessionTakeoverResolveLaunchResult | null {
  if (request.signal.aborted) {
    return {
      ok: false,
      code: 'cancelled',
      message: 'Oh My Pi external-session takeover launch resolution was cancelled.',
    };
  }
  if (Date.now() >= request.deadlineAtMs) {
    return {
      ok: false,
      code: 'timeout',
      message: 'Oh My Pi external-session takeover launch resolution timed out.',
    };
  }
  return null;
}

async function resolveLaunch(
  request: AgentExternalSessionTakeoverResolveLaunchRequest,
): Promise<AgentExternalSessionTakeoverResolveLaunchResult> {
  const stopped = invocationFailure(request);
  if (stopped) return stopped;
  if (request.source.kind !== 'ohMyPiAgentDir') {
    return {
      ok: false,
      code: 'source_invalid',
      message: 'Oh My Pi external-session takeover requires an ohMyPiAgentDir source.',
    };
  }
  const source = projectOhMyPiExternalSessionSource(request.source);
  if (!source) {
    return {
      ok: false,
      code: 'source_invalid',
      message: 'Oh My Pi external-session takeover requires an ohMyPiAgentDir source.',
    };
  }

  // The launch plan carries no cwd authority: the host enforces the request
  // targetDirectory as the spawned process cwd, and the session file identity
  // already travels on the source. The agent dir environment carrier is the
  // one launch fact Oh My Pi contributes.
  const agentDir = resolveOhMyPiAgentDir({
    source,
  });
  return {
    ok: true,
    value: {
      environmentVariables: {
        [OH_MY_PI_SESSION_FILE_STORE_DESCRIPTOR_V1.agentDirEnvVar]: agentDir,
      },
    },
  };
}

export const ohMyPiExternalSessionTakeoverContribution = Object.freeze({
  resolveLaunch,
}) satisfies AgentExternalSessionTakeoverContribution;
