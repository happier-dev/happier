import type { GithubTriageInvocationContext } from '../invocation.js';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import { isPluginActionApprovalRequestCreated, type DeploymentsActionResultById } from '@happier-dev/plugin-sdk/actions';
import { deploymentInProgressStates } from '@happier-dev/plugin-sdk/events';
import {
  ProtocolDeploymentPreviewProvenanceV1Schema, ProtocolDeploymentSourceIntentV1Schema,
  readDeploymentArtifactJsonBodyV1, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1,
  pluginJsonValuesEqual, readDeploymentDomainServingUrlV1, type DeploymentPreviewProvenanceV1,
} from '@happier-dev/plugin-sdk/protocol';
import { normalizeScmHostingRepositoryIdentity, sameScmHostingRepositoryIdentity } from '@happier-dev/plugin-sdk/scm';

import { admitGithubEntryInvocation } from '../admission.js';
import type { GithubAdmittedInvocationV1 } from '../admission.js';
import { GITHUB_TRIAGE_DEPLOYMENT_BASE_URL_V1 } from '../configuration.js';
import { readGithubPreviewEnvironments } from '../previewEnvironments.js';
import { isGithubOwnServerPreviewTargetV1, projectGithubPreviewStateV1 } from '../previewProjection.js';
import { buildGithubEntryLocalRef } from '../identity.js';
import { parseGithubRoutingToken } from '../locator.js';
import { createGithubApiClient } from '../../observations/githubApiClient.js';
import { parseGithubRepositorySourceConfig } from '../../observations/githubProviderContracts.js';
import {
  GithubPullRequestPreviewStatusActionInputV1Schema,
  type GithubPullRequestPreviewStatusInputV1, type GithubPullRequestPreviewStatusResultV1,
} from './contracts.js';
import { publishGithubPullRequestPreviewStatus } from './previewStatus.js';

type Request = GithubPullRequestPreviewStatusInputV1;
type Refusal = Extract<GithubPullRequestPreviewStatusResultV1, { kind: 'refused' | 'failed' }>;
type Environment = Extract<DeploymentsActionResultById['deployments.environments.get'], { ok: true }>;
type ContentReference = Pick<Environment['environment'], 'contentArtifactId' | 'contentHeaderVersion' | 'contentBodyVersion'>;
type PreviewDeployment = (Refusal | Readonly<{ kind: 'deployment'; environment: Environment['environment'];
  deployment: Extract<DeploymentsActionResultById['deployments.receipts.list'], { ok: true }>['items'][number];
  provenance: DeploymentPreviewProvenanceV1; servingSha: string; targetUrl: string | null;
  state: ReturnType<typeof projectGithubPreviewStateV1> }>) & Pick<Environment, 'controller'>;

/** Publication consumes the receipt/readiness owner's fact, on every ingress. */
export function readGithubPreviewPublicationStatus(preview: Extract<PreviewDeployment, { kind: 'deployment' }>): Request['status'] | null {
  if (preview.state === 'ready' || preview.state === 'failed' || preview.state === 'removed') return preview.state;
  return preview.deployment.operation !== 'teardown'
    && (deploymentInProgressStates().includes(preview.deployment.state) || preview.deployment.state === 'succeeded') ? 'pending' : null;
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function classifyGithubPreviewReadFailure(fallbackCode: string, requestId?: string, cause?: unknown): TriageSourceFailureV1 {
  const code = isPluginError(cause) ? cause.code : fallbackCode;
  return { class: code.endsWith('access_denied') ? 'permission' : 'unknown', code,
    ...(requestId === undefined ? {} : { requestId }) };
}

function fail(code: string, requestId?: string, cause?: unknown): Refusal {
  return { kind: 'failed', failure: classifyGithubPreviewReadFailure(code, requestId, cause) };
}

function changed(): Refusal { return { kind: 'refused', reason: 'preview_context_changed' }; }

async function readEnvironment(environmentId: string, request: Pick<Request, 'serverId'>, context: GithubTriageInvocationContext) {
  const value = await context.services.actions.execute('deployments.environments.get', {
    serverId: request.serverId, environmentId,
  }, { signal: context.signal });
  if (isPluginActionApprovalRequestCreated(value)) return fail('deployment_unavailable', context.requestId);
  if (!value.ok) return fail(value.error, context.requestId);
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
  admitted: Extract<GithubAdmittedInvocationV1, { ok: true }>, context: GithubTriageInvocationContext,
  retainedChild?: Environment): Promise<PreviewDeployment> {
  let child: Environment | Refusal;
  let receiptRaw;
  try {
    [child, receiptRaw] = await Promise.all([
      retainedChild ?? readEnvironment(request.environmentId, request, context),
      context.services.actions.execute('deployments.receipts.list', { serverId: request.serverId,
        environmentId: request.environmentId, limit: 1 }, { signal: context.signal }),
    ]);
  } catch (error) { context.signal.throwIfAborted(); return fail('deployment_unavailable', context.requestId, error); }
  if (!isEnvironment(child)) return child;
  const controller = child.controller ? { controller: child.controller } : {};
  if (isPluginActionApprovalRequestCreated(receiptRaw)) return { ...fail('deployment_unavailable', context.requestId), ...controller };
  if (!receiptRaw.ok) return { ...fail(receiptRaw.error, context.requestId), ...controller };
  const deployment = receiptRaw.items[0];
  if (!deployment) return { ...fail('deployment_unavailable', context.requestId), ...controller };
  const receipt = { deployment };
  const environment = child.environment;
  // Cleanup tombstones the ordinary Environment before its Workflow publishes
  // removal. Its retained successful receipt is still the effect authority.
  const removed = deployment.operation === 'teardown' && deployment.state === 'succeeded';
  if (environment.id !== request.environmentId || environment.serverId !== request.serverId
    || environment.purpose !== 'preview' || !removed && environment.deletedAtMs !== undefined
    || !environment.previewTemplateEnvironmentId
    || receipt.deployment.environmentId !== environment.id
    || receipt.deployment.targetLinkId !== environment.runtimeTargetLinkId) return changed();
  const link = child.targetLinks.find(value => value.id === environment.runtimeTargetLinkId && value.environmentId === environment.id);
  if (!link || link.role !== 'runtime' || !removed && (link.deletedAtMs !== undefined || link.detachedAtMs !== undefined)) return changed();
  if (!isGithubOwnServerPreviewTargetV1(link))
    return { kind: 'refused', reason: 'provider_native_preview' };
  const { contentArtifactId } = deployment;
  if (contentArtifactId === null) return { ...fail('deployment_content_unavailable', context.requestId), ...controller };
  let template: Environment | Refusal;
  let sourceResult;
  let childBody;
  let receiptBody;
  try {
    [template, sourceResult, childBody, receiptBody] = await Promise.all([
      readEnvironment(environment.previewTemplateEnvironmentId, request, context),
      context.services.actions.execute('projects.sources.read', { serverId: request.serverId, sourceId: environment.projectSourceId }, { signal: context.signal }),
      readArtifact(environment, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, context),
      readArtifact({ ...deployment, contentArtifactId }, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, context),
    ]);
  } catch (error) { context.signal.throwIfAborted(); return fail('deployment_content_unavailable', context.requestId, error); }
  if (!isEnvironment(template)) return template;
  if (isPluginActionApprovalRequestCreated(sourceResult)) return fail('source_unavailable', context.requestId);
  if (!sourceResult.ok) return fail(sourceResult.error, context.requestId);
  if (!childBody.ok) return fail(childBody.error, context.requestId);
  if (!receiptBody.ok) return fail(receiptBody.error, context.requestId);
  if (!record(childBody.body) || !record(receiptBody.body)) return fail('deployment_content_unavailable', context.requestId);
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
  if (!isGithubOwnServerPreviewTargetV1(templateLink))
    return { kind: 'refused', reason: 'provider_native_preview' };

  let targetUrl: string | null = null;
  if (deployment.operation !== 'teardown' && deployment.state === 'succeeded' && link.activeDeploymentId === deployment.id) {
    let cursor: string | undefined;
    try {
      do {
        const domains = await context.services.actions.execute('deployments.domains.list', {
          serverId: request.serverId, environmentId: request.environmentId, ...(cursor ? { cursor } : {}),
        }, { signal: context.signal });
        if (isPluginActionApprovalRequestCreated(domains)) return fail('deployment_unavailable', context.requestId);
        if (!domains.ok) return fail(domains.error, context.requestId);
        for (const domain of domains.domains) {
          if (domain.environmentId !== environment.id || domain.targetLinkId !== link.id || domain.state !== 'active'
            || domain.deletedAtMs !== undefined) continue;
          const content = await readArtifact(domain, 'deployment-domain.v1', context);
          if (content.ok) targetUrl = readDeploymentDomainServingUrlV1(content.body);
          if (targetUrl !== null) break;
        }
        cursor = domains.nextCursor ?? undefined;
      } while (targetUrl === null && cursor !== undefined);
    } catch (error) { context.signal.throwIfAborted(); return fail('deployment_content_unavailable', context.requestId, error); }
  }
  const state = projectGithubPreviewStateV1(deployment, targetUrl);
  return { kind: 'deployment' as const, environment, deployment, provenance: provenance.data,
    servingSha: sourceIntent.data.sha, state, targetUrl, ...controller };
}

/** Caller text can assert an address, but only the shared private owner supplies it. */
export async function publishGithubPullRequestPreviewStatusAction(input: unknown, context: GithubTriageInvocationContext): Promise<GithubPullRequestPreviewStatusResultV1> {
  const parsed = GithubPullRequestPreviewStatusActionInputV1Schema.safeParse(input);
  if (!parsed.success) return fail('github_mutation_input_invalid', context.requestId);
  const request = parsed.data;
  if ('sourceConfig' in request) {
    const child = await readEnvironment(request.environmentId, request, context);
    if (!isEnvironment(child)) return child;
    let repository;
    try { repository = parseGithubRepositorySourceConfig(request.sourceConfig.repository); }
    catch { return fail('github_mutation_input_invalid', context.requestId); }
    const localRef = buildGithubEntryLocalRef({ kindId: 'pull-request', repositoryId: repository.repositoryId,
      nativeItemId: child.environment.previewPullRequestId });
    const route = parseGithubRoutingToken(repository.nameWithOwner);
    if (!localRef || !route) return changed();
    const admitted = { ok: true as const, localRef, route, entryNumber: localRef.entryId, kindId: 'pull-request' as const,
      client: await createGithubApiClient(context, request.sourceConfig.credentialRef), signal: context.signal };
    const preview = await readGithubPreviewDeployment(request, admitted, context, child);
    if (preview.kind !== 'deployment') return preview.kind === 'failed'
      ? { kind: preview.kind, failure: preview.failure } : { kind: preview.kind, reason: preview.reason };
    if (preview.provenance.templateEnvironmentId !== request.templateEnvironmentId || preview.deployment.id !== request.deploymentId) return changed();
    const status = readGithubPreviewPublicationStatus(preview);
    if (status === null) return changed();
    return publishAdmittedPreview({ ...request, targetLinkId: preview.environment.runtimeTargetLinkId!,
      expectedHeadSha: preview.servingSha, status, targetUrl: status === 'ready' ? preview.targetUrl : null }, preview, admitted, context);
  }
  if (request.status !== 'ready' && request.targetUrl !== null) return { kind: 'refused', reason: 'preview_url_unavailable' };
  const admitted = await admitGithubEntryInvocation({ ...request, admissibleKinds: ['pull-request'] }, context);
  if (!admitted.ok) return { kind: 'failed', failure: admitted.failure };
  const preview = await readGithubPreviewDeployment(request, admitted, context);
  if (preview.kind !== 'deployment') return preview.kind === 'failed'
    ? { kind: preview.kind, failure: preview.failure } : { kind: preview.kind, reason: preview.reason };
  return publishAdmittedPreview(request, preview, admitted, context);
}

async function publishAdmittedPreview(request: Pick<Request, 'serverId' | 'environmentId' | 'templateEnvironmentId' | 'targetLinkId'
  | 'deploymentId' | 'expectedHeadSha' | 'status' | 'targetUrl'>, preview: Extract<PreviewDeployment, { kind: 'deployment' }>,
  admitted: Extract<GithubAdmittedInvocationV1, { ok: true }>, context: GithubTriageInvocationContext): Promise<GithubPullRequestPreviewStatusResultV1> {
  const environments = await readGithubPreviewEnvironments(request.serverId, admitted.route, admitted.localRef.entryId, context);
  if (!environments.ok) return fail(environments.error, context.requestId);
  if (!environments.items.some(environment => environment.id === request.environmentId)) return changed();
  if (preview.environment.previewTemplateEnvironmentId !== request.templateEnvironmentId
    || preview.environment.runtimeTargetLinkId !== request.targetLinkId || preview.deployment.id !== request.deploymentId
    || preview.servingSha !== request.expectedHeadSha) return changed();
  if (request.status === 'ready' && preview.targetUrl === null) return { kind: 'refused', reason: 'preview_url_unavailable' };
  if (readGithubPreviewPublicationStatus(preview) !== request.status) return changed();
  if (request.targetUrl !== null && request.targetUrl !== preview.targetUrl) return { kind: 'refused', reason: 'preview_url_unavailable' };
  return publishGithubPullRequestPreviewStatus({ ...request, targetUrl: request.status === 'ready' ? preview.targetUrl : null,
    localRef: admitted.localRef, route: admitted.route, templateTargetLinkId: preview.provenance.runtimeTargetLinkId },
  { client: admitted.client, now: Date.now, signal: admitted.signal });
}
