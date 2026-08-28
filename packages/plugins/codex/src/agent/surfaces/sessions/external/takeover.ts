import type {
  AgentExternalSessionSource,
  AgentExternalSessionTakeoverContribution,
  AgentExternalSessionTakeoverLaunchPlan,
  AgentExternalSessionTakeoverResolveLaunchRequest,
} from '@happier-dev/plugin-sdk/sessions/external';

import {
  buildCodexAgentRuntimeDescriptorV1,
  normalizeCodexBackendMode,
  readCanonicalCodexAgentRuntimeDescriptorV1,
} from '../../../../protocol/runtimeDescriptorV1.js';

type CodexExternalSessionTakeoverIdentity =
  Pick<
    AgentExternalSessionTakeoverResolveLaunchRequest,
    'source' | 'remoteSessionId' | 'linkData' | 'linkedDirectory'
  >;

type CodexTakeoverSource = Readonly<{
  home: 'user' | 'connectedService';
  homePath: string;
  connectedServiceId: string | null;
  connectedServiceProfileId: string | null;
  connectedServiceGroupId: string | null;
}>;

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function readCodexSource(source: AgentExternalSessionSource): CodexTakeoverSource | null {
  if (source.kind !== 'codexHome' || (source.home !== 'user' && source.home !== 'connectedService')) {
    return null;
  }
  const homePath = readNonEmptyString(source.homePath);
  if (!homePath) return null;
  return {
    home: source.home,
    homePath,
    connectedServiceId: readNonEmptyString(source.connectedServiceId),
    connectedServiceProfileId: readNonEmptyString(source.connectedServiceProfileId),
    connectedServiceGroupId: readNonEmptyString(source.connectedServiceGroupId),
  };
}

function sourcesMatch(left: CodexTakeoverSource, right: CodexTakeoverSource): boolean {
  return left.home === right.home
    && left.homePath === right.homePath
    && left.connectedServiceId === right.connectedServiceId
    && left.connectedServiceProfileId === right.connectedServiceProfileId
    && left.connectedServiceGroupId === right.connectedServiceGroupId;
}

export function resolveCodexExternalSessionTakeoverPlan(
  identity: CodexExternalSessionTakeoverIdentity,
): AgentExternalSessionTakeoverLaunchPlan | null {
  const remoteSessionId = readNonEmptyString(identity.remoteSessionId);
  const directory = readNonEmptyString(identity.linkedDirectory);
  const source = readCodexSource(identity.source);
  const linkedSourceValue = identity.linkData.source;
  const linkedSource = linkedSourceValue && typeof linkedSourceValue === 'object' && !Array.isArray(linkedSourceValue)
    ? readCodexSource(linkedSourceValue as AgentExternalSessionSource)
    : null;
  if (!remoteSessionId || !directory || !source || !linkedSource || !sourcesMatch(source, linkedSource)) {
    return null;
  }

  const hasRuntimeDescriptor = Object.hasOwn(identity.linkData, 'runtimeDescriptorV1');
  const runtimeDescriptor = readCanonicalCodexAgentRuntimeDescriptorV1(
    identity.linkData.runtimeDescriptorV1,
  );
  if (hasRuntimeDescriptor && !runtimeDescriptor) return null;
  if (
    runtimeDescriptor?.providerSessionId
    && runtimeDescriptor.providerSessionId !== remoteSessionId
  ) {
    return null;
  }
  if (
    runtimeDescriptor?.home
    && (
      runtimeDescriptor.home !== source.home
      || (runtimeDescriptor.homePath !== null && runtimeDescriptor.homePath !== source.homePath)
      || (
        runtimeDescriptor.connectedServiceId !== null
        && runtimeDescriptor.connectedServiceId !== source.connectedServiceId
      )
      || (
        runtimeDescriptor.connectedServiceProfileId !== null
        && runtimeDescriptor.connectedServiceProfileId !== source.connectedServiceProfileId
      )
      || (
        runtimeDescriptor.connectedServiceGroupId !== null
        && runtimeDescriptor.connectedServiceGroupId !== source.connectedServiceGroupId
      )
    )
  ) {
    return null;
  }

  const hasLinkMode = Object.hasOwn(identity.linkData, 'codexBackendMode');
  const linkMode = normalizeCodexBackendMode(identity.linkData.codexBackendMode);
  if (hasLinkMode && !linkMode) return null;
  if (runtimeDescriptor?.backendMode && linkMode && runtimeDescriptor.backendMode !== linkMode) {
    return null;
  }
  const backendMode = runtimeDescriptor?.backendMode ?? linkMode;

  return Object.freeze({
    directory,
    ...(backendMode ? { backendModeHint: backendMode } : {}),
    ...(backendMode
      ? {
          runtimeDescriptorV1: buildCodexAgentRuntimeDescriptorV1({
            backendMode,
            providerSessionId: remoteSessionId,
            home: source.home,
            homePath: source.homePath,
            connectedServiceId: source.connectedServiceId,
            connectedServiceProfileId: source.connectedServiceProfileId,
            connectedServiceGroupId: source.connectedServiceGroupId,
          }),
        }
      : {}),
    environmentVariables: Object.freeze({
      CODEX_HOME: source.homePath,
    }),
  });
}

export const codexExternalSessionTakeoverContribution:
  AgentExternalSessionTakeoverContribution = Object.freeze({
    resolveLaunch(request) {
      if (request.signal.aborted) {
        return { ok: false, code: 'cancelled' };
      }
      if (Date.now() >= request.deadlineAtMs) {
        return { ok: false, code: 'timeout', retryable: true };
      }
      if (!readNonEmptyString(request.linkedDirectory)) {
        return { ok: false, code: 'unavailable' };
      }
      const plan = resolveCodexExternalSessionTakeoverPlan(request);
      return plan
        ? { ok: true, value: plan }
        : { ok: false, code: 'source_invalid' };
    },
  });
