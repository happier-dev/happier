import { withActionFailureDiagnostic } from '@happier-dev/plugin-sdk/errors';
import { DeploymentTargetPreparationBaseV1ProtocolSchema as preparation, PluginError,
  type DeploymentTargetPreparationBaseV1, type JsonValue } from '@happier-dev/plugin-sdk';
import { ScmHostingRepositoryIdentityV1ProtocolSchema, projectNativeJsonValueForTransport, type PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import type { PluginAccountActionContext, PluginActionDeclaration } from '@happier-dev/plugin-sdk/actions';
import { isObject } from '../connectedAccounts/probe.js';
import { targetProductSchema } from './targetOptions.js';
import { request } from './deploymentHttp.js';
import { pagesRepositoryAccess } from './pagesSource.js';
import { cloudflareReviewNotice } from './reviewNotice.js';
import { cloudflareRoleSchema, type CloudflareRoleInput, type PagesSelection } from './targetSelection.js';

const base = cloudflareRoleSchema(preparation.jsonSchema, 'pages');
export const pagesLinkSchema: PluginJsonSchema = { type: 'object', additionalProperties: false,
  properties: { credentialPrincipal: base.properties!.credentialPrincipal!, providerIdentity: base.properties!.providerIdentity!,
    sourceMethod: base.properties!.sourceMethod!,
    providerEnvironment: base.properties!.providerEnvironment!, repositoryAccess: base.properties!.repositoryAccess!, preparedNative: base.properties!.preparedNative! },
  required: ['credentialPrincipal', 'providerIdentity', 'providerEnvironment', 'preparedNative'] };
export const pagesCommon = { execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
  scopes: ['global'], surfaces: ['cli', 'plugin'], placementBindings: [], hostAccess: ['cloudflare-pages', 'deploy.manage'],
  connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'deploy.manage' }] } as const;
type PreparationAction = Extract<PluginActionDeclaration, { execution: { target: 'account' } }> & {
  run(value: JsonValue, context: PluginAccountActionContext): Promise<JsonValue>;
};
export function pagesIo(context: PluginAccountActionContext) {
  if (!context.services.http) throw new PluginError({ code: 'client_required' });
  return { http: context.services.http, signal: context.signal, now: () => Date.now() };
}
function invalid(): never { throw new PluginError({ code: 'provider_response_invalid', details: { phase: 'link' } }); }
function relativeDirectory(value: unknown): value is string {
  if (typeof value !== 'string' || value.includes('\\') || /^(?:\/|[a-z]:)/iu.test(value)) return false;
  let depth = 0;
  for (const part of value.split('/')) {
    if (part === '..') { if (--depth < 0) return false; }
    else if (part && part !== '.') depth++;
  }
  return true;
}

export const pagesPrepareInput = { type: 'object', additionalProperties: false, properties: { ...base.properties, product: targetProductSchema,
    repository: ScmHostingRepositoryIdentityV1ProtocolSchema.jsonSchema }, required: [...base.required ?? [], 'preparedNative', 'repository'],
  // The sheet selects native coordinates (account + project name); reinspection passes the complete identity.
  oneOf: [{ required: ['providerAccountId'] }, { required: ['providerIdentity'] }] } satisfies PluginJsonSchema;

export const pagesPrepare: PreparationAction = { ...pagesCommon, title: 'Adopt the selected existing Cloudflare Pages project',
  dangerLevel: 'safe', readOnly: true,
  inputSchema: pagesPrepareInput,
  resultSchema: pagesLinkSchema,
  async run(value: JsonValue, context: PluginAccountActionContext) {
    const input = value as unknown as CloudflareRoleInput<DeploymentTargetPreparationBaseV1, PagesSelection> & {
      repository: ReturnType<typeof ScmHostingRepositoryIdentityV1ProtocolSchema.parse>;
    };
    const accountId = input.providerIdentity?.providerAccountId ?? input.providerAccountId;
    if (!accountId || !input.preparedNative) {
      throw new PluginError({ code: 'unsupported_action' });
    }
    const reply = await request(pagesIo(context), accountId,
      `/pages/projects/${encodeURIComponent(input.preparedNative.projectName)}`, 'link');
    if ('code' in reply) throw withActionFailureDiagnostic(new PluginError({ code: reply.code, retryable: reply.retryable, details: { phase: reply.phase } }), { phase: `deployment.cloudflare.${reply.phase}`,
      causeKind: 'native_failure', error: reply });
    const project = reply.value;
    // Native coordinates take the project's id from this read; a complete identity must still name this project.
    if (!isObject(project) || typeof project.id !== 'string' || !project.id
      || (input.providerIdentity && project.id !== input.providerIdentity.providerResourceId) || project.name !== input.preparedNative.projectName
      || typeof project.production_branch !== 'string' || !project.production_branch) invalid();
    const build = project.build_config;
    if (build !== undefined && !isObject(build)) invalid();
    if (isObject(build) && (build.build_command !== undefined && typeof build.build_command !== 'string'
      || build.destination_dir !== undefined && !relativeDirectory(build.destination_dir)
      || build.root_dir !== undefined && !relativeDirectory(build.root_dir))) invalid();
    const source = project.source;
    if (source !== undefined && source !== null && (!isObject(source) || typeof source.type !== 'string')) invalid();
    const projectMode = source ? 'gitIntegration' : 'directUpload';
    return projectNativeJsonValueForTransport({ credentialPrincipal: input.credentialPrincipal,
      providerIdentity: { providerAccountId: accountId, providerResourceId: project.id,
        providerEnvironment: input.providerEnvironment.selection.kind === 'production' ? 'production'
        : input.providerEnvironment.selection.gitBranch ? `preview:${input.providerEnvironment.selection.gitBranch}` : 'preview' },
      providerEnvironment: input.providerEnvironment,
      ...(input.sourceMethod !== undefined ? { sourceMethod: input.sourceMethod } : {}),
      ...(input.sourceMethod === 'upload' ? {} : { repositoryAccess: pagesRepositoryAccess(source, input.repository, accountId) }),
      preparedNative: { projectName: project.name,
        reviewNotice: cloudflareReviewNotice('pages', input.sourceMethod ?? (projectMode === 'gitIntegration' ? 'gitIntegration' : 'upload')),
        pages: { projectMode, productionBranch: project.production_branch,
        ...(isObject(build) && typeof build.build_command === 'string' ? { buildCommand: build.build_command } : {}),
        ...(isObject(build) && typeof build.destination_dir === 'string' ? { buildOutputDirectory: build.destination_dir } : {}),
        ...(isObject(build) && typeof build.root_dir === 'string' ? { rootDirectory: build.root_dir } : {}) } } });
  } };

export const pagesLink: PreparationAction = { ...pagesPrepare, title: 'Link the prepared Cloudflare Pages project',
  dangerLevel: 'writesLocal', readOnly: false, confirmation: { title: 'Link this existing Cloudflare Pages project?' },
  inputSchema: base,
  async run(value: JsonValue) {
    const input = value as unknown as CloudflareRoleInput<DeploymentTargetPreparationBaseV1, PagesSelection>;
    if (!input.providerIdentity || !input.preparedNative?.pages) {
      throw new PluginError({ code: 'deployment_content_unavailable' });
    }
    return projectNativeJsonValueForTransport({ credentialPrincipal: input.credentialPrincipal, providerIdentity: input.providerIdentity,
      ...(input.sourceMethod !== undefined ? { sourceMethod: input.sourceMethod } : {}),
      providerEnvironment: input.providerEnvironment, ...(input.repositoryAccess ? { repositoryAccess: input.repositoryAccess } : {}), preparedNative: input.preparedNative });
  } };
