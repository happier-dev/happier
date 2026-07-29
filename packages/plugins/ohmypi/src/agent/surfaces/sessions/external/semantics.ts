import type {
  AgentExternalSessionSource,
  AgentExternalSessionTakeoverContribution,
  AgentExternalSessionTakeoverResolveLaunchRequest,
  AgentExternalSessionTakeoverResolveLaunchResult,
} from '@happier-dev/plugin-sdk/experimental/sessions';

import { OH_MY_PI_SESSION_FILE_STORE_DESCRIPTOR_V1 } from '../../../sessionFileStoreDescriptor.js';
import { readOhMyPiSessionSnapshot } from '../../../transcripts/snapshot.js';
import { resolveOhMyPiSessionFile } from './files.js';
import { resolveOhMyPiAgentDir } from './source.js';

type SessionLookupParams = Readonly<{
  source: AgentExternalSessionSource;
  env?: NodeJS.ProcessEnv;
  remoteSessionId: string;
  sessionFilePath?: string | null;
}>;

async function resolveSessionFile(params: SessionLookupParams) {
  return await resolveOhMyPiSessionFile({
    source: params.source,
    env: params.env,
    remoteSessionId: params.remoteSessionId,
    sessionFilePath: params.sessionFilePath,
  });
}

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

function readSessionFilePath(
  linkData: Readonly<Record<string, unknown>>,
): string | null {
  const value = linkData.sessionFilePath;
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
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

  try {
    const linkedDirectory = request.linkedDirectory?.trim() ?? '';
    let directory = linkedDirectory;
    if (!directory) {
      const resolved = await resolveSessionFile({
        source: request.source,
        remoteSessionId: request.remoteSessionId,
        sessionFilePath: readSessionFilePath(request.linkData),
      });
      const afterResolve = invocationFailure(request);
      if (afterResolve) return afterResolve;
      if (resolved) {
        directory = (
          await readOhMyPiSessionSnapshot({
            sessionFilePath: resolved.filePath,
            sessionId: request.remoteSessionId,
          })
        ).workingDirectory?.trim() ?? '';
      }
      const afterSnapshot = invocationFailure(request);
      if (afterSnapshot) return afterSnapshot;
    }
    if (!directory) {
      return {
        ok: false,
        code: 'unavailable',
        message: 'Oh My Pi external-session takeover requires a working directory.',
      };
    }

    const agentDir = resolveOhMyPiAgentDir({
      source: request.source,
    });
    return {
      ok: true,
      value: {
      directory,
      environmentVariables: {
        [OH_MY_PI_SESSION_FILE_STORE_DESCRIPTOR_V1.agentDirEnvVar]: agentDir,
      },
      },
    };
  } catch (error) {
    const after = invocationFailure(request);
    if (after) return after;
    return {
      ok: false,
      code: 'source_unreachable',
      message: error instanceof Error
        ? error.message
        : 'Oh My Pi external-session source could not be read.',
      retryable: true,
    };
  }
}

export const ohMyPiExternalSessionTakeoverContribution = Object.freeze({
  resolveLaunch,
}) satisfies AgentExternalSessionTakeoverContribution;
