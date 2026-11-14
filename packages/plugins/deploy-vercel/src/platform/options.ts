import { PluginError, projectActionFailureCauseV1, withActionFailureDiagnostic } from '@happier-dev/plugin-sdk/errors';
import { DeploymentTargetPreparationBaseV1ProtocolSchema } from '@happier-dev/plugin-sdk/protocol';
import type { DefinePluginInput, JsonValue } from '@happier-dev/plugin-sdk';
import type { InputOption, PluginAccountActionContext, PluginActionDeclaration, PluginActionDefinition } from '@happier-dev/plugin-sdk/actions';
import type { PluginDynamicResourceRuntime } from '@happier-dev/plugin-sdk/resources';
import { readVercelProjectCoordinates, vercelEndpoint, vercelRequest } from './operations.js';

const pluginId = 'happier.deploy.vercel';
const execution = { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } } as const;
const base = DeploymentTargetPreparationBaseV1ProtocolSchema.jsonSchema.properties!;
const paths = ['providerAccountId', 'projectId', 'providerEnvironment'] as const;
type OptionsInput = Readonly<{ credentialRef: JsonValue; credentialPrincipal: JsonValue;
  fieldPath: typeof paths[number]; providerAccountId?: string; providerResourceId?: string; gitBranch?: string; query?: string; cursor?: string }>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function invalid(): never { throw new PluginError({ code: 'provider_response_invalid' }); }
function matches(option: InputOption, query?: string) {
  return !query || option.label.toLowerCase().includes(query.toLowerCase());
}
function pageCursor(value: unknown) {
  if (!record(value) || !('next' in value)) return invalid();
  if (value.next === null) return undefined;
  if (typeof value.next === 'number' && Number.isFinite(value.next)) return `until:${value.next}`;
  if (text(value.next)) return `from:${value.next}`;
  return invalid();
}
function continuation(url: URL, cursor?: string) {
  if (!cursor) return;
  const divider = cursor.indexOf(':');
  const kind = cursor.slice(0, divider);
  const value = cursor.slice(divider + 1);
  if ((kind !== 'until' && kind !== 'from') || !value) throw new PluginError({ code: 'invalid_parameters' });
  url.searchParams.set(kind, value);
}
async function read(url: URL, context: PluginAccountActionContext): Promise<unknown> {
  if (!context.services.http) throw new PluginError({ code: 'client_required' });
  const response = await vercelRequest({ http: context.services.http, signal: context.signal, now: Date.now }, url.href, 'GET');
  if (response.status < 200 || response.status >= 300) throw withActionFailureDiagnostic(new PluginError({ code: response.status === 401 || response.status === 403
    ? 'deployment_access_denied' : response.status === 404 ? 'deployment_unavailable' : 'provider_request_failed',
    failureCause: projectActionFailureCauseV1(response, 'deployment.vercel.options') }), { phase: 'deployment.vercel.options', causeKind: response.status === 404 ? 'not_found'
      : response.status === 401 || response.status === 403 ? 'access_denied' : 'native_failure' });
  try { return JSON.parse(new TextDecoder().decode(response.body)); } catch { return invalid(); }
}

/** Finite provider pages, not a scan or a background source. Primary contracts checked 2026-11-07:
 * https://vercel.com/docs/accounts/access-tokens (scoped tokens infer their team, not the personal user).
 * https://vercel.com/docs/rest-api/projects/retrieve-a-list-of-projects
 * https://vercel.com/docs/rest-api/environment/retrieve-custom-environments
 * https://openapi.vercel.sh/ (numeric timestamp and string continuation pagination variants).
 */
async function options(input: OptionsInput, context: PluginAccountActionContext) {
  context.signal.throwIfAborted();
  if (input.fieldPath === paths[0]) {
    // Connection configuration owns this scope. /user and /teams can expose unrelated
    // identities or deny project PATs; neither is a catalogue of this connection's scope.
    const binding = await context.services.connectedAccounts.getBinding('deploy.manage', { signal: context.signal });
    const material = await context.services.connectedAccounts.materialize('deploy.manage',
      { kind: 'environment', keys: ['VERCEL_TEAM_ID'] }, { signal: context.signal });
    context.signal.throwIfAborted();
    if (!binding || material.kind !== 'environment' || !text(material.env.VERCEL_TEAM_ID)) {
      throw new PluginError({ code: 'credential_unavailable' });
    }
    const option = { value: material.env.VERCEL_TEAM_ID, label: binding.target.displayName };
    return { options: matches(option, input.query) ? [option] : [] };
  }
  if (!input.providerAccountId) return { options: [] };
  if (input.fieldPath === paths[1]) {
    const url = new URL(vercelEndpoint('/v10/projects', input.providerAccountId));
    if (input.query) url.searchParams.set('search', input.query);
    continuation(url, input.cursor);
    const value = await read(url, context);
    const projects = Array.isArray(value) ? value : record(value) ? value.projects : undefined;
    if (!Array.isArray(projects)) return invalid();
    const result: InputOption[] = projects.map(project => {
      if (!record(project) || !text(project.id) || !text(project.name) || project.accountId !== input.providerAccountId) return invalid();
      return { value: project.id, label: project.name };
    });
    const nextCursor = Array.isArray(value) ? undefined : record(value) ? pageCursor(value.pagination) : undefined;
    return { options: result, ...(nextCursor ? { nextCursor } : {}) };
  }
  if (!input.providerResourceId) return { options: [] };
  const value = await read(new URL(vercelEndpoint(`/v9/projects/${encodeURIComponent(input.providerResourceId)}/custom-environments`, input.providerAccountId)), context);
  if (!record(value) || !Array.isArray(value.environments)) return invalid();
  const result: InputOption[] = [{ value: { kind: 'production' }, label: 'Production' }, { value: { kind: 'preview' }, label: 'Preview' }];
  if (input.gitBranch) result.push({ value: { kind: 'preview', gitBranch: input.gitBranch }, label: `Preview: ${input.gitBranch}` });
  for (const environment of value.environments) {
    if (!record(environment) || !text(environment.id) || !text(environment.slug)) return invalid();
    result.push({ value: { kind: 'custom', id: environment.id }, label: environment.slug });
  }
  return { options: result.filter(option => matches(option, input.query)) };
}

export const targetOptionsAction: PluginActionDefinition<Extract<PluginActionDeclaration, { execution: { target: 'account' } }>> = {
  title: 'Read Vercel target options', execution, scopes: ['global'], surfaces: ['cli', 'plugin'], placementBindings: [],
  hostAccess: ['vercel-api', 'deploy.manage'], connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'deploy.manage' }],
  dangerLevel: 'safe', readOnly: true,
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    credentialRef: base.credentialRef!, credentialPrincipal: base.credentialPrincipal!,
    fieldPath: { type: 'string', enum: [...paths] }, providerAccountId: { type: 'string', minLength: 1 },
    providerResourceId: { type: 'string', minLength: 1 }, gitBranch: { type: 'string', minLength: 1 }, query: { type: 'string' }, cursor: { type: 'string' } },
  required: ['credentialRef', 'credentialPrincipal', 'fieldPath'] },
  resultSchema: { type: 'object', additionalProperties: false, properties: { options: { type: 'array', items: {
    type: 'object', properties: { value: {}, label: { type: 'string' } }, required: ['value', 'label'], additionalProperties: false } },
  nextCursor: { type: 'string' } }, required: ['options'] },
  run: (input: JsonValue, context: PluginAccountActionContext) => options(input as unknown as OptionsInput, context),
};

const runtime: PluginDynamicResourceRuntime = {
  async read(options) {
    const query = options.query;
    const draft = query?.draftInput;
    if (!query?.fieldPath || !record(draft) || !draft.credentialRef || !draft.credentialPrincipal) throw new PluginError({ code: 'invalid_parameters' });
    const environment = record(draft.providerEnvironment) ? draft.providerEnvironment : {};
    const coordinates = readVercelProjectCoordinates(draft);
    const result = await options.readAction({ pluginId, localId: 'target-options-read' }, {
      // The query is host-admitted JSON; the read Action validates its custody operands.
      credentialRef: draft.credentialRef as JsonValue, credentialPrincipal: draft.credentialPrincipal as JsonValue,
      fieldPath: query.fieldPath,
      ...(text(coordinates.providerAccountId) ? { providerAccountId: coordinates.providerAccountId } : {}),
      ...(text(coordinates.providerResourceId) ? { providerResourceId: coordinates.providerResourceId } : {}),
      ...(environment.kind === 'preview' && text(environment.gitBranch) ? { gitBranch: environment.gitBranch } : {}),
      ...(query.query !== undefined ? { query: query.query } : {}), ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
    }, { signal: options.signal });
    if (!result.ok) throw withActionFailureDiagnostic(new PluginError({ code: 'errorCode' in result && typeof result.errorCode === 'string' ? result.errorCode : 'deployment_unavailable',
      failureCause: projectActionFailureCauseV1(result, 'deployment.vercel.options') }), { phase: 'deployment.vercel.options', causeKind: 'native_failure', error: result });
    return JSON.stringify(result.result);
  },
  observe: () => ({ dispose() {} }),
};
export const targetOptionsResources = { 'target-options': { source: 'dynamic', kind: 'config', scope: 'global', execution,
  contentType: 'application/json', runtime } } satisfies NonNullable<DefinePluginInput['resources']>;
export const targetInputTypes = {
  'provider-account': { title: 'Vercel account or Team', semantic: 'vercelAccount', valueSchema: { type: 'string', minLength: 1 }, options: { resource: 'target-options' } },
  'provider-project': { title: 'Vercel project', semantic: 'vercelProject', valueSchema: { type: 'string', minLength: 1 }, options: { resource: 'target-options' } },
  'provider-environment': { title: 'Vercel environment', semantic: 'vercelEnvironment', valueSchema: base.providerEnvironment!, options: { resource: 'target-options' } },
} satisfies NonNullable<DefinePluginInput['inputTypes']>;
export const targetInputHints = { fields: [
  { path: paths[0], title: 'Vercel account or Team', widget: 'select', required: true, inputType: { pluginId, localId: 'provider-account' } },
  { path: paths[1], title: 'Vercel project', widget: 'select', required: true, inputType: { pluginId, localId: 'provider-project' } },
  { path: paths[2], title: 'Vercel environment', widget: 'select', required: true, inputType: { pluginId, localId: 'provider-environment' } },
] } as const;
