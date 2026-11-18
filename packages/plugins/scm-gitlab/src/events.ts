import { defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { QualifiedConnectedAccountRefSchema } from '@happier-dev/plugin-sdk/connected-accounts';
import { GITLAB_PLUGIN_ID } from './triage/contribution.js';
import { normalizeGitlabConfiguredBaseUrl } from './triage/origin.js';
import { buildGitlabProjectCollisionScope } from './triage/identity.js';

export const GITLAB_WEBHOOK_CONTRIBUTION_ID = 'gitlab-events';
export const GITLAB_EVENT_LOCAL_IDS = { push: 'automation/repository-pushed-v1', merge: 'automation/pull-request-merged-v1' } as const;
const Identifier = defineProtocolString({ minLength: 1, pattern: '^[1-9][0-9]*$' });
const Sha = defineProtocolString({ pattern: '^[a-fA-F0-9]{40}$' });
export const GitlabEventRepositorySchema = defineProtocolObject({ repositoryId: Identifier,
  nameWithOwner: defineProtocolString({ minLength: 3 }), baseUrl: defineProtocolString({ minLength: 1 }),
}, { policy: 'closed' });
export const GitlabEventSourceConfigSchema = defineProtocolObject({ v: defineProtocolLiteral(1),
  credentialRef: QualifiedConnectedAccountRefSchema, repository: GitlabEventRepositorySchema,
}, { policy: 'closed' });
export const GitlabEventSetupInputSchema = defineProtocolObject({ credentialRef: QualifiedConnectedAccountRefSchema,
  baseUrl: defineProtocolString({ minLength: 1 }), repository: defineProtocolString({ minLength: 3 }),
}, { policy: 'closed' });
const GitlabPushPayloadSchema = defineProtocolObject({ repository: GitlabEventRepositorySchema,
  ref: defineProtocolString({ minLength: 1 }), before: Sha, after: Sha,
}, { policy: 'closed' });
const GitlabMergePayloadSchema = defineProtocolObject({ repository: GitlabEventRepositorySchema,
  pullRequest: defineProtocolObject({ id: Identifier, number: defineProtocolNumber({ integer: true, minimum: 1 }),
    mergeCommitSha: Sha, authorAssociation: defineProtocolLiteral('unknown') }, { policy: 'closed' }),
}, { policy: 'closed' });
export const GITLAB_EVENT_CATALOG = [
  { localId: GITLAB_EVENT_LOCAL_IDS.push, title: 'GitLab repository pushed',
    description: 'A branch received a push.', payloadSchema: GitlabPushPayloadSchema.jsonSchema },
  { localId: GITLAB_EVENT_LOCAL_IDS.merge, title: 'GitLab merge request merged',
    description: 'A merge request was merged.', payloadSchema: GitlabMergePayloadSchema.jsonSchema },
] as const;

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('gitlab_payload_invalid');
  return value as Readonly<Record<string, unknown>>;
}
function positiveId(value: unknown): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new TypeError('gitlab_payload_invalid');
  return String(value);
}

/** Provider codec only. Authentication and durable delivery belong to host ingress. */
export function normalizeGitlabWebhookDelivery(input: Readonly<{ eventType?: string; providerDeliveryId: string;
  receivedAtMs: number; rawBody: Uint8Array; baseUrl: string }>) {
  if (input.eventType !== 'Push Hook' && input.eventType !== 'Merge Request Hook') return null;
  const body = record(JSON.parse(new TextDecoder().decode(input.rawBody)) as unknown);
  const project = record(body.project);
  const origin = normalizeGitlabConfiguredBaseUrl(input.baseUrl);
  if (!origin) throw new TypeError('gitlab_payload_invalid');
  const repository = GitlabEventRepositorySchema.parse({ repositoryId: positiveId(project.id),
    nameWithOwner: project.path_with_namespace, baseUrl: origin.normalized });
  const sourceInstanceId = buildGitlabProjectCollisionScope(origin, repository.repositoryId);
  if (input.eventType === 'Push Hook') {
    return { eventRef: { pluginId: GITLAB_PLUGIN_ID, localId: GITLAB_EVENT_LOCAL_IDS.push }, sourceInstanceId,
      occurrenceId: input.providerDeliveryId, occurredAtMs: input.receivedAtMs,
      payload: GitlabPushPayloadSchema.parse({ repository, ref: body.ref, before: body.before, after: body.after }) };
  }
  const mr = record(body.object_attributes);
  if (mr.action !== 'merge' || mr.state !== 'merged') return null;
  if (positiveId(mr.target_project_id) !== repository.repositoryId) throw new TypeError('gitlab_payload_invalid');
  return { eventRef: { pluginId: GITLAB_PLUGIN_ID, localId: GITLAB_EVENT_LOCAL_IDS.merge }, sourceInstanceId,
    occurrenceId: input.providerDeliveryId, occurredAtMs: input.receivedAtMs,
    payload: GitlabMergePayloadSchema.parse({ repository,
      pullRequest: { id: positiveId(mr.id), number: Number(positiveId(mr.iid)), mergeCommitSha: mr.merge_commit_sha,
        authorAssociation: 'unknown' } }) };
}
