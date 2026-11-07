import { DeploymentTargetPreparationBaseV1ProtocolSchema, type PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import type { PluginDynamicResourceRuntime } from '@happier-dev/plugin-sdk/resources';
import { isObject } from '../connectedAccounts/probe.js';
import { request, requestAccounts, type DeploymentContext } from './deploymentHttp.js';

const pluginId = 'happier.deploy.cloudflare';
const text = { type: 'string', minLength: 1 } as const;
const base = DeploymentTargetPreparationBaseV1ProtocolSchema.jsonSchema;
const providerIdentity = { type: 'object', additionalProperties: false, properties: {
  providerAccountId: text, providerResourceId: text, providerEnvironment: text } } as const;
const product: PluginJsonSchema = { type: 'string', enum: ['workers', 'pages'] };
const inputSchema: PluginJsonSchema = { type: 'object', additionalProperties: false, properties: {
  credentialRef: base.properties!.credentialRef!, credentialPrincipal: base.properties!.credentialPrincipal!,
  product, providerIdentity, scriptName: text, fieldPath: text, query: { type: 'string' }, cursor: { type: 'string', pattern: '^[1-9][0-9]*$' },
}, required: ['credentialRef', 'credentialPrincipal', 'fieldPath'] };
type Input = Readonly<{ product?: 'workers' | 'pages'; providerIdentity?: { providerAccountId?: string; providerResourceId?: string };
  scriptName?: string;
  fieldPath: string; query?: string; cursor?: string }>;
type Option = { value: JsonValue; label: string };
function invalid(): never { throw new PluginError({ code: 'provider_response_invalid' }); }
function name(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function options(rows: readonly Option[], query?: string) {
  const search = query?.toLocaleLowerCase();
  return rows.filter(row => !search || row.label.toLocaleLowerCase().includes(search));
}

/** One explicit request reads one provider page. Scripts are an unpaged vendor endpoint;
 * Pages and Accounts use vendor result_info. No prefetch, cache, polling or secret projection.
 * Evidence: Cloudflare API Accounts/List, Workers/Scripts/List and Pages/Projects/List (2026-11-03).
 */
async function read(input: Input, context: DeploymentContext) {
  context.signal.throwIfAborted();
  if (input.fieldPath === 'product') return { options: options([
    { value: 'workers', label: 'Workers' }, { value: 'pages', label: 'Pages' },
  ], input.query) };
  const params = new URLSearchParams();
  if (input.cursor) params.set('page', input.cursor);
  let reply;
  let selectedScript: string | undefined;
  if (input.fieldPath === 'providerIdentity.providerAccountId') {
    if (input.query) params.set('name', input.query);
    reply = await requestAccounts(context, params.size ? `?${params}` : '');
  } else {
    const accountId = input.providerIdentity?.providerAccountId;
    if (!accountId) return { options: [] };
    let path: string;
    if (input.fieldPath === 'triggerUuid') {
      if (!input.providerIdentity?.providerResourceId) return { options: [] };
      path = `/builds/workers/${encodeURIComponent(input.providerIdentity.providerResourceId)}/triggers`;
    } else if (input.product === 'pages') {
      if (input.fieldPath === 'providerEnvironment') return { options: options([
        { value: { kind: 'production' }, label: 'Production' }, { value: { kind: 'preview' }, label: 'Preview' },
      ], input.query) };
      path = `/pages/projects${params.size ? `?${params}` : ''}`;
    } else if (input.product === 'workers') {
      selectedScript = input.fieldPath === 'providerEnvironment' ? input.scriptName : undefined;
      if (selectedScript && input.query) params.set('name', input.query);
      path = selectedScript ? `/workers/workers/${encodeURIComponent(selectedScript)}/previews${params.size ? `?${params}` : ''}` : '/workers/scripts';
    } else return { options: [] };
    reply = await request(context, accountId, path, 'link');
  }
  if ('code' in reply) throw new PluginError({ code: reply.code, retryable: reply.retryable, details: { phase: reply.phase } });
  if (!Array.isArray(reply.value)) invalid();
  const rows: Option[] = reply.value.map((row: unknown): Option => {
    if (!isObject(row)) return invalid();
    if (input.fieldPath === 'providerIdentity.providerAccountId') {
      if (!name(row.id) || !name(row.name)) return invalid();
      return { value: row.id, label: row.name };
    }
    if (input.fieldPath === 'triggerUuid') {
      if (!name(row.trigger_uuid)) return invalid();
      return { value: row.trigger_uuid, label: row.trigger_uuid };
    }
    if (selectedScript) {
      if (!name(row.id) || !name(row.name)) return invalid();
      return { value: { kind: 'preview', scriptName: selectedScript, previewName: row.name }, label: row.name };
    }
    if (input.product === 'pages') {
      if (!name(row.id) || !name(row.name)) return invalid();
      return { value: input.fieldPath === 'preparedNative.projectName' ? row.name : row.id, label: row.name };
    }
    if (!name(row.id) || !name(row.tag)) return invalid();
    return { value: input.fieldPath === 'providerEnvironment' ? { kind: 'script', scriptName: row.id } : row.tag, label: row.id };
  });
  if (selectedScript) rows.unshift({ value: { kind: 'script', scriptName: selectedScript }, label: selectedScript });
  const page = reply.resultInfo;
  let nextCursor: string | undefined;
  if (page !== undefined) {
    if (!isObject(page)) invalid();
    for (const key of ['page', 'per_page', 'total_count', 'total_pages']) {
      if (page[key] !== undefined && !Number.isSafeInteger(page[key])) invalid();
    }
    // Accounts omit total_pages; all collection metadata is optional in the vendor schema.
    const totalPages = page.total_pages ?? (typeof page.total_count === 'number' && typeof page.per_page === 'number' && page.per_page > 0
      ? Math.ceil(page.total_count / page.per_page) : undefined);
    if (typeof page.page === 'number' && typeof totalPages === 'number' && page.page < totalPages) nextCursor = String(page.page + 1);
  }
  return { options: options(rows, input.query), ...(nextCursor ? { nextCursor } : {}) };
}

export const targetOptionsRead = {
  title: 'Read Cloudflare target choices', execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
  scopes: ['global'], surfaces: ['cli', 'plugin'], placementBindings: [], dangerLevel: 'safe', readOnly: true,
  hostAccess: ['cloudflare-workers', 'cloudflare-pages', 'deploy.manage'],
  connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'deploy.manage' }], inputSchema,
  async run(value: JsonValue, context: PluginAccountActionContext) {
    if (!context.services.http) throw new PluginError({ code: 'client_required' });
    return read(value as unknown as Input, { http: context.services.http, signal: context.signal, now: () => Date.now() });
  },
} as const;

function draftProduct(draft: Readonly<Record<string, JsonValue>>): JsonValue | undefined {
  if (draft.product !== undefined) return draft.product;
  const environment = draft.providerEnvironment;
  if (!isObject(environment)) return undefined;
  if (typeof environment.scriptName === 'string') return 'workers';
  if (environment.kind === 'production' || environment.kind === 'preview') return 'pages';
  return undefined;
}

export const targetOptions: PluginDynamicResourceRuntime = {
  async read(options) {
    options.signal.throwIfAborted();
    const query = options.query;
    if (!query?.draftInput || !query.fieldPath) throw new PluginError({ code: 'invalid_parameters' });
    // The options owner has admitted this partial draft against its Action schema.
    const draft = query.draftInput as Readonly<Record<string, JsonValue>>;
    const input: Record<string, JsonValue> = { fieldPath: query.fieldPath };
    for (const key of ['credentialRef', 'credentialPrincipal', 'providerIdentity']) {
      if (draft[key] !== undefined) input[key] = draft[key];
    }
    const product = draftProduct(draft);
    if (product !== undefined) input.product = product;
    if (isObject(draft.providerEnvironment) && draft.providerEnvironment.scriptName !== undefined) {
      input.scriptName = draft.providerEnvironment.scriptName as JsonValue;
    }
    if (query.query !== undefined) input.query = query.query;
    if (query.cursor !== undefined) input.cursor = query.cursor;
    const result = await options.readAction({ pluginId, localId: 'target-options-read' }, input, { signal: options.signal });
    if (!result.ok) throw new PluginError({ code: 'errorCode' in result && typeof result.errorCode === 'string' ? result.errorCode : 'deployment_unavailable' });
    return JSON.stringify(result.result);
  },
  observe() { return { dispose() {} }; },
};

const choiceSchema: PluginJsonSchema = { anyOf: [{ type: 'string' }, { type: 'object' }] };
export const targetOptionInputTypes = {
  'target-choice': { title: 'Cloudflare target choice', semantic: 'cloudflare-target-choice',
    valueSchema: choiceSchema, options: { resource: 'target-options' } },
} as const;
export const targetOptionInputHints = { fields: [
  ...([['product', 'Product'], ['providerIdentity.providerAccountId', 'Cloudflare Account'],
    ['providerIdentity.providerResourceId', 'Project or Worker'], ['providerEnvironment', 'Environment'],
    ['preparedNative.projectName', 'Pages project name'], ['triggerUuid', 'Worker build trigger']] as const).map(([path, title]) => ({
      path, title, widget: 'select' as const, inputType: { pluginId, localId: 'target-choice' },
    })),
] } as const;
export const targetProductSchema = product;
