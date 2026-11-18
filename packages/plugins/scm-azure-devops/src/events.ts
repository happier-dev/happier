import { QualifiedConnectedAccountRefSchema } from '@happier-dev/plugin-sdk/connected-accounts';
import {
  ScmHostingPullRequestLifecycleV1ProtocolSchema,
  decodeBase64,
  defineProtocolLiteral,
  defineProtocolObject,
  defineProtocolString,
  defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import { normalizeScmHostingRepositoryIdentity } from '@happier-dev/plugin-sdk/scm';
import { TriagePullRequestReviewTargetV1Schema } from '@happier-dev/triage-protocol/v1';

import { AZURE_DEVOPS_PLUGIN_ID } from './azureDevopsContracts.js';
import { azureDevopsHostingProviderAdapter } from './detection/adapter.js';
import { stripAzureBranchRef } from './parsing/azureDevopsCoordinates.js';
import { decodeAzurePullRequestRow, decodeAzureRepositoryRow, readRecord, readString } from './triage/decode.js';
import { AZURE_DEVOPS_TRIAGE_CONTRIBUTION_ID, AZURE_DEVOPS_TRIAGE_KIND_ID } from './triage/descriptor.js';
import { buildAzureCollisionScope, buildAzureEntryId, isAzureGuid } from './triage/identity.js';
import { projectAzureTriageRoutingToken } from './triage/observation.js';
import { buildAzureRepositoryKey, normalizeAzureDevOpsBaseUrl } from './triage/origin.js';
import type { AzureDevOpsOrigin } from './triage/types.js';

export const AZURE_DEVOPS_WEBHOOK_CONTRIBUTION_ID = 'azure-devops-pull-request-events';
export const AZURE_DEVOPS_PULL_REQUEST_EVENT_ID = 'automation/pull-request-lifecycle-v1';
export const AZURE_DEVOPS_EVENT_SOURCE_CONTRACT_VERSION = 1;

const NonEmptyString = defineProtocolString({ minLength: 1 });
const AzureDevOpsPullRequestChangesSchema = defineProtocolUnion([
  defineProtocolLiteral('sourceBranch'),
  defineProtocolLiteral('status'),
]);
type AzureDevOpsPullRequestChanges = ReturnType<typeof AzureDevOpsPullRequestChangesSchema.parse>;

export const AzureDevOpsEventSetupInputSchema = defineProtocolObject({
  credentialRef: QualifiedConnectedAccountRefSchema,
  baseUrl: NonEmptyString,
  project: NonEmptyString,
  repository: NonEmptyString,
  changes: AzureDevOpsPullRequestChangesSchema,
}, { policy: 'closed' });

const AzureDevOpsEventRepositorySchema = defineProtocolObject({
  id: NonEmptyString,
  projectId: NonEmptyString,
  nameWithOwner: NonEmptyString,
  baseUrl: NonEmptyString,
}, { policy: 'closed' });

export const AzureDevOpsEventSourceConfigSchema = defineProtocolObject({
  v: defineProtocolLiteral(AZURE_DEVOPS_EVENT_SOURCE_CONTRACT_VERSION),
  credentialRef: QualifiedConnectedAccountRefSchema,
  repository: AzureDevOpsEventRepositorySchema,
  changes: AzureDevOpsPullRequestChangesSchema,
}, { policy: 'closed' });

export const AzureDevOpsPullRequestEventPayloadSchema = defineProtocolObject({
  repository: AzureDevOpsEventRepositorySchema,
  pullRequest: ScmHostingPullRequestLifecycleV1ProtocolSchema,
  reviewTarget: TriagePullRequestReviewTargetV1Schema,
}, { policy: 'closed' });

type AzureDevOpsEventRepository = ReturnType<typeof AzureDevOpsEventRepositorySchema.parse>;

export function readAzureDevOpsEventRepository(
  value: unknown,
  origin: AzureDevOpsOrigin,
): AzureDevOpsEventRepository | null {
  const repository = decodeAzureRepositoryRow(value);
  if (!repository) return null;
  return {
    id: repository.id,
    projectId: repository.projectId,
    nameWithOwner: buildAzureRepositoryKey({
      organizationOrCollection: origin.organizationOrCollection,
      forgeHostId: origin.forgeHostId,
      projectName: repository.projectName,
      repositoryName: repository.name,
    }),
    baseUrl: origin.baseUrl,
  };
}

export function buildAzureDevOpsEventSourceInstanceId(
  origin: AzureDevOpsOrigin,
  repositoryId: string,
  changes: AzureDevOpsPullRequestChanges,
): string | null {
  const repositoryScope = buildAzureCollisionScope({ origin, repositoryId });
  if (!repositoryScope) return null;
  const sourceInstanceId = `${repositoryScope}:${changes}`;
  // The existing webhook endpoint protocol accepts up to 128 ASCII characters.
  return sourceInstanceId.length <= 128 ? sourceInstanceId : null;
}

/** Azure filters update subtypes at the Service Hook subscription, before sending JSON. */
export function normalizeAzureDevOpsWebhookDelivery(rawBody: Uint8Array, sourceInstanceId: string) {
  const [provider, encodedBase, repositoryId, changes, extra] = sourceInstanceId.split(':');
  const filter = AzureDevOpsPullRequestChangesSchema.safeParse(changes);
  if (provider !== 'azure-devops' || !encodedBase || !isAzureGuid(repositoryId) || !filter.success || extra !== undefined) {
    throw new TypeError('azure-devops/webhook-source-invalid');
  }
  const origin = normalizeAzureDevOpsBaseUrl(new TextDecoder().decode(decodeBase64(encodedBase, 'base64url')));
  if (!origin.ok) throw new TypeError('azure-devops/webhook-source-invalid');

  const body = readRecord(JSON.parse(new TextDecoder().decode(rawBody)));
  if (!body) throw new TypeError('azure-devops/webhook-payload-invalid');
  if (body.publisherId !== 'tfs') return null;
  const eventType = body.eventType;
  if (eventType !== 'git.pullrequest.created' && eventType !== 'git.pullrequest.updated') return null;
  if (eventType === 'git.pullrequest.created' && filter.data === 'status') return null;

  const resource = readRecord(body.resource);
  const repository = readAzureDevOpsEventRepository(resource?.repository, origin.origin);
  if (!repository) throw new TypeError('azure-devops/webhook-repository-invalid');
  const collisionScope = buildAzureCollisionScope({ origin: origin.origin, repositoryId: repository.id });
  if (collisionScope === null || `${collisionScope}:${filter.data}` !== sourceInstanceId) return null;
  const routingToken = projectAzureTriageRoutingToken(repository.nameWithOwner);
  if (routingToken === null) throw new TypeError('azure-devops/webhook-repository-invalid');

  const row = decodeAzurePullRequestRow(resource);
  if (!row) throw new TypeError('azure-devops/webhook-payload-invalid');
  if (row.status !== 'active') return null;
  const createdDate = readString(body.createdDate);
  const occurredAt = createdDate === null ? NaN : Date.parse(createdDate);
  if (!isAzureGuid(body.id) || !Number.isSafeInteger(occurredAt) || occurredAt < 0) {
    throw new TypeError('azure-devops/webhook-occurrence-invalid');
  }

  const sourceProvider = row.sourceRepositoryCloneUrl === null ? null : azureDevopsHostingProviderAdapter.detectRemote({
    remoteName: null,
    remoteUrl: row.sourceRepositoryCloneUrl,
  });
  const entryId = buildAzureEntryId(row.pullRequestId);
  const headSha = row.lastMergeSourceCommitId?.toLowerCase();
  const action = eventType === 'git.pullrequest.created' ? 'opened'
    : filter.data === 'sourceBranch' ? 'synchronize' : 'reopened';
  return {
    eventRef: { pluginId: AZURE_DEVOPS_PLUGIN_ID, localId: AZURE_DEVOPS_PULL_REQUEST_EVENT_ID },
    occurrenceId: body.id.trim().toLowerCase(),
    occurredAt,
    payload: AzureDevOpsPullRequestEventPayloadSchema.parse({
      repository,
      pullRequest: {
        id: entryId,
        number: row.pullRequestId,
        action,
        headSha,
        headRef: stripAzureBranchRef(row.sourceRefName),
        baseRef: stripAzureBranchRef(row.targetRefName),
        baseRepository: { kind: 'azure-devops', deployment: repository.baseUrl, repository: repository.nameWithOwner },
        headRepository: sourceProvider === null ? null : normalizeScmHostingRepositoryIdentity({
          kind: sourceProvider.kind, deployment: sourceProvider.baseUrl, repository: sourceProvider.nameWithOwner,
        }),
        author: { id: row.createdBy?.id, login: row.createdBy?.uniqueName ?? null, kind: 'unsupported' },
        authorAssociation: 'unknown',
      },
      reviewTarget: {
        entryRef: {
          source: { pluginId: AZURE_DEVOPS_PLUGIN_ID, localId: AZURE_DEVOPS_TRIAGE_CONTRIBUTION_ID },
          kindId: AZURE_DEVOPS_TRIAGE_KIND_ID,
          collisionScope,
          entryId,
        },
        lastKnownLocator: { v: 1, routingToken },
        comparisonSource: { kind: 'pullRequest', locator: {
          providerId: 'azure-devops',
          repository: repository.nameWithOwner,
          number: row.pullRequestId,
          ...(row.lastMergeTargetCommitId === null ? {} : { baseOid: row.lastMergeTargetCommitId.toLowerCase() }),
          headOid: headSha,
        } },
      },
    }),
  };
}
