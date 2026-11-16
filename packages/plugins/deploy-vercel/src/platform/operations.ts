import { withActionFailureDiagnostic } from '@happier-dev/plugin-sdk/errors';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk/errors';
import type {
  DeploymentTargetDeployInputV1, DeploymentTargetUploadDeployInputV1, DeploymentTargetProviderIdentityV1,
  DeploymentTargetProviderEnvironmentV1, DeploymentTargetRepositoryAccessV1,
  DeploymentTargetRoleFailureV1, DeploymentTargetRoleResultV1,
} from '@happier-dev/plugin-sdk';
import type { HttpMethod, HttpResponse, HttpService } from '@happier-dev/plugin-sdk/http';

const origin = 'https://api.vercel.com';
export const githubAppGrantUrl = 'https://github.com/apps/vercel/installations/new';
type Repository = DeploymentTargetRepositoryAccessV1['repository'];
type VercelEnvironment = Exclude<DeploymentTargetProviderEnvironmentV1, { scriptName: string }>;
type ProjectCoordinates = Pick<DeploymentTargetProviderIdentityV1, 'providerAccountId' | 'providerResourceId'>;
type Selection = Readonly<{
  providerIdentity: ProjectCoordinates;
  providerEnvironment: DeploymentTargetProviderEnvironmentV1;
  repository: Repository;
  sourceMethod?: (DeploymentTargetDeployInputV1 | DeploymentTargetUploadDeployInputV1)['sourceMethod'];
}>;
type ObservationInput = Pick<Selection, 'providerIdentity'> & Readonly<{ providerDeploymentId?: string }>;
export type VercelPlatformContext = Readonly<{
  http: Pick<HttpService, 'request'>;
  signal: AbortSignal;
  now(): number;
}>;
export type VercelProjectPreparation = Readonly<{
  providerIdentity: DeploymentTargetProviderIdentityV1;
  providerEnvironment: VercelEnvironment;
  repositoryAccess?: DeploymentTargetRepositoryAccessV1;
  projectName: string;
  reviewNotice?: string;
  gitSource?: Readonly<{ type: 'github'; repoId: string }>;
}>;
type Outcome = DeploymentTargetRoleResultV1 | DeploymentTargetRoleFailureV1;
type Phase = DeploymentTargetRoleFailureV1['phase'];

function failure(code: DeploymentTargetRoleFailureV1['code'], phase: Phase, caught?: Readonly<{ error: unknown }>): DeploymentTargetRoleFailureV1 {
  const result: DeploymentTargetRoleFailureV1 = { v: 1, code, phase, retryable: false };
  return code === 'deployment_unavailable' ? withActionFailureDiagnostic(result, { phase: `deployment.vercel.${phase}`,
    causeKind: caught ? 'native_failure' : 'not_found', error: caught?.error }) : result;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/**
 * The one reader of a Vercel project's documented GitHub `link` (GET /v9/projects and
 * POST /v11/projects responses): it names the deployable repository only when it is the selected one.
 */
export function readVercelGitLink(link: unknown, repository: Repository): Readonly<{ repo: string; repoId: string }> | null {
  return record(link) && link.type === 'github' && text(link.org) && text(link.repo)
    && (text(link.repoId) || typeof link.repoId === 'number' && Number.isSafeInteger(link.repoId))
    && `${link.org}/${link.repo}`.toLowerCase() === repository.repository ? { repo: link.repo, repoId: String(link.repoId) } : null;
}

/** Options consume partial drafts; preparation consumes the admitted native-or-complete selection. */
export function readVercelProjectCoordinates(input: Readonly<{ providerIdentity: ProjectCoordinates }>
  | Readonly<{ providerAccountId: string; projectId: string }>): ProjectCoordinates;
export function readVercelProjectCoordinates(input: Readonly<Record<string, unknown>>)
  : Readonly<{ providerAccountId: unknown; providerResourceId: unknown }>;
export function readVercelProjectCoordinates(input: Readonly<Record<string, unknown>>) {
  const identity = record(input.providerIdentity) ? input.providerIdentity : undefined;
  return { providerAccountId: identity ? identity.providerAccountId : input.providerAccountId,
    providerResourceId: identity ? identity.providerResourceId : input.projectId };
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function body(response: HttpResponse): unknown {
  try { return JSON.parse(new TextDecoder().decode(response.body)); } catch { return null; }
}
function endpoint(path: string, accountId: string) {
  const url = new URL(path, origin);
  // Vercel's teamId query is a Team scope; personal projects use the token's User scope.
  if (accountId.startsWith('team_')) url.searchParams.set('teamId', accountId);
  return url.href;
}

async function send(context: VercelPlatformContext, url: string, method: HttpMethod,
  content?: Readonly<{ headers: Readonly<Record<string, string>>; body: Uint8Array }>, phase?: Phase | 'branch') {
  context.signal.throwIfAborted();
  const response = await context.http.request({ url, method, redirect: 'error',
    credentialBinding: { kind: 'connectedAccountPurpose', purpose: 'deploy.manage', origin, method,
      headerNames: ['authorization'] },
    ...content,
  }, { signal: context.signal });
  // A received response remains evidence even if cancellation arrives with it.
  const value = response.status < 200 || response.status >= 300 ? body(response) : null;
  if (record(value) && record(value.error)) {
    // Vercel owns repository access; its GitHub app is installed once outside Happier.
    const needsGitAccess = value.error.action === 'Install GitHub App' || value.error.code === 'repo_not_found';
    throw withActionFailureDiagnostic(new PluginError({ code: needsGitAccess ? 'needsGitAccess' : response.status === 401 || response.status === 403 ? 'deployment_access_denied'
      : response.status === 404 ? 'deployment_unavailable' : 'provider_request_failed', retryable: false,
      details: { ...(phase === undefined ? {} : { phase }),
        ...(needsGitAccess ? { reason: 'vercel_github_app_required', grantUrl: githubAppGrantUrl } : {}) },
      failureCause: { phase: phase === undefined ? 'deployment.provider' : `deployment.provider.${phase}`, errorClass: 'Error',
        errorCode: text(value.error.code) ? value.error.code : null, httpStatus: response.status } }), { phase: `deployment.vercel.provider.${phase ?? 'request'}`, causeKind: response.status === 404 ? 'not_found' : response.status === 401 || response.status === 403 ? 'access_denied' : 'native_failure' });
  }
  return response;
}
export { endpoint as vercelEndpoint, send as vercelRequest };
function rejected(response: HttpResponse, phase: Phase): DeploymentTargetRoleFailureV1 | null {
  if (response.status >= 200 && response.status < 300) return null;
  return failure(response.status === 401 || response.status === 403 ? 'deployment_access_denied'
    : response.status === 404 ? 'deployment_unavailable' : 'provider_request_failed', phase);
}

function scope(environment: VercelEnvironment): string {
  switch (environment.kind) {
    case 'production': return 'production';
    case 'preview': return environment.gitBranch === undefined ? 'preview' : `preview:${JSON.stringify(environment.gitBranch)}`;
    case 'custom': return `custom:${JSON.stringify(environment.id)}`;
  }
}

/**
 * Exact existing-project inspection; no link or receipt persistence occurs here.
 * Primary contract, checked 2026-10-30:
 * https://vercel.com/docs/rest-api/projects/find-a-project-by-id-or-name
 * The documented GitHub link identifies the provider repository. Other Git
 * products need their own characterized native mapping before use here.
 */
export async function prepareVercelProject(input: Selection, context: VercelPlatformContext)
  : Promise<VercelProjectPreparation | DeploymentTargetRoleFailureV1> {
  context.signal.throwIfAborted();
  let environment = input.providerEnvironment;
  if ('scriptName' in environment) return failure('unsupported_action', 'link');
  // Vercel's native GitHub integration does not support GitHub Enterprise Server
  // or other Git providers through this producer. Return the existing typed UI
  // refusal rather than a needsGitAccess result with no supported remedy.
  if (input.sourceMethod !== 'upload' && (input.repository.kind !== 'github' || input.repository.deployment !== 'https://github.com')) {
    return failure('unsupported_action', 'link');
  }
  let response: HttpResponse;
  try { response = await send(context, endpoint(`/v9/projects/${encodeURIComponent(input.providerIdentity.providerResourceId)}`,
    input.providerIdentity.providerAccountId), 'GET'); }
  catch (error) {
    if (isPluginError(error)) throw error;
    context.signal.throwIfAborted();
    return failure('deployment_unavailable', 'link', { error });
  }
  const denied = rejected(response, 'link');
  if (denied) return denied;
  const project = body(response);
  if (!record(project) || !text(project.id) || !text(project.accountId) || !text(project.name)) {
    return failure('provider_response_invalid', 'link');
  }
  if (project.id !== input.providerIdentity.providerResourceId || project.accountId !== input.providerIdentity.providerAccountId) {
    return failure('deployment_conflict', 'link');
  }
  const link = project.link;
  // The project's configured production branch cannot be reviewed as Preview.
  // Decide during Inspect, before either Git or uploaded-source work is admitted.
  if (environment.kind === 'preview' && environment.gitBranch && record(link)
    && environment.gitBranch === link.productionBranch) {
    throw new PluginError({ code: 'unsupported_action', retryable: false,
      message: `Preview branch "${environment.gitBranch}" is the Vercel project's production branch. Choose Production or a different Preview branch.`,
      details: { phase: 'link', reason: 'preview_branch_is_production', gitBranch: environment.gitBranch,
        productionBranch: environment.gitBranch } });
  }
  let reviewNotice: string | undefined;
  if (environment.kind === 'preview') {
    // Vercel assigns Production when no prior Production deployment exists.
    // A filtered existence read is enough; no history or pagination is needed.
    // https://github.com/vercel/vercel/blob/main/packages/cli/src/util/deploy/process-deployment.ts
    const url = new URL(endpoint('/v7/deployments', project.accountId));
    url.searchParams.set('projectId', project.id);
    url.searchParams.set('target', 'production');
    url.searchParams.set('limit', '1');
    let production: HttpResponse;
    try { production = await send(context, url.href, 'GET'); }
    catch (error) {
      if (isPluginError(error)) throw error;
      context.signal.throwIfAborted();
      return failure('deployment_unavailable', 'link', { error });
    }
    const deniedProduction = rejected(production, 'link');
    if (deniedProduction) return deniedProduction;
    const result = body(production);
    if (!record(result) || !Array.isArray(result.deployments)
      || result.deployments.some(deployment => !record(deployment) || !text(deployment.uid) || deployment.target !== 'production')) {
      return failure('provider_response_invalid', 'link');
    }
    if (result.deployments.length === 0) {
      environment = { kind: 'production' };
      reviewNotice = "Vercel will make this the project's first Production deployment.";
    }
  }
  const identity = { providerAccountId: project.accountId, providerResourceId: project.id, providerEnvironment: scope(environment) };
  // Upload is admitted against Happier's exact Source, independently of the provider's Git integration.
  if (input.sourceMethod === 'upload') {
    reviewNotice = [reviewNotice, 'Vercel builds uploaded source remotely; the controller only materializes and uploads the reviewed files.']
      .filter(Boolean).join(' ');
    return { providerIdentity: identity, providerEnvironment: environment, projectName: project.name, reviewNotice };
  }
  const linked = readVercelGitLink(link, input.repository);
  let ready = false;
  if (linked) {
    const url = new URL(endpoint('/v1/integrations/search-repo', project.accountId));
    url.searchParams.set('provider', 'github');
    // Vercel searches repository names; owner/repo can return an empty list.
    // Qualify the identity using the namespace and repository id below.
    url.searchParams.set('query', linked.repo);
    let access: HttpResponse;
    try { access = await send(context, url.href, 'GET'); }
    catch (error) {
      if (isPluginError(error)) throw error;
      context.signal.throwIfAborted();
      return failure('deployment_unavailable', 'link', { error });
    }
    const deniedAccess = rejected(access, 'link');
    if (deniedAccess) return deniedAccess;
    const result = body(access);
    if (!record(result)) return failure('provider_response_invalid', 'link');
    if (record(result.error) && result.error.code === 'installation_not_found') ready = false;
    else if (!Array.isArray(result.repos)) return failure('provider_response_invalid', 'link');
    else ready = result.repos.some(repo => record(repo) && String(repo.id) === linked.repoId
      && repo.provider === 'github' && text(repo.namespace) && text(repo.slug)
      && `${repo.namespace}/${repo.slug}`.toLowerCase() === input.repository.repository);
  }
  return { providerIdentity: identity,
    providerEnvironment: environment, projectName: project.name,
    ...(reviewNotice ? { reviewNotice } : {}),
    // Official installation entry: choose the GitHub account/organization and
    // repository there; a Vercel team id is not a GitHub installation scope.
    // https://vercel.com/docs/code-owners/getting-started#install-the-github-app-into-a-repository
    repositoryAccess: ready ? { status: 'ready', repository: input.repository }
      : { status: 'needsGitAccess', repository: input.repository,
        grantUrl: githubAppGrantUrl },
    ...(ready && linked ? { gitSource: { type: 'github' as const, repoId: linked.repoId } } : {}),
  };
}

function observation(response: HttpResponse, context: VercelPlatformContext, phase: Phase,
  expectedId?: string, expectedProject?: string): Outcome {
  if (phase === 'send' && response.status >= 500) return failure('outcome_unknown', phase);
  const denied = rejected(response, phase);
  if (denied) return denied;
  const value = body(response);
  if (!record(value) || !text(value.id)) return failure(phase === 'send' ? 'outcome_unknown' : 'provider_response_invalid', phase);
  if (expectedId !== undefined && value.id !== expectedId
    || expectedProject !== undefined && value.projectId !== undefined && value.projectId !== expectedProject) {
    return failure('provider_response_invalid', phase);
  }
  let state: DeploymentTargetRoleResultV1['state'];
  switch (value.readyState) {
    case 'QUEUED': state = 'queued'; break;
    case 'INITIALIZING': case 'BUILDING': state = 'running'; break;
    case 'READY': state = 'succeeded'; break;
    case 'ERROR': case 'BLOCKED': state = 'failed'; break;
    case 'CANCELED': state = 'cancelled'; break;
    default: state = 'outcome_unknown';
  }
  let url: string | undefined;
  if (text(value.url)) {
    try {
      const parsed = new URL(`https://${value.url}`);
      if (!parsed.username && !parsed.password && parsed.pathname === '/' && !parsed.search && !parsed.hash) url = parsed.origin;
    } catch { /* No URL is preferable to publishing malformed provider metadata. */ }
  }
  return { v: 1, state, providerDeploymentId: value.id, observedAtMs: context.now(), ...(url ? { urls: [url] } : {}) };
}

/** One finite exact-id read; the host operation/demand owner decides when to observe. */
export async function observeVercelDeployment(input: ObservationInput, context: VercelPlatformContext): Promise<Outcome> {
  context.signal.throwIfAborted();
  if (!input.providerDeploymentId) return failure('outcome_unknown', 'observe');
  try {
    return observation(await send(context, endpoint(`/v13/deployments/${encodeURIComponent(input.providerDeploymentId)}`,
      input.providerIdentity.providerAccountId), 'GET'), context, 'observe', input.providerDeploymentId);
  } catch (error) {
    if (isPluginError(error)) throw error;
    context.signal.throwIfAborted();
    return failure('deployment_unavailable', 'observe', { error });
  }
}

/**
 * https://vercel.com/docs/rest-api/deployments/create-a-new-deployment
 * POST v13 starts a remote build; acceptance is not successful settlement.
 * Retained ids recover by GET. Transport ambiguity never replays the POST.
 */
export async function deployVercelCommit(input: VercelProjectPreparation & Pick<DeploymentTargetDeployInputV1, 'sourceIntent'>
  & Readonly<{ providerDeploymentId?: string }>, context: VercelPlatformContext): Promise<Outcome> {
  context.signal.throwIfAborted();
  if (input.providerDeploymentId) return observeVercelDeployment(input, context);
  if (input.sourceIntent.kind !== 'repository') return failure('unsupported_action', 'source');
  // Connect/Check again owns repository inspection. Consume its admitted facts;
  // the provider request itself decides current write permissions.
  if (input.repositoryAccess?.status !== 'ready' || !input.gitSource) return failure('needsGitAccess', 'source');
  return createVercelDeployment(input, { gitSource: { ...input.gitSource,
    ref: input.providerEnvironment.kind === 'preview' && input.providerEnvironment.gitBranch
      ? input.providerEnvironment.gitBranch : input.sourceIntent.sha, sha: input.sourceIntent.sha } }, context);
}

export type VercelUploadedFile = Readonly<{ file: string; sha: string; size: number; mode: number }>;
type UploadSelection = Pick<VercelProjectPreparation, 'providerIdentity' | 'providerEnvironment' | 'projectName'>;

/** Raw bytes and file modes follow the REST upload contract and official Vercel client. */
export async function uploadVercelSourceFile(bytes: Uint8Array, sha: string,
  accountId: string, context: VercelPlatformContext): Promise<DeploymentTargetRoleFailureV1 | null> {
  try {
    return rejected(await send(context, endpoint('/v2/files', accountId), 'POST', {
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength), 'x-vercel-digest': sha },
      body: bytes,
    }), 'source');
  } catch (error) {
    if (isPluginError(error)) throw error;
    context.signal.throwIfAborted();
    return failure('provider_request_failed', 'source');
  }
}

/** The files arm starts a remote build and shares Git deployment normalization/recovery. */
export async function deployVercelFiles(input: UploadSelection & Readonly<{
  files: readonly VercelUploadedFile[]; sha: string;
}>, context: VercelPlatformContext): Promise<Outcome> {
  // commitRef preserves Vercel's branch-specific Preview environment selection
  // for non-Git uploads; it never asks Vercel to fetch or move the reviewed SHA.
  const branch = input.providerEnvironment.kind === 'preview' ? input.providerEnvironment.gitBranch : undefined;
  return createVercelDeployment(input, { files: input.files,
    gitMetadata: { commitSha: input.sha, ...(branch ? { commitRef: branch } : {}) } }, context);
}

async function createVercelDeployment(input: UploadSelection, source: Readonly<Record<string, unknown>>, context: VercelPlatformContext): Promise<Outcome> {
  const environment = input.providerEnvironment;
  const target = environment.kind === 'production' ? { target: 'production' }
    : environment.kind === 'custom' ? { customEnvironmentSlugOrId: environment.id } : {};
  try {
    // A project's first deployment otherwise needs explicit projectSettings (400 missing_project_settings).
    // Vercel's documented opt-in keeps its framework auto-detection, as the Vercel CLI does with --yes.
    const url = new URL(endpoint('/v13/deployments', input.providerIdentity.providerAccountId));
    url.searchParams.set('skipAutoDetectionConfirmation', '1');
    const response = await send(context, url.href, 'POST',
      { headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({
        name: input.projectName, project: input.providerIdentity.providerResourceId, ...target,
        ...source,
      })) });
    return observation(response, context, 'send', undefined, input.providerIdentity.providerResourceId);
  } catch (error) {
    if (isPluginError(error)) throw error;
    return failure('outcome_unknown', 'send');
  }
}

/**
 * https://vercel.com/docs/rest-api/deployments/cancel-a-deployment
 * PATCH v12 returns CANCELED, or 400 when already terminal. An exact read
 * reconciles that terminal response or response loss; no cancel retry occurs.
 */
export async function cancelVercelDeployment(input: ObservationInput, context: VercelPlatformContext): Promise<Outcome> {
  context.signal.throwIfAborted();
  if (!input.providerDeploymentId) return failure('outcome_unknown', 'cancel');
  let response: HttpResponse;
  try {
    response = await send(context, endpoint(`/v12/deployments/${encodeURIComponent(input.providerDeploymentId)}/cancel`,
      input.providerIdentity.providerAccountId), 'PATCH');
  } catch (error) {
    if (isPluginError(error)) {
      // Vercel's documented terminal-400 is reconciled by the existing exact read.
      if (error.data.failureCause?.httpStatus === 400) return observeVercelDeployment(input, context);
      throw error;
    }
    if (context.signal.aborted) return failure('outcome_unknown', 'cancel');
    return observeVercelDeployment(input, context);
  }
  if (response.status === 400) return observeVercelDeployment(input, context);
  return observation(response, context, 'cancel', input.providerDeploymentId);
}
