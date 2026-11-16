import { DeploymentTargetRoleInputProtocolSchemasV1 as inputs,
  DeploymentTargetLinkProviderContentV1ProtocolSchema as output,
  type JsonValue } from '@happier-dev/plugin-sdk';
import { PluginError, isPluginError, projectActionFailureCauseV1 } from '@happier-dev/plugin-sdk/errors';
import { normalizeScmBranchSourceRef } from '@happier-dev/plugin-sdk/scm';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import type { PluginAccountActionContext, PluginActionDeclaration } from '@happier-dev/plugin-sdk/actions';
import type { HttpResponse } from '@happier-dev/plugin-sdk/http';
import { vercelGitGrantUrl, supportsVercelGitRepository, readVercelGitLink, vercelEndpoint, vercelRequest } from './operations.js';
import { targetInputHints } from './options.js';

type CreateInput = ReturnType<typeof inputs.create.parse>;
type ProductionBranchOutcome = NonNullable<NonNullable<ReturnType<typeof output.parse>['preparedNative']>['productionBranchOutcome']>;
type AccountAction = Extract<PluginActionDeclaration, { execution: { target: 'account' } }> & {
  run(input: JsonValue, context: PluginAccountActionContext): Promise<JsonValue>;
};
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function unknownOutcome(): never {
  throw new PluginError({ code: 'outcome_unknown', retryable: false, details: { phase: 'link' } });
}

/** Native resource creation with optional vendor-owned Git linking; never deploy or probe after dispatch.
 * https://vercel.com/docs/rest-api/projects/create-a-new-project (2026-11-12).
 * No documented idempotency key: the host owns persisted request-key recovery.
 */
export const projectCreateAction: AccountAction = {
  title: 'Create a Vercel project',
  execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
  scopes: ['global'], surfaces: ['cli', 'plugin', 'ui', 'agent', 'mcp'], placementBindings: [],
  hostAccess: ['vercel-api', 'deploy.manage'],
  connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'deploy.manage' }],
  dangerLevel: 'writesRemote', readOnly: false,
  confirmation: { title: 'Create this Vercel project? Provider billing may apply.' },
  inputSchema: inputs.create.jsonSchema, resultSchema: output.jsonSchema,
  inputHints: { fields: [targetInputHints.fields[0],
    { path: 'resourceName', title: 'Project name', widget: 'text', required: true },
    { path: 'sourceMethod', title: 'Source method', widget: 'select', required: true, defaultValue: 'upload',
      options: [{ value: 'upload', label: 'Upload' }, { value: 'gitIntegration', label: 'Git integration' }] },
    { path: 'productionBranch', title: 'Production branch', widget: 'text',
      visibleWhen: { op: 'eq', path: 'sourceMethod', value: 'gitIntegration' } },
    { path: 'providerEnvironment', title: 'Environment', widget: 'json', required: true,
      defaultValue: { kind: 'production' } },
  ] },
  async run(value, context) {
    const input = value as unknown as CreateInput;
    if (input.sourceMethod === 'gitIntegration') {
      if (!input.repository) throw new PluginError({ code: 'repository_required', details: { phase: 'source' } });
      if (!supportsVercelGitRepository(input.repository)) {
        throw new PluginError({ code: 'unsupported_action', details: { phase: 'source', reason: 'vercel_git_provider_unsupported' } });
      }
    } else if (input.sourceMethod !== 'upload') throw new PluginError({ code: 'unsupported_action',
      details: { phase: 'source', reason: 'unsupported_source_method' } });
    if (input.providerEnvironment.kind !== 'production') throw new PluginError({ code: 'unsupported_action',
      details: { phase: 'link', reason: 'new_project_requires_production' } });
    const http = context.services.http;
    if (!http) throw new PluginError({ code: 'client_required' });
    let response: HttpResponse;
    try {
      response = await vercelRequest({ http, signal: context.signal, now: Date.now },
        vercelEndpoint('/v11/projects', input.providerAccountId), 'POST',
        { headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ name: input.resourceName,
          ...(input.sourceMethod === 'gitIntegration' ? { gitRepository: { type: input.repository!.kind, repo: input.repository!.repository } } : {}) })) }, 'link', input.repository?.kind);
    } catch (error) { if (isPluginError(error)) throw error; return unknownOutcome(); }
    let body: unknown;
    try { body = JSON.parse(new TextDecoder().decode(response.body)); } catch { body = undefined; }
    if (response.status >= 500) return unknownOutcome();
    if (response.status < 200 || response.status >= 300) {
      const errorCode = record(body) && record(body.error) && text(body.error.code) ? body.error.code : null;
      throw new PluginError({ code: response.status === 401 || response.status === 403 ? 'deployment_access_denied' : 'provider_request_failed',
        retryable: false, details: { phase: 'link' }, failureCause: { phase: 'deployment.provider.link',
          errorClass: 'Error', errorCode, httpStatus: response.status } });
    }
    if (!record(body) || !text(body.id) || !text(body.accountId) || !text(body.name)) return unknownOutcome();
    let productionBranchOutcome: ProductionBranchOutcome | undefined;
    if (input.sourceMethod === 'gitIntegration') {
      const nativeBranch = record(body.link) && text(body.link.productionBranch)
        ? normalizeScmBranchSourceRef(body.link.productionBranch) : null;
      const defaultBranch = nativeBranch?.ok ? nativeBranch.sourceRef : undefined;
      const requestedBranch = input.productionBranch;
      if (requestedBranch === undefined || requestedBranch === defaultBranch) {
        if (defaultBranch) productionBranchOutcome = { status: 'set', branch: defaultBranch };
      } else {
        // The project is already acknowledged. Branch failure must never discard that identity or repeat Create.
        try {
          const branch = await vercelRequest({ http, signal: context.signal, now: Date.now },
            vercelEndpoint(`/v9/projects/${encodeURIComponent(body.id)}/branch`, input.providerAccountId), 'PATCH',
            { headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ branch: requestedBranch })) }, 'branch');
          if (branch.status < 200 || branch.status >= 300) throw new PluginError({ code: 'provider_request_failed',
            failureCause: { phase: 'deployment.provider.branch', errorClass: 'Error', errorCode: null, httpStatus: branch.status } });
          productionBranchOutcome = { status: 'set', branch: requestedBranch };
        } catch (error) {
          const failureCause = projectActionFailureCauseV1(error, 'deployment.provider.branch');
          productionBranchOutcome = defaultBranch !== undefined && failureCause.httpStatus !== null && failureCause.httpStatus >= 400 && failureCause.httpStatus < 500
            ? { status: 'defaultKept', branch: defaultBranch, requestedBranch, failureCause }
            : { status: 'unconfirmed', ...(defaultBranch ? { previousBranch: defaultBranch } : {}), requestedBranch, failureCause };
        }
      }
    }
    // Vercel links `gitRepository` only through an integration that can read it and refuses
    // Create otherwise, so the acknowledged link is the same deployable fact Inspect observes.
    const gitLink = input.sourceMethod === 'gitIntegration' ? readVercelGitLink(body.link, input.repository!) : null;
    return projectNativeJsonValueForTransport({ credentialPrincipal: input.credentialPrincipal,
      providerIdentity: { providerAccountId: body.accountId, providerResourceId: body.id, providerEnvironment: 'production' },
      providerEnvironment: { kind: 'production' }, sourceMethod: input.sourceMethod,
      ...(input.sourceMethod === 'gitIntegration' ? { repositoryAccess: gitLink
        ? { status: 'ready', repository: input.repository! }
        : { status: 'needsGitAccess', repository: input.repository!, grantUrl: vercelGitGrantUrl(input.repository!.kind) } } : {}),
      preparedNative: { projectName: body.name, ...(productionBranchOutcome ? { productionBranchOutcome } : {}),
        ...(gitLink ? { gitSource: gitLink.gitSource } : {}) } });
  },
};
