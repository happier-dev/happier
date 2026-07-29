import { createHash } from 'node:crypto';

import type {
  ExternalSessionsAgentId,
  ExternalSessionsSource,
} from '@happier-dev/protocol';

export type ExternalSessionTagLookupCandidate = Readonly<
  | {
      kind: 'canonical' | 'released-source-key';
      tag: string;
      expectedSource: ExternalSessionsSource;
    }
  | {
      kind: 'codex-connected-service-predecessor';
      tag: string;
      expectedSource: ExternalSessionsSource;
      expectedConnectedServiceGroupId: string;
    }
>;

function normalizedNonEmptyString(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized.length > 0 ? normalized : null;
}

function tagForSourceKey(
  params: Readonly<{
    machineId: string;
    agentId: ExternalSessionsAgentId;
    remoteSessionId: string;
  }>,
  sourceKey: string,
): string {
  const fingerprint =
    `${params.machineId}|${params.agentId}|${params.remoteSessionId}|${sourceKey}`;
  return `direct:v1:${
    createHash('sha256').update(fingerprint, 'utf8').digest('hex')
  }`;
}

function resolveCodexConnectedServicePredecessor(
  params: Readonly<{
    machineId: string;
    agentId: ExternalSessionsAgentId;
    remoteSessionId: string;
    source: ExternalSessionsSource;
  }>,
): ExternalSessionTagLookupCandidate | null {
  if (
    params.agentId !== 'codex'
    || params.source.kind !== 'codexHome'
    || params.source.home !== 'connectedService'
  ) {
    return null;
  }
  const expectedConnectedServiceGroupId =
    normalizedNonEmptyString(params.source.connectedServiceGroupId);
  if (!expectedConnectedServiceGroupId) return null;

  const connectedServiceId =
    normalizedNonEmptyString(params.source.connectedServiceId) ?? '';
  const connectedServiceProfileId =
    normalizedNonEmptyString(params.source.connectedServiceProfileId) ?? '';
  const homePath = normalizedNonEmptyString(params.source.homePath) ?? '';
  const sourceKey =
    `codexHome:connectedService:${connectedServiceId}:`
    + `${connectedServiceProfileId}:${homePath}`;
  return {
    kind: 'codex-connected-service-predecessor',
    tag: tagForSourceKey(params, sourceKey),
    expectedSource: params.source,
    expectedConnectedServiceGroupId,
  };
}

export function resolveExternalSessionTagLookupCandidates(
  params: Readonly<{
    machineId: string;
    agentId: ExternalSessionsAgentId;
    remoteSessionId: string;
    source: ExternalSessionsSource;
    releasedPersistedSource: ExternalSessionsSource;
    sourceKey: string;
    releasedSourceKeys: readonly [string, ...string[]];
  }>,
): readonly [
  ExternalSessionTagLookupCandidate,
  ...ExternalSessionTagLookupCandidate[],
] {
  const candidates: ExternalSessionTagLookupCandidate[] = [{
    kind: 'canonical',
    tag: tagForSourceKey(params, params.sourceKey),
    expectedSource: params.source,
  }];

  // Stable cli-v0.2.1 and preview cli-v0.2.2 writers hashed the caller source
  // before the public Agent contribution normalized it. New writes use only
  // the canonical tag above; these proven keys remain exact read aliases.
  for (const sourceKey of params.releasedSourceKeys) {
    const tag = tagForSourceKey(params, sourceKey);
    if (candidates.some((candidate) => candidate.tag === tag)) continue;
    candidates.push({
      kind: 'released-source-key',
      tag,
      expectedSource: params.releasedPersistedSource,
    });
  }

  const predecessor = resolveCodexConnectedServicePredecessor(params);
  if (
    predecessor
    && !candidates.some((candidate) => candidate.tag === predecessor.tag)
  ) {
    candidates.push(predecessor);
  }

  if (candidates.length > 4) {
    throw new Error('External-session tag lookup exceeds the wire limit');
  }
  return candidates as [
    ExternalSessionTagLookupCandidate,
    ...ExternalSessionTagLookupCandidate[],
  ];
}
