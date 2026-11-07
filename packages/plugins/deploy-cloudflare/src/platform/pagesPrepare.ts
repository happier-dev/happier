import { DeploymentTargetPreparationBaseV1ProtocolSchema as preparation, PluginError,
  type DeploymentTargetPreparationBaseV1, type JsonValue } from '@happier-dev/plugin-sdk';
import { ScmHostingRepositoryIdentityV1ProtocolSchema, projectNativeJsonValueForTransport, type PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import type { PluginAccountActionContext, PluginActionDeclaration } from '@happier-dev/plugin-sdk/actions';
import { isObject } from '../connectedAccounts/probe.js';
import { targetProductSchema } from './targetOptions.js';
import { request } from './deploymentHttp.js';

const base = preparation.jsonSchema;
export const pagesLinkSchema: PluginJsonSchema = { type: 'object', additionalProperties: false,
  properties: { credentialPrincipal: base.properties!.credentialPrincipal!, providerIdentity: base.properties!.providerIdentity!,
    providerEnvironment: base.properties!.providerEnvironment!, repositoryAccess: base.properties!.repositoryAccess!, preparedNative: base.properties!.preparedNative! },
  required: ['credentialPrincipal', 'providerIdentity', 'providerEnvironment', 'repositoryAccess', 'preparedNative'] };
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
    repository: ScmHostingRepositoryIdentityV1ProtocolSchema.jsonSchema }, required: [...base.required ?? [], 'providerIdentity', 'preparedNative', 'repository'] } satisfies PluginJsonSchema;

export const pagesPrepare: PreparationAction = { ...pagesCommon, title: 'Adopt the selected existing Cloudflare Pages project',
  dangerLevel: 'safe', readOnly: true,
  inputSchema: pagesPrepareInput,
  resultSchema: pagesLinkSchema,
  async run(value: JsonValue, context: PluginAccountActionContext) {
    const input = value as unknown as DeploymentTargetPreparationBaseV1 & {
      repository: ReturnType<typeof ScmHostingRepositoryIdentityV1ProtocolSchema.parse>;
    };
    if (!input.providerIdentity || !input.preparedNative || (input.providerEnvironment.kind !== 'production'
      && (input.providerEnvironment.kind !== 'preview' || 'scriptName' in input.providerEnvironment))) {
      throw new PluginError({ code: 'unsupported_action' });
    }
    const reply = await request(pagesIo(context), input.providerIdentity.providerAccountId,
      `/pages/projects/${encodeURIComponent(input.preparedNative.projectName)}`, 'link');
    if ('code' in reply) throw new PluginError({ code: reply.code, retryable: reply.retryable, details: { phase: reply.phase } });
    const project = reply.value;
    if (!isObject(project) || project.id !== input.providerIdentity.providerResourceId || project.name !== input.preparedNative.projectName
      || typeof project.production_branch !== 'string' || !project.production_branch) invalid();
    const build = project.build_config;
    if (build !== undefined && !isObject(build)) invalid();
    if (isObject(build) && (build.build_command !== undefined && typeof build.build_command !== 'string'
      || build.destination_dir !== undefined && !relativeDirectory(build.destination_dir)
      || build.root_dir !== undefined && !relativeDirectory(build.root_dir))) invalid();
    const source = project.source;
    if (source !== undefined && source !== null && (!isObject(source) || typeof source.type !== 'string')) invalid();
    const projectMode = source ? 'gitIntegration' : 'directUpload';
    const nativeRepository = isObject(source) && isObject(source.config) ? source.config : undefined;
    const ready = isObject(source) && source.type === input.repository.kind && nativeRepository
      && `${nativeRepository.owner}/${nativeRepository.repo_name}` === input.repository.repository
      && input.repository.deployment === (source.type === 'github' ? 'https://github.com' : 'https://gitlab.com');
    return projectNativeJsonValueForTransport({ credentialPrincipal: input.credentialPrincipal,
      providerIdentity: { ...input.providerIdentity, providerEnvironment: input.providerEnvironment.kind === 'production' ? 'production'
        : input.providerEnvironment.gitBranch ? `preview:${input.providerEnvironment.gitBranch}` : 'preview' },
      providerEnvironment: input.providerEnvironment, repositoryAccess: { status: ready ? 'ready' : 'needsGitAccess', repository: input.repository },
      preparedNative: { projectName: project.name, pages: { projectMode, productionBranch: project.production_branch,
        ...(isObject(build) && typeof build.build_command === 'string' ? { buildCommand: build.build_command } : {}),
        ...(isObject(build) && typeof build.destination_dir === 'string' ? { buildOutputDirectory: build.destination_dir } : {}),
        ...(isObject(build) && typeof build.root_dir === 'string' ? { rootDirectory: build.root_dir } : {}) } } });
  } };

export const pagesLink: PreparationAction = { ...pagesPrepare, title: 'Link the prepared Cloudflare Pages project',
  dangerLevel: 'writesLocal', readOnly: false, confirmation: { title: 'Link this existing Cloudflare Pages project?' },
  inputSchema: preparation.jsonSchema,
  async run(value: JsonValue) {
    const input = value as unknown as DeploymentTargetPreparationBaseV1;
    if (!input.providerIdentity || !input.repositoryAccess || !input.preparedNative?.pages) {
      throw new PluginError({ code: 'deployment_content_unavailable' });
    }
    return projectNativeJsonValueForTransport({ credentialPrincipal: input.credentialPrincipal, providerIdentity: input.providerIdentity,
      providerEnvironment: input.providerEnvironment, repositoryAccess: input.repositoryAccess, preparedNative: input.preparedNative });
  } };
