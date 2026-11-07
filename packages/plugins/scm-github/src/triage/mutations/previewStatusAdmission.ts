import type { GithubTriageInvocationContext } from '../invocation.js';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import { isPluginActionApprovalRequestCreated, type DeploymentsActionResultById } from '@happier-dev/plugin-sdk/actions';
import {
  ProtocolDeploymentPreviewProvenanceV1Schema, ProtocolDeploymentSourceIntentV1Schema,
  readDeploymentArtifactJsonBodyV1, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1,
  pluginJsonValuesEqual, readDeploymentDomainServingUrlV1, type DeploymentPreviewProvenanceV1,
} from '@happier-dev/plugin-sdk/protocol';
import { normalizeScmHostingRepositoryIdentity, sameScmHostingRepositoryIdentity } from '@happier-dev/plugin-sdk/scm';

import { admitGithubEntryInvocation } from '../admission.js';
import type { GithubAdmittedInvocationV1 } from '../admission.js';
import { GITHUB_TRIAGE_DEPLOYMENT_BASE_URL_V1 } from '../configuration.js';
import {
  GithubPullRequestPreviewStatusInputV1Schema,
  type GithubPullRequestPreviewStatusInputV1, type GithubPullRequestPreviewStatusResultV1,
} from './contracts.js';
import { publishGithubPullRequestPreviewStatus } from './previewStatus.js';

type Request = GithubPullRequestPreviewStatusInputV1;
type Refusal = Extract<GithubPullRequestPreviewStatusResultV1, { kind: 'refused' | 'failed' }>;
type Environment = Extract<DeploymentsActionResultById['deployments.environments.get'], { ok: true }>;
type ContentReference = Pick<Environment['environment'], 'contentArtifactId' | 'contentHeaderVersion' | 'contentBodyVersion'>;
type PreviewDeployment = Refusal | Readonly<{ kind: 'deployment'; environment: Environment['environment'];
  deployment: Extract<DeploymentsActionResultById['deployments.receipts.list'], { ok: true }>['items'][number];
  provenance: DeploymentPreviewProvenanceV1; servingSha: string; targetUrl: string | null;
  state: 'removed' | 'failed' | 'needsApproval' | 'ready' | 'deploying' }>;

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function classifyGithubPreviewReadFailure(code: string): TriageSourceFailureV1 {
  return { class: code.endsWith('access_denied') ? 'permission' : 'unknown', code };
}

function fail(code: string): Refusal {
  return { kind: 'failed', failure: classifyGithubPreviewReadFailure(code) };
}

function changed(): Refusal { return { kind: 'refused', reason: 'preview_context_changed' }; }

async function readEnvironment(environmentId: string, request: Pick<Request, 'serverId'>, context: GithubTriageInvocationContext) {
  const value = await context.services.actions.execute('deployments.environments.get', {
    serverId: request.serverId, environmentId,
  }, { signal: context.signal });
  if (isPluginActionApprovalRequestCreated(value)) return fail('deployment_unavailable');
  if (!value.ok) return fail(value.error);
  return value;
}

async function readArtifact(reference: ContentReference, kind: string, context: GithubTriageInvocationContext) {
  const value = await context.services.actions.execute('artifact.get', { artifactId: reference.contentArtifactId }, { signal: context.signal });
  return readDeploymentArtifactJsonBodyV1(reference,
    isPluginActionApprovalRequestCreated(value) ? null : value.artifact, kind);
}

function isEnvironment(value: Environment | Refusal): value is Environment { return 'ok' in value; }

/** One private receipt/provenance/Domain readiness owner for the read and publication Actions. */
export async function readGithubPreviewDeployment(request: Pick<Request, 'serverId' | 'environmentId'>,
  admitted: Extract<GithubAdmittedInvocationV1, { ok: true }>, context: GithubTriageInvocationContext): Promise<PreviewDeployment> {
  let child: Environment | Refusal;
  let receiptRaw;
  try {
    [child, receiptRaw] = await Promise.all([
      readEnvironment(request.environmentId, request, context),
      context.services.actions.execute('deployments.receipts.list', { serverId: request.serverId,
        environmentId: request.environmentId, limit: 1 }, { signal: context.signal }),
    ]);
  } catch { context.signal.throwIfAborted(); return fail('deployment_unavailable'); }
  if (!isEnvironment(child)) return child;
  if (isPluginActionApprovalRequestCreated(receiptRaw)) return fail('deployment_unavailable');
  if (!receiptRaw.ok) return fail(receiptRaw.error);
  const deployment = receiptRaw.items[0];
  if (!deployment) return fail('deployment_unavailable');
  const receipt = { deployment };
  const environment = child.environment;
  if (environment.id !== request.environmentId || environment.serverId !== request.serverId
    || environment.purpose !== 'preview' || environment.deletedAtMs !== undefined
    || !environment.previewTemplateEnvironmentId
    || receipt.deployment.environmentId !== environment.id
    || receipt.deployment.targetLinkId !== environment.runtimeTargetLinkId) return changed();
  const link = child.targetLinks.find(value => value.id === environment.runtimeTargetLinkId && value.environmentId === environment.id);
  if (!link || link.role !== 'runtime' || link.deletedAtMs !== undefined || link.detachedAtMs !== undefined) return changed();
  if (link.source.kind !== 'host' || link.source.id !== 'own-server' || link.targetKind !== 'ownServer')
    return { kind: 'refused', reason: 'provider_native_preview' };
  let template: Environment | Refusal;
  let sourceResult;
  let childBody;
  let receiptBody;
  try {
    [template, sourceResult, childBody, receiptBody] = await Promise.all([
      readEnvironment(environment.previewTemplateEnvironmentId, request, context),
      context.services.actions.execute('projects.sources.read', { serverId: request.serverId, sourceId: environment.projectSourceId }, { signal: context.signal }),
      readArtifact(environment, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, context),
      readArtifact(receipt.deployment, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, context),
    ]);
  } catch { context.signal.throwIfAborted(); return fail('deployment_content_unavailable'); }
  if (!isEnvironment(template)) return template;
  if (isPluginActionApprovalRequestCreated(sourceResult)) return fail('source_unavailable');
  if (!sourceResult.ok) return fail(sourceResult.error);
  if (!childBody.ok) return fail(childBody.error);
  if (!receiptBody.ok) return fail(receiptBody.error);
  if (!record(childBody.body) || !record(receiptBody.body)) return fail('deployment_content_unavailable');
  const provenance = ProtocolDeploymentPreviewProvenanceV1Schema.safeParse(childBody.body.previewProvenance);
  const sourceIntent = ProtocolDeploymentSourceIntentV1Schema.safeParse(receiptBody.body.sourceIntent);
  const source = sourceResult.source;
  const repository = source.repository && normalizeScmHostingRepositoryIdentity({ kind: source.repository.provider.kind,
    deployment: source.repository.provider.baseUrl, repository: source.repository.repository.nameWithOwner });
  const routeRepository = normalizeScmHostingRepositoryIdentity({ kind: 'github', deployment: GITHUB_TRIAGE_DEPLOYMENT_BASE_URL_V1,
    repository: `${admitted.route.owner}/${admitted.route.name}` });
  if (!provenance.success || !sourceIntent.success || sourceIntent.data.kind !== 'repository'
    || source.id !== environment.projectSourceId || source.owner === undefined || !pluginJsonValuesEqual(source.owner, environment.owner)
    || template.environment.id !== environment.previewTemplateEnvironmentId || template.environment.serverId !== request.serverId
    || template.environment.purpose !== 'standard' || template.environment.deletedAtMs !== undefined
    || template.environment.projectSourceId !== environment.projectSourceId
    || !pluginJsonValuesEqual(template.environment.owner, environment.owner)
    || provenance.data.templateEnvironmentId !== template.environment.id
    || provenance.data.runtimeTargetLinkId !== environment.previewTargetLinkId
    || provenance.data.pullRequestId !== environment.previewPullRequestId
    || provenance.data.pullRequestNumber !== Number(admitted.localRef.entryId)
    || !repository || !routeRepository || !sameScmHostingRepositoryIdentity(provenance.data.repository, repository)
    || !sameScmHostingRepositoryIdentity(repository, routeRepository)
    || sourceIntent.data.projectSourceId !== environment.projectSourceId
    || sourceIntent.data.pullRequestHead?.number !== provenance.data.pullRequestNumber) return changed();
  const templateLink = template.targetLinks.find(value => value.id === provenance.data.runtimeTargetLinkId);
  if (!templateLink || templateLink.environmentId !== template.environment.id || templateLink.role !== 'runtime'
    || templateLink.deletedAtMs !== undefined || templateLink.detachedAtMs !== undefined) return changed();
  if (templateLink.source.kind !== 'host' || templateLink.source.id !== 'own-server' || templateLink.targetKind !== 'ownServer')
    return { kind: 'refused', reason: 'provider_native_preview' };

  let targetUrl: string | null = null;
  if (deployment.operation !== 'teardown' && deployment.state === 'succeeded' && link.activeDeploymentId === deployment.id) {
    let cursor: string | undefined;
    try {
      do {
        const domains = await context.services.actions.execute('deployments.domains.list', {
          serverId: request.serverId, environmentId: request.environmentId, ...(cursor ? { cursor } : {}),
        }, { signal: context.signal });
        if (isPluginActionApprovalRequestCreated(domains)) return fail('deployment_unavailable');
        if (!domains.ok) return fail(domains.error);
        for (const domain of domains.domains) {
          if (domain.environmentId !== environment.id || domain.targetLinkId !== link.id || domain.state !== 'active'
            || domain.deletedAtMs !== undefined) continue;
          const content = await readArtifact(domain, 'deployment-domain.v1', context);
          if (content.ok) targetUrl = readDeploymentDomainServingUrlV1(content.body);
          if (targetUrl !== null) break;
        }
        cursor = domains.nextCursor ?? undefined;
      } while (targetUrl === null && cursor !== undefined);
    } catch { context.signal.throwIfAborted(); return fail('deployment_content_unavailable'); }
  }
  const state = deployment.operation === 'teardown' && deployment.state === 'succeeded' ? 'removed'
    : deployment.state === 'failed' || deployment.state === 'cancelled' ? 'failed'
    : deployment.state === 'waitingApproval' ? 'needsApproval'
    : deployment.state === 'succeeded' && targetUrl !== null ? 'ready' : 'deploying';
  return { kind: 'deployment' as const, environment, deployment, provenance: provenance.data,
    servingSha: sourceIntent.data.sha, state, targetUrl };
}

/** Caller text can assert an address, but only the shared private owner supplies it. */
export async function publishGithubPullRequestPreviewStatusAction(input: unknown, context: GithubTriageInvocationContext): Promise<GithubPullRequestPreviewStatusResultV1> {
  const parsed = GithubPullRequestPreviewStatusInputV1Schema.safeParse(input);
  if (!parsed.success) return fail('github_mutation_input_invalid');
  const request = parsed.data;
  if (request.status !== 'ready' && request.targetUrl !== null) return { kind: 'refused', reason: 'preview_url_unavailable' };
  const admitted = await admitGithubEntryInvocation({ ...request, admissibleKinds: ['pull-request'] }, context);
  if (!admitted.ok) return { kind: 'failed', failure: admitted.failure };
  const preview = await readGithubPreviewDeployment(request, admitted, context);
  if (preview.kind !== 'deployment') return preview;
  if (preview.environment.previewTemplateEnvironmentId !== request.templateEnvironmentId
    || preview.environment.runtimeTargetLinkId !== request.targetLinkId || preview.deployment.id !== request.deploymentId
    || preview.servingSha !== request.expectedHeadSha) return changed();
  if (request.status === 'ready' && preview.targetUrl === null) return { kind: 'refused', reason: 'preview_url_unavailable' };
  if (request.status === 'pending' ? !['queued', 'waitingApproval', 'running'].includes(preview.deployment.state)
    || preview.deployment.operation === 'teardown' : preview.state !== request.status) return changed();
  if (request.targetUrl !== null && request.targetUrl !== preview.targetUrl) return { kind: 'refused', reason: 'preview_url_unavailable' };
  return publishGithubPullRequestPreviewStatus({ ...request, targetUrl: request.status === 'ready' ? preview.targetUrl : null,
    localRef: admitted.localRef, route: admitted.route, templateTargetLinkId: preview.provenance.runtimeTargetLinkId },
  { client: admitted.client, now: Date.now, signal: admitted.signal });
}
