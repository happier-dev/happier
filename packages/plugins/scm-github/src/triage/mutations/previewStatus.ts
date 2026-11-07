import { computeCanonicalDomainSeparatedDigest } from '@happier-dev/plugin-sdk';
import { settleAtMostOnceProviderWrite } from '@happier-dev/triage-sources/runtime';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';

import { decodeGithubJsonResponse } from '../../observations/githubApiClient.js';
import { classifyGithubResponseFailure, classifyGithubTransportFailure, isGithubSuccessStatus,
  isGithubWriteResponseAmbiguous } from '../errors.js';
import { readGithubPullRequest, type GithubGetDependenciesV1 } from '../get.js';
import { readGithubRepositoryIdFromCollisionScope } from '../identity.js';
import { buildGithubApiUrl, type GithubRepositoryRouteV1 } from '../locator.js';
import { toTriageFailure } from '../mapping/protocol.js';
import { createGithubRepositoryReader } from '../repositories.js';
import { readValidatedGithubFollowUpPage } from '../scan/link.js';
import { GITHUB_MAX_PAGE_SIZE_V1, type GithubTriageEntryLocalRefV1 } from '../types.js';
import type { GithubPullRequestPreviewStatusInputV1, GithubPullRequestPreviewStatusResultV1 } from './contracts.js';

type Status = Readonly<{ id: string; context: string; state: string; description: string | null; targetUrl: string | null }>;
type StatusRead = Readonly<{ ok: true; status: Status | null }> | Readonly<{ ok: false; failure: TriageSourceFailureV1 }>;
type StatusDispatch = Readonly<{ kind: 'sent'; failure?: TriageSourceFailureV1 }>
  | Readonly<{ kind: 'rejected'; failure: TriageSourceFailureV1 }>;
type Publication = Pick<GithubPullRequestPreviewStatusInputV1,
  'serverId' | 'environmentId' | 'templateEnvironmentId' | 'targetLinkId' | 'deploymentId' | 'expectedHeadSha' | 'status' | 'targetUrl'>;

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function status(value: unknown): Status | null {
  if (!record(value) || typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id < 1
    || typeof value.context !== 'string' || typeof value.state !== 'string'
    || value.description !== null && typeof value.description !== 'string'
    || value.target_url !== null && typeof value.target_url !== 'string') return null;
  return { id: String(value.id), context: value.context, state: value.state,
    description: value.description, targetUrl: value.target_url };
}

/** GitHub contexts are case-insensitive; lowercase hex preserves the full canonical digest. */
function previewContext(templateEnvironmentId: string, templateTargetLinkId: string): string {
  const digest = computeCanonicalDomainSeparatedDigest('happier.github.preview-status.v1', [templateEnvironmentId, templateTargetLinkId]);
  return `happier/preview/${Buffer.from(digest, 'base64url').toString('hex')}`;
}

const FACTS = {
  pending: { state: 'pending', description: 'Preview deployment pending' },
  ready: { state: 'success', description: 'Preview ready' },
  failed: { state: 'failure', description: 'Preview deployment failed' },
  removed: { state: 'success', description: 'Preview removed' },
} as const;

/** The provider's newest-first collection is read only for this exact owned context. */
async function readLatestStatus(input: Readonly<{
  route: GithubRepositoryRouteV1; localRef: GithubTriageEntryLocalRefV1; sha: string; context: string;
}>, dependencies: GithubGetDependenciesV1): Promise<StatusRead> {
  let next: string | null = `${buildGithubApiUrl(['repos', input.route.owner, input.route.name, 'commits', input.sha, 'statuses'])}?per_page=${GITHUB_MAX_PAGE_SIZE_V1}`;
  while (next !== null) {
    dependencies.signal.throwIfAborted();
    const requestedUrl: string = next;
    let response;
    try { response = await dependencies.client.request({ url: requestedUrl }); }
    catch (error) { return { ok: false, failure: toTriageFailure(classifyGithubTransportFailure(error)) }; }
    if (!isGithubSuccessStatus(response.status)) return { ok: false,
      failure: toTriageFailure(classifyGithubResponseFailure(response, dependencies.now())) };
    let body: unknown;
    try { body = decodeGithubJsonResponse(response); }
    catch { return { ok: false, failure: { class: 'unsupportedContract', code: 'github_preview_status_envelope_invalid' } }; }
    if (!Array.isArray(body)) return { ok: false,
      failure: { class: 'unsupportedContract', code: 'github_preview_status_envelope_invalid' } };
    for (const value of body) {
      if (!record(value) || typeof value.context !== 'string' || value.context.toLowerCase() !== input.context) continue;
      const parsed = status(value);
      return parsed === null ? { ok: false,
        failure: { class: 'unsupportedContract', code: 'github_preview_status_envelope_invalid' } }
        : { ok: true, status: parsed };
    }
    const page = readValidatedGithubFollowUpPage(response.headers, requestedUrl,
      readGithubRepositoryIdFromCollisionScope(input.localRef.collisionScope));
    if (page.kind === 'invalid') return { ok: false,
      failure: { class: 'unsupportedContract', code: 'github_preview_status_link_invalid' } };
    next = page.kind === 'next' ? page.url : null;
  }
  return { ok: true, status: null };
}

/** One exact commit-status write. Deployment readiness and retry custody remain with their owners. */
export async function publishGithubPullRequestPreviewStatus(input: Publication & Readonly<{
  localRef: GithubTriageEntryLocalRefV1; route: GithubRepositoryRouteV1; templateTargetLinkId: string;
}>, dependencies: GithubGetDependenciesV1): Promise<GithubPullRequestPreviewStatusResultV1> {
  const repositories = createGithubRepositoryReader({ client: dependencies.client, now: dependencies.now });
  const current = await readGithubPullRequest(input.localRef, input.route, repositories, dependencies);
  if (current.observation.kind !== 'present' || current.facts === null) return { kind: 'failed',
    failure: current.observation.kind === 'unresolved' ? toTriageFailure(current.observation.failure)
      : { class: 'unknown', code: 'github_entry_not_observed' } };
  if (current.facts.headRevision !== input.expectedHeadSha) return { kind: 'refused', reason: 'head_advanced' };
  if (input.status !== 'removed' && current.facts.state !== 'open') return { kind: 'refused', reason: 'state_changed' };
  const context = previewContext(input.templateEnvironmentId, input.templateTargetLinkId);
  const read = () => readLatestStatus({ ...input, sha: input.expectedHeadSha, context }, dependencies);
  const before = await read();
  if (!before.ok) return { kind: 'failed', failure: before.failure };
  dependencies.signal.throwIfAborted();
  const fact = FACTS[input.status];
  const matches = (value: Status | null) => value !== null && value.context.toLowerCase() === context
    && value.state === fact.state && value.description === fact.description && value.targetUrl === input.targetUrl;
  const applied = (observed: Status): GithubPullRequestPreviewStatusResultV1 => ({ kind: 'applied', publication: {
    serverId: input.serverId, environmentId: input.environmentId, templateEnvironmentId: input.templateEnvironmentId,
    targetLinkId: input.targetLinkId, deploymentId: input.deploymentId, expectedHeadSha: input.expectedHeadSha,
    status: input.status, targetUrl: input.targetUrl, context, providerStatusId: observed.id,
  } });
  // D7 owns the provider head fact. Admit its exact value immediately before the write;
  // do not re-read deployment authority or invalidate an already admitted publication after sending.
  const latest = await readGithubPullRequest(input.localRef, input.route, repositories, dependencies);
  if (latest.facts?.headRevision !== input.expectedHeadSha) return { kind: 'refused', reason: 'head_advanced' };
  if (latest.facts.state !== current.facts.state) return { kind: 'refused', reason: 'state_changed' };
  // Explicit retry first observes the current owned fact; a matching status needs no duplicate write.
  if (before.status !== null && matches(before.status)) return applied(before.status);
  const settlement = await settleAtMostOnceProviderWrite<StatusDispatch, Status, TriageSourceFailureV1>({
    dispatch: async () => {
      try {
        const response = await dependencies.client.request({
          url: buildGithubApiUrl(['repos', input.route.owner, input.route.name, 'statuses', input.expectedHeadSha]),
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: new TextEncoder().encode(JSON.stringify({ ...fact, context, target_url: input.targetUrl })),
        });
        if (!isGithubSuccessStatus(response.status) && !isGithubWriteResponseAmbiguous(response)) {
          return { kind: 'rejected' as const, failure: toTriageFailure(classifyGithubResponseFailure(response, dependencies.now())) };
        }
        return { kind: 'sent' as const };
      } catch (error) {
        return { kind: 'sent' as const, failure: toTriageFailure(classifyGithubTransportFailure(error)) };
      }
    },
    mayHaveChanged: result => result.kind === 'sent',
    confirm: async () => {
      const after = await read();
      if (!after.ok) return { kind: 'uncertain' as const, failure: after.failure };
      if (after.status === null || !matches(after.status) || after.status.id === before.status?.id) return { kind: 'uncertain' as const };
      return { kind: 'applied' as const, observation: after.status };
    },
  });
  if (settlement.kind === 'settled') return settlement.result.kind === 'rejected'
    ? { kind: 'failed', failure: settlement.result.failure } : { kind: 'uncertain' };
  if (settlement.kind !== 'applied') return { kind: 'uncertain',
    ...('failure' in settlement && settlement.failure !== undefined ? { failure: settlement.failure } : {}) };
  return applied(settlement.observation);
}
