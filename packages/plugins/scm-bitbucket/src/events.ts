import { defineProtocolLiteral, defineProtocolObject, defineProtocolString, ScmHostingPullRequestLifecycleV1ProtocolSchema } from '@happier-dev/plugin-sdk/protocol';
import { QualifiedConnectedAccountRefSchema } from '@happier-dev/plugin-sdk/connected-accounts';
import { normalizeScmHostingRepositoryIdentity } from '@happier-dev/plugin-sdk/scm';
import { TriagePullRequestReviewTargetV1Schema } from '@happier-dev/triage-protocol/v1';
import { BITBUCKET_PLUGIN_ID, BITBUCKET_TRIAGE_CONTRIBUTION_ID, BITBUCKET_SCM_HOSTING_PROVIDER_LOCAL_ID } from './bitbucketContracts.js';
import { readBitbucketBracedUuid, readBitbucketRepositoryKey, readBitbucketEntryId,
  buildBitbucketCollisionScope, BITBUCKET_TRIAGE_DEPLOYMENT_BASE_URL_V1 } from './triage/identity.js';
import { BITBUCKET_PULL_REQUEST_KIND_ID } from './triage/source/descriptor.js';
import { buildBitbucketEntryLocator } from './triage/source/observations.js';

export const BITBUCKET_WEBHOOK_CONTRIBUTION_ID = 'bitbucket-events';
export const BITBUCKET_EVENT_LOCAL_ID = 'automation/pull-request-lifecycle-v1';
export const BitbucketEventRepositorySchema = defineProtocolObject({
  repositoryId: defineProtocolString({ minLength: 1 }), nameWithOwner: defineProtocolString({ minLength: 3 }),
}, { policy: 'closed' });
export const BitbucketEventSourceConfigSchema = defineProtocolObject({ v: defineProtocolLiteral(1),
  credentialRef: QualifiedConnectedAccountRefSchema, repository: BitbucketEventRepositorySchema,
}, { policy: 'closed' });
export const BitbucketEventSetupInputSchema = defineProtocolObject({ credentialRef: QualifiedConnectedAccountRefSchema,
  repository: defineProtocolString({ minLength: 3 }),
}, { policy: 'closed' });
const BitbucketLifecyclePayloadSchema = defineProtocolObject({ repository: BitbucketEventRepositorySchema,
  pullRequest: ScmHostingPullRequestLifecycleV1ProtocolSchema,
  reviewTarget: TriagePullRequestReviewTargetV1Schema,
}, { policy: 'closed' });
export const BITBUCKET_EVENT_CATALOG = [{ localId: BITBUCKET_EVENT_LOCAL_ID,
  title: 'Bitbucket pull request lifecycle',
  description: 'A pull request opened, received commits, merged or was declined. Bitbucket Cloud cannot reopen declined pull requests.',
  payloadSchema: BitbucketLifecyclePayloadSchema.jsonSchema,
}] as const;

export function bitbucketRepositoryEventSourceId(repositoryId: string): string {
  const uuid = readBitbucketBracedUuid(repositoryId);
  if (!uuid) throw new TypeError('bitbucket_payload_invalid');
  return `bitbucket:repository:${uuid.slice(1, -1).toLowerCase()}`;
}
function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('bitbucket_payload_invalid');
  return value as Readonly<Record<string, unknown>>;
}
function repository(value: unknown) {
  const row = record(value);
  const uuid = readBitbucketBracedUuid(row.uuid);
  const key = typeof row.full_name === 'string' ? readBitbucketRepositoryKey(row.full_name) : null;
  if (!uuid || !key) throw new TypeError('bitbucket_payload_invalid');
  return BitbucketEventRepositorySchema.parse({ repositoryId: uuid.toLowerCase(), nameWithOwner: key.repositoryKey });
}
function identity(name: string) {
  const result = normalizeScmHostingRepositoryIdentity({ kind: 'bitbucket', deployment: BITBUCKET_TRIAGE_DEPLOYMENT_BASE_URL_V1, repository: name });
  if (!result) throw new TypeError('bitbucket_payload_invalid');
  return result;
}

/** Native PR push, rather than generic updated, is the provider's code-change fact. */
export function normalizeBitbucketWebhookDelivery(input: Readonly<{ eventType?: string; providerDeliveryId: string;
  receivedAtMs: number; rawBody: Uint8Array }>) {
  const action = input.eventType === 'pullrequest:created' ? 'opened'
    : input.eventType === 'pullrequest:push' ? 'synchronize'
      : input.eventType === 'pullrequest:fulfilled' ? 'merged'
        : input.eventType === 'pullrequest:rejected' ? 'closed' : null;
  if (!action) return null;
  const body = record(JSON.parse(new TextDecoder().decode(input.rawBody)) as unknown);
  const target = repository(body.repository);
  const pr = record(body.pullrequest);
  if ((action === 'opened' || action === 'synchronize') && pr.state !== 'OPEN'
    || action === 'merged' && pr.state !== 'MERGED'
    || action === 'closed' && pr.state !== 'DECLINED') return null;
  const source = record(pr.source);
  const destination = record(pr.destination);
  const base = repository(destination.repository);
  if (base.repositoryId !== target.repositoryId || base.nameWithOwner !== target.nameWithOwner) throw new TypeError('bitbucket_payload_invalid');
  const head = source.repository == null ? null : repository(source.repository);
  const author = record(pr.author);
  const authorId = typeof author.account_id === 'string' && author.account_id.length > 0 ? author.account_id : readBitbucketBracedUuid(author.uuid);
  const entryId = readBitbucketEntryId(pr.id);
  if (!authorId || !entryId) throw new TypeError('bitbucket_payload_invalid');
  const number = Number(entryId);
  return { eventRef: { pluginId: BITBUCKET_PLUGIN_ID, localId: BITBUCKET_EVENT_LOCAL_ID },
    sourceInstanceId: bitbucketRepositoryEventSourceId(target.repositoryId), occurrenceId: input.providerDeliveryId,
    occurredAtMs: input.receivedAtMs,
    payload: BitbucketLifecyclePayloadSchema.parse({ repository: target, pullRequest: {
      id: entryId, number, action, headSha: record(source.commit).hash,
      headRef: record(source.branch).name, baseRef: record(destination.branch).name,
      baseRepository: identity(base.nameWithOwner), headRepository: head ? identity(head.nameWithOwner) : null,
      // Bitbucket's public nickname is display text, not an account login.
      author: { id: authorId, login: null, kind: 'unsupported' }, authorAssociation: 'unknown',
    }, reviewTarget: { entryRef: {
      source: { pluginId: BITBUCKET_PLUGIN_ID, localId: BITBUCKET_TRIAGE_CONTRIBUTION_ID },
      kindId: BITBUCKET_PULL_REQUEST_KIND_ID, collisionScope: buildBitbucketCollisionScope(target.repositoryId), entryId,
    }, lastKnownLocator: buildBitbucketEntryLocator({ webUrl: null, repository: { repositoryKey: target.nameWithOwner } }),
    comparisonSource: { kind: 'pullRequest', locator: { providerId: BITBUCKET_SCM_HOSTING_PROVIDER_LOCAL_ID,
      repository: target.nameWithOwner, number, headOid: record(source.commit).hash } },
    } }),
  };
}
