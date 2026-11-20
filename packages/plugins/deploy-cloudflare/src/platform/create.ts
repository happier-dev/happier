import { withActionFailureDiagnostic } from '@happier-dev/plugin-sdk/errors';
import { DeploymentTargetRoleInputProtocolSchemasV1 as inputs,
  DeploymentTargetLinkProviderContentV1ProtocolSchema as output, type JsonValue } from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import type { PluginAccountActionContext, PluginActionDeclaration } from '@happier-dev/plugin-sdk/actions';
import { request } from './deploymentHttp.js';
import { isObject } from '../connectedAccounts/probe.js';
import { workerEnvironmentKey } from './workers.js';
import { pagesCreateSource, pagesRepositoryAccess } from './pagesSource.js';
import { cloudflareReviewNotice } from './reviewNotice.js';

type CreateInput = ReturnType<typeof inputs.create.parse>;
type AccountAction = Extract<PluginActionDeclaration, { execution: { target: 'account' } }> & {
  run(value: JsonValue, context: PluginAccountActionContext): Promise<JsonValue>;
};
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function unknownOutcome(): never { throw new PluginError({ code: 'outcome_unknown', retryable: false, details: { phase: 'link' } }); }

/** Native resource APIs, checked 2026-11-12. No upload, deployment, lookup or retry.
 * https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/create/
 * https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/methods/create/
 * Neither endpoint documents an idempotency operand; the host retains recovery.
 */
async function create(input: CreateInput, context: PluginAccountActionContext, product: 'pages' | 'workers') {
  const source = product === 'pages' && input.sourceMethod === 'gitIntegration' && input.repository && input.productionBranch
    ? pagesCreateSource(input.repository, input.productionBranch) : null;
  if (input.sourceMethod !== 'upload' && !source) throw new PluginError({ code: 'unsupported_action',
    details: { phase: 'source', reason: 'native_create_requires_upload' } });
  if (product === 'pages' && input.providerEnvironment.kind !== 'production') {
    throw new PluginError({ code: 'unsupported_action', details: { phase: 'link', reason: 'pages_create_requires_production' } });
  }
  if (product === 'pages' && !input.productionBranch) throw new PluginError({ code: 'invalid_parameters',
    details: { phase: 'link', requiredDraftPath: 'productionBranch' } });
  if (product === 'workers' && input.providerEnvironment.kind !== 'script') throw new PluginError({ code: 'unsupported_action',
    details: { phase: 'link', reason: 'worker_create_requires_script' } });
  const http = context.services.http;
  if (!http) throw new PluginError({ code: 'client_required' });
  const reply = await request({ http, signal: context.signal, now: Date.now }, input.providerAccountId,
    product === 'pages' ? '/pages/projects' : '/workers/workers', 'link', ['write', 'POST'],
    { name: input.resourceName, ...(product === 'pages' ? { production_branch: input.productionBranch,
      ...(source ? { source } : {}) } : { subdomain: { enabled: true, previews_enabled: false } }) });
  if ('code' in reply) throw withActionFailureDiagnostic(new PluginError({ code: reply.code, retryable: reply.retryable, details: { phase: reply.phase } }), { phase: `deployment.cloudflare.${reply.phase}`,
      causeKind: 'native_failure', error: reply });
  const native = reply.value;
  if (!isObject(native) || !text(native.id) || !text(native.name)
    || product === 'pages' && !text(native.production_branch)) return unknownOutcome();
  const environment = product === 'pages' ? { kind: 'production' as const } : { kind: 'script' as const, scriptName: native.name };
  return projectNativeJsonValueForTransport({ credentialPrincipal: input.credentialPrincipal,
    providerIdentity: { providerAccountId: input.providerAccountId, providerResourceId: native.id,
      providerEnvironment: product === 'pages' ? 'production' : workerEnvironmentKey(native.name) },
    providerEnvironment: environment, sourceMethod: input.sourceMethod,
    ...(source && input.repository ? { repositoryAccess: pagesRepositoryAccess(native.source, input.repository, input.providerAccountId) } : {}),
    ...(product === 'pages' ? { providerUrl: `https://dash.cloudflare.com?to=/${encodeURIComponent(input.providerAccountId)}/pages/view/${encodeURIComponent(native.name)}` } : {}),
    preparedNative: { projectName: native.name, reviewNotice: cloudflareReviewNotice(product, input.sourceMethod!),
      ...(product === 'pages' ? {
        pages: { projectMode: native.source ? 'gitIntegration' : 'directUpload', productionBranch: native.production_branch } } : {}) } });
}

const common = { execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
  scopes: ['global'], surfaces: ['cli', 'plugin', 'ui', 'agent', 'mcp'], placementBindings: [],
  connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'deploy.manage' }],
  dangerLevel: 'writesRemote', readOnly: false,
  inputSchema: inputs.create.jsonSchema, resultSchema: output.jsonSchema,
} as const;
const accountHint = { path: 'providerAccountId', title: 'Cloudflare Account', widget: 'select', required: true,
  inputType: { pluginId: 'happier.deploy.cloudflare', localId: 'target-choice' } } as const;
export const pagesCreate: AccountAction = { ...common, title: 'Create a Cloudflare Pages project',
  hostAccess: ['cloudflare-pages', 'deploy.manage'],
  confirmation: { title: 'Create this Cloudflare Pages project? Provider billing may apply.' },
  inputHints: { fields: [accountHint,
    { path: 'resourceName', title: 'Project name', widget: 'text', required: true },
    { path: 'productionBranch', title: 'Production branch', widget: 'text', required: true },
    { path: 'sourceMethod', title: 'Source method', widget: 'select', required: true, defaultValue: 'upload',
      options: [{ value: 'upload', label: 'Upload' }, { value: 'gitIntegration', label: 'Git integration' }] },
    { path: 'providerEnvironment.kind', title: 'Environment', widget: 'select', required: true,
      defaultValue: 'production', options: [{ value: 'production', label: 'Production' }] },
  ] },
  run: (value, context) => create(value as unknown as CreateInput, context, 'pages'),
};
export const workersCreate: AccountAction = { ...common, title: 'Create a Cloudflare Worker',
  hostAccess: ['cloudflare-workers', 'deploy.manage'],
  confirmation: { title: 'Create this Cloudflare Worker? Provider billing may apply.' },
  inputHints: { fields: [accountHint,
    { path: 'resourceName', title: 'Worker name', widget: 'text', required: true },
    { path: 'sourceMethod', title: 'Source method', widget: 'select', required: true, defaultValue: 'upload',
      options: [{ value: 'upload', label: 'Upload' }] },
    { path: 'providerEnvironment', title: 'Environment', widget: 'select', required: true,
      inputType: { pluginId: 'happier.deploy.cloudflare', localId: 'workers-target-choice' } },
  ] },
  run: (value, context) => create(value as unknown as CreateInput, context, 'workers'),
};
