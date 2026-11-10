import { PluginError, type DefinePluginInput, type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginDynamicResourceRuntime } from '@happier-dev/plugin-sdk/resources';
import { DeploymentTargetPreparationBaseV1ProtocolSchema } from '@happier-dev/plugin-sdk/protocol';
import { selectionSchema } from './schemas.js';

const pluginId = 'happier.deploy.supabase';
const execution = { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } } as const;
function record(value: unknown): value is Record<string, JsonValue> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
const runtime: PluginDynamicResourceRuntime = {
  async read(options) {
    const draft = options.query?.draftInput;
    if (!record(draft)) throw new PluginError({ code: 'invalid_parameters' });
    const field = options.query?.fieldPath;
    const localId = field === 'regionSelection' ? 'provision-options' : field === 'projectRef' ? 'projects-list' : null;
    if (!localId || !draft.providerAccountId) return JSON.stringify({ options: [] });
    const custody = Object.fromEntries(Object.keys(DeploymentTargetPreparationBaseV1ProtocolSchema.jsonSchema.properties ?? {})
      .flatMap(key => draft[key] === undefined ? [] : [[key, draft[key]!]]));
    // Initial choices spend the read Action's own purpose; a linked target keeps its recorded principal.
    const principal = custody.credentialPrincipal;
    if (!custody.targetLinkId && record(principal) && record(principal.purpose)) {
      custody.credentialPrincipal = { ...principal, purpose: { ...principal.purpose, consumer: { pluginId, localId } } };
    }
    const result = await options.readAction({ pluginId, localId }, { ...custody,
      ...(field === 'regionSelection' && typeof draft.desiredInstanceSize === 'string' ? { desiredInstanceSize: draft.desiredInstanceSize } : {}) },
      { signal: options.signal });
    if (!result.ok) throw new PluginError({ code: 'errorCode' in result && typeof result.errorCode === 'string' ? result.errorCode : 'deployment_unavailable' });
    const value = result.result;
    if (!record(value)) throw new PluginError({ code: 'provider_response_invalid' });
    const rows = field === 'regionSelection' ? value.regions : value.projects;
    if (!Array.isArray(rows)) throw new PluginError({ code: 'provider_response_invalid' });
    return JSON.stringify({ options: rows.flatMap(row => record(row) && row.status !== 'unavailable'
      ? [{ value: field === 'regionSelection' ? { type: row.type, code: row.code } : row.ref, label: row.name }] : []) });
  },
  observe: () => ({ dispose() {} }),
};
export const dataInputResources = { 'input-options': { source: 'dynamic', kind: 'config', scope: 'global', execution,
  contentType: 'application/json', runtime } } satisfies NonNullable<DefinePluginInput['resources']>;
export const dataInputTypes = {
  project: { title: 'Supabase project', semantic: 'supabaseProject', valueSchema: { type: 'string', minLength: 1 }, options: { resource: 'input-options' } },
  region: { title: 'Supabase region', semantic: 'supabaseRegion', valueSchema: selectionSchema.jsonSchema,
    options: { resource: 'input-options' } },
} satisfies NonNullable<DefinePluginInput['inputTypes']>;
export const dataInputHints = {
  account: { path: 'providerAccountId', title: 'Organization slug', widget: 'text', required: true },
  project: { path: 'projectRef', title: 'Project', widget: 'select', required: true, inputType: { pluginId, localId: 'project' } },
  region: { path: 'regionSelection', title: 'Region', widget: 'select', required: true, inputType: { pluginId, localId: 'region' } },
  password: { path: 'password', title: 'Database password', widget: 'select', required: true, inputType: { hostType: 'savedSecretReference' } },
  save: [
    { path: 'id', title: 'Saved secret kind', widget: 'text', defaultValue: 'database', disabledWhen: { path: 'id', op: 'truthy' } },
    { path: 'purpose', title: 'Secret purpose', widget: 'text', defaultValue: 'data.connection', disabledWhen: { path: 'purpose', op: 'truthy' } },
    { path: 'audience', title: 'Secret audience', widget: 'json', required: true },
    { path: 'secrets.DATABASE_URL.label', title: 'Application connection label', widget: 'text', required: true },
    { path: 'secrets.DIRECT_URL.label', title: 'Migration connection label', widget: 'text', required: true },
    { path: 'previous', title: 'Previous save', widget: 'json', visibleWhen: { path: 'previous', op: 'truthy' }, disabledWhen: { path: 'previous', op: 'truthy' } },
  ],
} as const;

export const dataActionInputHints = {
  'projects-list': { fields: [dataInputHints.account] },
  'provision-options': { fields: [dataInputHints.account] },
  'projects-link': { fields: [dataInputHints.account, dataInputHints.project] },
  'projects-provision': { fields: [dataInputHints.account, dataInputHints.region, dataInputHints.password] },
  'connections-save': { fields: [...dataInputHints.save, { ...dataInputHints.password, required: false }] },
  'branches-list': { fields: [] },
  'branches-delete': { fields: [] },
  'branches-create': { fields: [{ path: 'withData', title: 'Copy production data', widget: 'boolean', defaultValue: false,
    disabledWhen: { op: 'not', predicate: { path: 'withData', op: 'truthy' } } }] },
} as const;
