import type {
  ConversationAuthenticatedObservationShellV1,
  ConversationNormalizedIngressV1,
  ConversationObservationV1,
} from '@happier-dev/channels-protocol/v1';
import type { JsonValue } from '@happier-dev/plugin-sdk';

/** Replay witnesses never replace the first admitted input or grant fresh access. */
export function ingressReplayShell(input: ConversationAuthenticatedObservationShellV1): Readonly<Record<string, JsonValue>> {
  const { label: _label, repositoryWriteAccess: _access, ...actor } = input.actor;
  const endpoint = {
    kind: input.endpoint.kind, audience: input.endpoint.audience, id: input.endpoint.id,
    ...(input.endpoint.parentId === undefined ? {} : { parentId: input.endpoint.parentId }),
    ...(input.endpoint.kind !== 'githubPullRequest' || input.endpoint.pullRequest === undefined
      ? {} : { pullRequest: input.endpoint.pullRequest }),
  };
  return { ...input, actor, endpoint };
}

function pullRequestReplayEvidence(update: ConversationObservationV1['pullRequestUpdate']): JsonValue {
  if (update === undefined) return null;
  const { label: _label, ...author } = update.event.author;
  return { event: { ...update.event, author } };
}

/** Provider Event payloads and PR heads are mutable enrichment, not occurrence identity. */
export function ingressReplayEvidence(input: ConversationNormalizedIngressV1): JsonValue {
  if (input.kind === 'routableNonAdmission') return { ...input, shell: ingressReplayShell(input.shell) };
  const { pullRequestUpdate, ...observation } = input.observation;
  return { kind: input.kind, observation: {
    ...ingressReplayShell(observation),
    ...(pullRequestUpdate === undefined ? {} : { pullRequestUpdate: pullRequestReplayEvidence(pullRequestUpdate) }),
  } };
}
