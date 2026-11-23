import { isPluginError, PluginError, projectActionFailureCauseV1, withActionFailureDiagnostic } from '@happier-dev/plugin-sdk/errors';
import { DeploymentTargetRoleInputProtocolSchemasV1 as inputs,
  DeploymentTargetLinkProviderContentV1ProtocolSchema as output, type DeploymentTargetCreateInputV1, type DeploymentTargetRepositoryAccessV1, type JsonValue } from '@happier-dev/plugin-sdk';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import type { PluginAccountActionContext, PluginActionDeclaration } from '@happier-dev/plugin-sdk/actions';
import { request, type DeploymentContext } from './deploymentHttp.js';
import { isCloudflareTokenRefusal, isObject } from '../connectedAccounts/probe.js';
import { workersBuildsEditPermission } from '../connectedAccounts/permissions.js';
import { resolveWorkerTag, workerEnvironmentKey } from './workers.js';
import { cloudflareGitGrantUrl, cloudflareGitRepository, pagesCreateSource, pagesRepositoryAccess } from './pagesSource.js';
import { cloudflareReviewNotice } from './reviewNotice.js';
import { cloudflareRoleSchema, type CloudflareRoleInput } from './targetSelection.js';

type CreateInput = CloudflareRoleInput<DeploymentTargetCreateInputV1>;
type ProductionBranchOutcome = NonNullable<NonNullable<ReturnType<typeof output.parse>['preparedNative']>['productionBranchOutcome']>;
type AccountAction = Extract<PluginActionDeclaration, { execution: { target: 'account' } }> & {
  run(value: JsonValue, context: PluginAccountActionContext): Promise<JsonValue>;
};
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function unknownOutcome(): never { throw new PluginError({ code: 'outcome_unknown', retryable: false, details: { phase: 'link' } }); }

type NativeReply = Awaited<ReturnType<typeof request>>;
function refuseNative(reply: Extract<NativeReply, { code: string }>): never {
  throw withActionFailureDiagnostic(new PluginError({ code: reply.code, retryable: reply.retryable, details: { phase: reply.phase } }),
    { phase: `deployment.cloudflare.${reply.phase}`, causeKind: 'native_failure', error: reply });
}
function acknowledged(reply: NativeReply): unknown {
  return 'code' in reply ? refuseNative(reply) : reply.value;
}

/** The v4 Builds write, checked 2026-11-23, is the edit permission boundary. */
async function buildsWrite(io: DeploymentContext, accountId: string, path: string, method: 'PUT' | 'POST', body: unknown) {
  try {
    return acknowledged(await request(io, accountId, path, 'link', ['write', method], body));
  } catch (error) {
    const cause = isPluginError(error) ? error.data.failureCause : undefined;
    const nativeErrorCode = cause && 'nativeErrorCode' in cause ? cause.nativeErrorCode : undefined;
    if (isCloudflareTokenRefusal(cause?.httpStatus, nativeErrorCode)) {
      throw new PluginError({ code: 'cloudflare_builds_configuration_edit_required', retryable: false,
        details: { phase: 'link', requiredPermission: workersBuildsEditPermission }, failureCause: cause, effectAttempted: true });
    }
    if (method === 'PUT' && cause?.httpStatus === 404 && nativeErrorCode === '12000') {
      throw new PluginError({ code: 'needsGitAccess', retryable: false,
        details: { phase: 'link', grantUrl: cloudflareGitGrantUrl('workers', accountId) }, failureCause: cause, effectAttempted: true });
    }
    throw error;
  }
}

/** Native resource APIs, checked 2026-11-23. No deployment or retry.
 * https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/create/
 * https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/methods/create/
 * Neither endpoint documents an idempotency operand; the host retains recovery.
 */
async function create(input: CreateInput, context: PluginAccountActionContext, product: 'pages' | 'workers') {
  const repository = input.sourceMethod === 'gitIntegration' ? input.repository : undefined;
  const git = repository ? cloudflareGitRepository(repository) : null;
  const branch = input.productionBranch;
  if (input.sourceMethod !== 'upload' && (!git || !branch)) throw new PluginError({ code: 'unsupported_action',
    details: { phase: 'source', reason: 'cloudflare_git_repository_and_branch_required' } });
  const source = product === 'pages' && git && branch ? pagesCreateSource(git, branch) : null;
  if (product === 'pages' && input.providerEnvironment.selection.kind !== 'production') {
    throw new PluginError({ code: 'unsupported_action', details: { phase: 'link', reason: 'pages_create_requires_production' } });
  }
  if (product === 'pages' && !input.productionBranch) throw new PluginError({ code: 'invalid_parameters',
    details: { phase: 'link', requiredDraftPath: 'productionBranch' } });
  if (product === 'workers' && input.providerEnvironment.selection.kind !== 'script') throw new PluginError({ code: 'unsupported_action',
    details: { phase: 'link', reason: 'worker_create_requires_script' } });
  const http = context.services.http;
  if (!http) throw new PluginError({ code: 'client_required' });
  const io = { http, signal: context.signal, now: Date.now };
  const accountId = input.providerAccountId;
  const selection = input.providerEnvironment.selection;
  const builds = selection.kind === 'script' ? selection.builds : undefined;
  let repoConnectionUuid: string | undefined;
  if (product === 'workers' && git && repository) {
    if (!builds) throw new PluginError({ code: 'invalid_parameters',
      details: { phase: 'link', requiredDraftPath: 'providerEnvironment.selection.builds' } });
    // https://developers.cloudflare.com/api/resources/workers_builds/subresources/repos/subresources/connections/methods/upsert/
    const connection = await buildsWrite(io, accountId, '/builds/repos/connections', 'PUT', {
      provider_type: git.kind, provider_account_id: builds.namespaceId, provider_account_name: git.owner,
      repo_id: builds.repositoryId, repo_name: git.name,
    });
    if (!isObject(connection) || !text(connection.repo_connection_uuid)) return unknownOutcome();
    repoConnectionUuid = connection.repo_connection_uuid;
  }
  const native = acknowledged(await request(io, accountId, product === 'pages' ? '/pages/projects' : '/workers/workers',
    'link', ['write', 'POST'], { name: input.resourceName, ...(product === 'pages' ? { production_branch: branch,
      ...(source ? { source } : {}) } : { subdomain: { enabled: true, previews_enabled: false } }) }));
  if (!isObject(native) || !text(native.id) || !text(native.name)
    || product === 'pages' && !text(native.production_branch)) return unknownOutcome();
  const environment = product === 'pages' ? { kind: 'production' as const } : { kind: 'script' as const, scriptName: native.name };
  let providerResourceId = native.id;
  let triggerUuid: string | undefined;
  let productionBranchOutcome: ProductionBranchOutcome | undefined;
  let repositoryAccess: DeploymentTargetRepositoryAccessV1 | undefined;
  if (source && repository) repositoryAccess = pagesRepositoryAccess(native.source, repository, accountId);
  if (repoConnectionUuid && builds && branch && repository) {
    try {
      // The Builds API identifies the Worker by its immutable script tag.
      const tag = await resolveWorkerTag(accountId, native.name, io);
      if (typeof tag !== 'string') refuseNative(tag);
      providerResourceId = tag;
      // Configuring a trigger does not invoke the separate create-build endpoint.
      // https://developers.cloudflare.com/api/resources/workers_builds/subresources/triggers/methods/create/
      const trigger = await buildsWrite(io, accountId, '/builds/triggers', 'POST', {
        external_script_id: providerResourceId, repo_connection_uuid: repoConnectionUuid, build_token_uuid: builds.buildTokenUuid,
        trigger_name: 'Production Deploy', branch_includes: [branch], branch_excludes: [], path_includes: ['*'], path_excludes: [],
        root_directory: '/', build_command: '', deploy_command: 'npx wrangler deploy',
      });
      if (!isObject(trigger) || !text(trigger.trigger_uuid)) unknownOutcome();
      triggerUuid = trigger.trigger_uuid;
      repositoryAccess = { status: 'ready', repository };
    } catch (error) {
      // The Worker already exists. Preserve the acknowledgment for the same link/recovery flow as Vercel.
      productionBranchOutcome = { status: 'unconfirmed', requestedBranch: branch,
        failureCause: projectActionFailureCauseV1(error, 'deployment.provider.branch') };
      repositoryAccess = { status: 'needsGitAccess', repository };
    }
  }
  return projectNativeJsonValueForTransport({ credentialPrincipal: input.credentialPrincipal,
    providerIdentity: { providerAccountId: accountId, providerResourceId,
      providerEnvironment: product === 'pages' ? 'production' : workerEnvironmentKey(native.name) },
    providerEnvironment: { kind: 'native', selection: environment }, sourceMethod: input.sourceMethod,
    ...(repositoryAccess ? { repositoryAccess } : {}),
    ...(product === 'pages' ? { providerUrl: `https://dash.cloudflare.com?to=/${encodeURIComponent(input.providerAccountId)}/pages/view/${encodeURIComponent(native.name)}` } : {}),
    preparedNative: { projectName: native.name, reviewNotice: cloudflareReviewNotice(product, input.sourceMethod!),
      ...(triggerUuid ? { triggerUuid } : {}),
      ...(productionBranchOutcome ? { productionBranchOutcome } : {}),
      ...(product === 'pages' ? {
        pages: { projectMode: native.source ? 'gitIntegration' : 'directUpload', productionBranch: native.production_branch } } : {}) } });
}

const common = { execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
  scopes: ['global'], surfaces: ['cli', 'plugin', 'ui', 'agent', 'mcp'], placementBindings: [],
  connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'deploy.manage' }],
  dangerLevel: 'writesRemote', readOnly: false,
} as const;
const accountHint = { path: 'providerAccountId', title: 'Cloudflare Account', widget: 'select', required: true,
  inputType: { pluginId: 'happier.deploy.cloudflare', localId: 'target-choice' } } as const;
const sourceMethodHint = { path: 'sourceMethod', title: 'Source method', widget: 'select', required: true, defaultValue: 'upload',
  options: [{ value: 'upload', label: 'Upload' }, { value: 'gitIntegration', label: 'Git integration' }] } as const;
const gitOnly = { op: 'eq', path: 'sourceMethod', value: 'gitIntegration' } as const;
export const pagesCreate: AccountAction = { ...common, title: 'Create a Cloudflare Pages project',
  hostAccess: ['cloudflare-pages', 'deploy.manage'],
  inputSchema: cloudflareRoleSchema(inputs.create.jsonSchema, 'pages'), resultSchema: cloudflareRoleSchema(output.jsonSchema, 'pages'),
  confirmation: { title: 'Create this Cloudflare Pages project? Provider billing may apply.' },
  inputHints: { fields: [accountHint,
    { path: 'resourceName', title: 'Project name', widget: 'text', required: true },
    { path: 'productionBranch', title: 'Production branch', widget: 'text', required: true },
    sourceMethodHint,
    { path: 'providerEnvironment', title: 'Environment', widget: 'select', required: true,
      inputType: { pluginId: 'happier.deploy.cloudflare', localId: 'new-pages-environment' },
      defaultValue: { kind: 'native', selection: { kind: 'production' } },
      options: [{ value: { kind: 'native', selection: { kind: 'production' } }, label: 'Production' }] },
  ] },
  run: (value, context) => create(value as unknown as CreateInput, context, 'pages'),
};
function nativeDiscriminator(path: string, title: string, value: string) {
  return { path, title, widget: 'select', defaultValue: value, options: [{ value, label: title }],
    visibleWhen: { op: 'not', predicate: { op: 'eq', path, value } } } as const;
}

export const workersCreate: AccountAction = { ...common, title: 'Create a Cloudflare Worker',
  hostAccess: ['cloudflare-workers', 'deploy.manage'],
  inputSchema: cloudflareRoleSchema(inputs.create.jsonSchema, 'workers'), resultSchema: cloudflareRoleSchema(output.jsonSchema, 'workers'),
  confirmation: { title: 'Create this Cloudflare Worker? Provider billing may apply.' },
  inputHints: { fields: [accountHint,
    { path: 'resourceName', title: 'Worker name', widget: 'text', required: true },
    sourceMethodHint,
    { path: 'productionBranch', title: 'Production branch', widget: 'text', requiredWhen: gitOnly, visibleWhen: gitOnly },
    nativeDiscriminator('providerEnvironment.kind', 'Native environment', 'native'),
    nativeDiscriminator('providerEnvironment.selection.kind', 'Worker script', 'script'),
    { path: 'providerEnvironment.selection.scriptName', title: 'Worker script', widget: 'select', required: true,
      optionsDraftDependencies: ['resourceName'],
      inputType: { pluginId: 'happier.deploy.cloudflare', localId: 'workers-target-choice' } },
    { path: 'providerEnvironment.selection.builds.repositoryId', title: 'Git repository ID', widget: 'text',
      requiredWhen: gitOnly, visibleWhen: gitOnly },
    { path: 'providerEnvironment.selection.builds.namespaceId', title: 'Git repository owner or namespace ID', widget: 'text',
      requiredWhen: gitOnly, visibleWhen: gitOnly },
    { path: 'providerEnvironment.selection.builds.buildTokenUuid', title: 'Cloudflare build token UUID', widget: 'text',
      requiredWhen: gitOnly, visibleWhen: gitOnly },
  ] },
  run: (value, context) => create(value as unknown as CreateInput, context, 'workers'),
};
