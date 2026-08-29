import type {
  AgentExternalSessionTakeoverContribution,
  AgentExternalSessionTakeoverLaunchPlan,
  AgentExternalSessionTakeoverResolveLaunchRequest,
} from '@happier-dev/plugin-sdk/sessions/external';
import { canonicalizePathSync } from '@happier-dev/plugin-sdk/fs';

import {
  buildPiAgentRuntimeDescriptorV1,
  readStrictCanonicalPiAgentRuntimeDescriptorV1,
} from '../../protocol/runtimeDescriptorV1.js';

type PiExternalSessionTakeoverIdentity = Pick<
  AgentExternalSessionTakeoverResolveLaunchRequest,
  'source' | 'remoteSessionId' | 'linkData'
>;

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function resolvePiExternalSessionTakeoverPlan(
  identity: PiExternalSessionTakeoverIdentity,
): AgentExternalSessionTakeoverLaunchPlan | null {
  const remoteSessionId = readNonEmptyString(identity.remoteSessionId);
  const agentDir = readNonEmptyString(identity.source.agentDir);
  const sessionFile = readNonEmptyString(identity.source.sessionFile);
  const descriptor = readStrictCanonicalPiAgentRuntimeDescriptorV1(
    identity.linkData.runtimeDescriptorV1,
  );
  // Exact Pi resume identity is the validated absolute sessionFile in the
  // canonical descriptor plus the agent dir. The request's optional
  // linkedDirectory is historical context and must never gate the launch;
  // the host alone enforces the request targetDirectory as the spawned cwd.
  if (
    identity.source.kind !== 'piAgentDir'
    || !remoteSessionId
    || !agentDir
    || !sessionFile
    || descriptor?.resumeStrategy !== 'sessionFileAbsolutePreferred'
    || descriptor.providerSessionId !== remoteSessionId
    || !descriptor.sessionFile
    || canonicalizePathSync(descriptor.sessionFile)
      !== canonicalizePathSync(sessionFile)
  ) {
    return null;
  }

  return Object.freeze({
    runtimeDescriptorV1: buildPiAgentRuntimeDescriptorV1({
      resumeStrategy: descriptor.resumeStrategy,
      providerSessionId: descriptor.providerSessionId,
      sessionFile: descriptor.sessionFile,
    }),
    environmentVariables: Object.freeze({
      PI_CODING_AGENT_DIR: agentDir,
    }),
  });
}

export const piExternalSessionTakeoverContribution:
  AgentExternalSessionTakeoverContribution = Object.freeze({
    async resolveLaunch(request) {
      if (request.signal.aborted) {
        return { ok: false, code: 'cancelled' };
      }
      if (Date.now() >= request.deadlineAtMs) {
        return { ok: false, code: 'timeout', retryable: true };
      }
      const plan = resolvePiExternalSessionTakeoverPlan(request);
      if (!plan) {
        return { ok: false, code: 'source_invalid' };
      }
      return { ok: true as const, value: plan };
    },
  });
