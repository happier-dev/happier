import { PluginError, projectActionFailureCauseV1, withActionFailureDiagnostic } from '@happier-dev/plugin-sdk/errors';
import { DeploymentTargetPreparationBaseV1ProtocolSchema, projectNativeJsonValueForTransport, type PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import { DeploymentTargetRoleInputProtocolSchemasV1, type DefinePluginInput, type DeploymentTargetRoleFailureV1, type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { createDeploymentTargetOptionsResource } from '@happier-dev/plugin-sdk/resources';
import { isObject } from '../connectedAccounts/probe.js';
import { request, requestAccounts, type DeploymentContext } from './deploymentHttp.js';
import { cloudflareHasNextPage, CloudflareProviderRefusal } from './cloudflareRoutes.js';
import { readWorkerScripts, resolveWorkerTag } from './workers.js';
import { cloudflareRoleSchema } from './targetSelection.js';

const pluginId = 'happier.deploy.cloudflare';
const text = { type: 'string', minLength: 1 } as const;
const base = DeploymentTargetPreparationBaseV1ProtocolSchema.jsonSchema;
const providerIdentity = { type: 'object', additionalProperties: false, properties: {
  providerAccountId: text, providerResourceId: text, providerEnvironment: text } } as const;
const product: PluginJsonSchema = { type: 'string', enum: ['workers', 'pages'] };
const inputSchema: PluginJsonSchema = { type: 'object', additionalProperties: false, properties: {
  credentialRef: base.properties!.credentialRef!, credentialPrincipal: base.properties!.credentialPrincipal!,
  product, providerIdentity, providerAccountId: base.properties!.providerAccountId!,
  resourceName: DeploymentTargetRoleInputProtocolSchemasV1.create.jsonSchema.properties!.resourceName!, scriptName: text, fieldPath: text, query: { type: 'string' }, cursor: { type: 'string', pattern: '^[1-9][0-9]*$' },
}, required: ['credentialRef', 'credentialPrincipal', 'fieldPath'] };
type Input = Readonly<{ product?: 'workers' | 'pages'; providerIdentity?: { providerAccountId?: string; providerResourceId?: string };
  providerAccountId?: string; resourceName?: string; scriptName?: string;
  fieldPath: string; query?: string; cursor?: string }>;
type Option = { value: JsonValue; label: string };
function invalid(): never { throw new PluginError({ code: 'provider_response_invalid' }); }
function missingDependency(requiredDraftPath: string): never {
  throw new PluginError({ code: 'missing_option_dependency', details: { requiredDraftPath } });
}
function refuse(failure: DeploymentTargetRoleFailureV1): never {
  throw withActionFailureDiagnostic(new PluginError({ code: failure.code, retryable: failure.retryable, details: { phase: failure.phase },
    failureCause: projectActionFailureCauseV1(failure, `deployment.cloudflare.${failure.phase}`) }),
  { phase: `deployment.cloudflare.${failure.phase}`, causeKind: 'native_failure', error: failure });
}
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
  if (input.fieldPath === 'providerIdentity.providerAccountId' || input.fieldPath === 'providerAccountId') {
    if (input.query) params.set('name', input.query);
    reply = await requestAccounts(context, params.size ? `?${params}` : '');
  } else if (input.product === 'pages' && input.fieldPath === 'providerEnvironment') {
    // Pages environments are fixed; a pre-Create draft names one before any Account is chosen.
    return { options: options([
      { value: { kind: 'native', selection: { kind: 'production' } }, label: 'Production' }, { value: { kind: 'native', selection: { kind: 'preview' } }, label: 'Preview' },
    ], input.query) };
  } else {
    const accountId = input.providerIdentity?.providerAccountId ?? input.providerAccountId;
    if (!accountId) missingDependency(input.fieldPath.startsWith('providerIdentity.') ? 'providerIdentity.providerAccountId' : 'providerAccountId');
    let path: string;
    if (input.fieldPath === 'triggerUuid') {
      const workerTag = input.providerIdentity?.providerResourceId ?? (input.scriptName
        ? await resolveWorkerTag(accountId, input.scriptName, context)
        : missingDependency(input.providerIdentity ? 'providerIdentity.providerResourceId' : 'providerEnvironment'));
      if (typeof workerTag !== 'string') refuse(workerTag);
      path = `/builds/workers/${encodeURIComponent(workerTag)}/triggers`;
    } else if (input.product === 'pages') {
      path = `/pages/projects${params.size ? `?${params}` : ''}`;
    } else if (input.product === 'workers') {
      if (input.fieldPath === 'providerEnvironment' && input.resourceName) return { options: options([
        { value: { kind: 'native', selection: { kind: 'script', scriptName: input.resourceName } }, label: input.resourceName },
      ], input.query) };
      selectedScript = input.fieldPath === 'providerEnvironment' ? input.scriptName : undefined;
      if (!selectedScript) {
        const scripts = await readWorkerScripts(accountId, context);
        if ('code' in scripts) refuse(scripts);
        return { options: options(scripts.map(({ scriptName, workerTag }) => ({ label: scriptName,
          value: input.fieldPath === 'providerEnvironment' ? { kind: 'native', selection: { kind: 'script', scriptName } } : workerTag })), input.query) };
      }
      if (input.query) params.set('name', input.query);
      path = `/workers/workers/${encodeURIComponent(selectedScript)}/previews${params.size ? `?${params}` : ''}`;
    } else return missingDependency('product');
    reply = await request(context, accountId, path, 'link');
  }
  if ('code' in reply) refuse(reply);
  if (!Array.isArray(reply.value)) invalid();
  const rows: Option[] = reply.value.map((row: unknown): Option => {
    if (!isObject(row)) return invalid();
    if (input.fieldPath === 'providerIdentity.providerAccountId' || input.fieldPath === 'providerAccountId') {
      if (!name(row.id) || !name(row.name)) return invalid();
      return { value: row.id, label: row.name };
    }
    if (input.fieldPath === 'triggerUuid') {
      if (!name(row.trigger_uuid)) return invalid();
      return { value: row.trigger_uuid, label: row.trigger_uuid };
    }
    if (selectedScript) {
      if (!name(row.id) || !name(row.name)) return invalid();
      return { value: { kind: 'native', selection: { kind: 'preview', scriptName: selectedScript, previewName: row.name } }, label: row.name };
    }
    if (input.product === 'pages') {
      if (!name(row.id) || !name(row.name)) return invalid();
      return { value: input.fieldPath === 'preparedNative.projectName' ? row.name : row.id, label: row.name };
    }
    return invalid();
  });
  let nextCursor: string | undefined;
  // Worker scripts and triggers are unpaged. Collection endpoints may omit all page metadata.
  if (input.fieldPath !== 'triggerUuid') {
    const page = Number(input.cursor ?? 1);
    try {
      if (cloudflareHasNextPage({ result: rows,
        ...(reply.resultInfo === undefined ? {} : { result_info: projectNativeJsonValueForTransport(reply.resultInfo) }),
      }, page, 'target options')) nextCursor = String(page + 1);
    } catch (error) {
      if (error instanceof CloudflareProviderRefusal) invalid();
      throw error;
    }
  }
  if (selectedScript) rows.unshift({ value: { kind: 'native', selection: { kind: 'script', scriptName: selectedScript } }, label: selectedScript });
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
  const carrier = draft.providerEnvironment;
  if (!isObject(carrier) || !isObject(carrier.selection)) return undefined;
  const environment = carrier.selection;
  if (typeof environment.scriptName === 'string') return 'workers';
  if (environment.kind === 'production' || environment.kind === 'preview') return 'pages';
  return undefined;
}

function targetOptionsFor(product?: 'workers' | 'pages') {
  return createDeploymentTargetOptionsResource({ pluginId, localId: 'target-options-read' }, 'deployment.cloudflare.options', draft => {
    const input: Record<string, JsonValue> = {};
    for (const key of ['providerIdentity', 'providerAccountId', 'resourceName']) {
      if (draft[key] !== undefined) input[key] = draft[key];
    }
    const selectedProduct = product ?? draftProduct(draft);
    if (selectedProduct !== undefined) input.product = selectedProduct;
    const carrier = draft.providerEnvironment;
    if (isObject(carrier) && isObject(carrier.selection) && typeof carrier.selection.scriptName === 'string') {
      input.scriptName = carrier.selection.scriptName;
    }
    return input;
  });
}

export const targetOptions = targetOptionsFor();
const resource = { source: 'dynamic', kind: 'config', contentType: 'application/json', scope: 'global',
  execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } } } as const;
export const targetOptionResources = {
  'target-options': { ...resource, runtime: targetOptions },
  'workers-target-options': { ...resource, runtime: targetOptionsFor('workers') },
  'pages-target-options': { ...resource, runtime: targetOptionsFor('pages') },
} satisfies NonNullable<DefinePluginInput['resources']>;

const choiceSchema: PluginJsonSchema = { anyOf: [{ type: 'string' }, { type: 'object' }] };
export const targetOptionInputTypes = {
  'new-pages-environment': { title: 'Cloudflare Pages environment', semantic: 'cloudflare-new-pages-environment',
    valueSchema: cloudflareRoleSchema(base, 'pages').properties!.providerEnvironment! },
  'target-choice': { title: 'Cloudflare target choice', semantic: 'cloudflare-target-choice',
    valueSchema: choiceSchema, options: { resource: 'target-options' } },
  'workers-target-choice': { title: 'Cloudflare Workers choice', semantic: 'cloudflare-workers-choice',
    valueSchema: choiceSchema, options: { resource: 'workers-target-options' } },
  'pages-target-choice': { title: 'Cloudflare Pages choice', semantic: 'cloudflare-pages-choice',
    valueSchema: choiceSchema, options: { resource: 'pages-target-options' } },
} as const;
const accountField = { path: 'providerIdentity.providerAccountId', title: 'Cloudflare Account', optionsDraftDependencies: [],
  required: true, widget: 'select', inputType: { pluginId, localId: 'target-choice' } } as const;
const environmentField = { path: 'providerEnvironment', title: 'Environment',
  optionsDraftDependencies: ['product', 'resourceName', 'providerEnvironment.selection.kind', 'providerEnvironment.selection.scriptName'],
  required: true, widget: 'select', inputType: { pluginId, localId: 'target-choice' } } as const;
const projectField = { path: 'preparedNative.projectName', title: 'Pages project name', widget: 'select',
  optionsDraftDependencies: ['product', 'providerEnvironment.selection.kind', 'providerEnvironment.selection.scriptName'],
  inputType: { pluginId, localId: 'target-choice' } } as const;
const workerTriggerField = { path: 'triggerUuid', title: 'Worker build trigger', widget: 'select',
  optionsDraftDependencies: ['providerIdentity.providerResourceId', 'providerEnvironment.selection.scriptName'], inputType: { pluginId, localId: 'target-choice' },
  requiredWhen: { op: 'and', all: [{ op: 'eq', path: 'providerEnvironment.selection.kind', value: 'script' },
    { op: 'not', predicate: { op: 'eq', path: 'sourceMethod', value: 'upload' } }] },
  visibleWhen: { op: 'and', all: [{ op: 'eq', path: 'providerEnvironment.selection.kind', value: 'script' },
    { op: 'not', predicate: { op: 'eq', path: 'sourceMethod', value: 'upload' } }] } } as const;
export const targetOptionInputHints = { fields: [
  accountField,
  { path: 'providerIdentity.providerResourceId', title: 'Project or Worker', required: true, widget: 'select',
    optionsDraftDependencies: ['product', 'providerEnvironment.selection.kind', 'providerEnvironment.selection.scriptName'],
    inputType: { pluginId, localId: 'target-choice' } },
  environmentField,
  { ...projectField, requiredWhen: { op: 'not', predicate: { op: 'truthy', path: 'providerEnvironment.selection.scriptName' } } },
  workerTriggerField,
] } as const;
export const targetProductSchema = product;

export function targetProductInputHints(product: 'workers' | 'pages') {
  // The product sheet selects native coordinates. Inspect resolves the exact comparison identity.
  const fields = [{ ...accountField, path: 'providerAccountId' }, ...(product === 'pages' ? [
    { ...projectField, required: true, optionsDraftDependencies: [] },
    { ...environmentField, optionsDraftDependencies: [projectField.path] },
  ] : [environmentField, workerTriggerField])];
  return { fields: fields.map(field => ({ ...field, inputType: { pluginId, localId: `${product}-target-choice` } })) };
}
