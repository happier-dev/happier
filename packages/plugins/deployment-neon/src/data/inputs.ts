import { withActionFailureDiagnostic } from '@happier-dev/plugin-sdk/errors';
import { PluginError, type DefinePluginInput, type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginDynamicResourceRuntime } from '@happier-dev/plugin-sdk/resources';
import { DeploymentTargetPreparationBaseV1ProtocolSchema } from '@happier-dev/plugin-sdk/protocol';

const pluginId = 'happier.deploy.neon';
const execution = { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } } as const;
function record(value: unknown): value is Record<string, JsonValue> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
const runtime: PluginDynamicResourceRuntime = {
  async read(options) {
    const draft = options.query?.draftInput;
    if (!record(draft)) throw new PluginError({ code: 'invalid_parameters' });
    const field = options.query?.fieldPath;
    const localId = field === 'regionId' ? 'provision-options-read' : field === 'projectId' || field === 'branchId' ? 'projects-list-read' : null;
    if (!localId) return JSON.stringify({ options: [] });
    if (!draft.providerAccountId) {
      throw new PluginError({ code: 'missing_option_dependency', details: { requiredDraftPath: 'providerAccountId' } });
    }
    if (field === 'branchId' && typeof draft.projectId !== 'string') {
      throw new PluginError({ code: 'missing_option_dependency', details: { requiredDraftPath: 'projectId' } });
    }
    // Pass only the canonical custody and this read's own operands. Create fields never leak into a read Action.
    const custody = Object.fromEntries(Object.keys(DeploymentTargetPreparationBaseV1ProtocolSchema.jsonSchema.properties ?? {})
      .flatMap(key => draft[key] === undefined ? [] : [[key, draft[key]!]]));
    // Initial choices spend the read Action's own purpose; a linked target keeps its recorded principal.
    const principal = custody.credentialPrincipal;
    if (!custody.targetLinkId && record(principal) && record(principal.purpose)) {
      custody.credentialPrincipal = { ...principal, purpose: { ...principal.purpose, consumer: { pluginId, localId } } };
    }
    const result = await options.readAction({ pluginId, localId }, { ...custody,
      ...(field === 'branchId' ? { projectId: draft.projectId!, includeBranches: true, ...(options.query?.cursor ? { cursor: options.query.cursor } : {}) } : {}),
      ...(field === 'projectId' && options.query?.query ? { search: options.query.query } : {}),
      ...(field === 'projectId' && options.query?.cursor ? { cursor: options.query.cursor } : {}) }, { signal: options.signal });
    if (!result.ok) throw withActionFailureDiagnostic(new PluginError({ code: 'errorCode' in result && typeof result.errorCode === 'string' ? result.errorCode : 'deployment_unavailable' }), { phase: 'deployment.neon.options', causeKind: 'native_failure', error: result });
    const value = result.result;
    if (!record(value)) throw new PluginError({ code: 'provider_response_invalid' });
    const rows = field === 'regionId' ? value.regions : field === 'branchId' ? value.branches : value.projects;
    if (!Array.isArray(rows)) throw new PluginError({ code: 'provider_response_invalid' });
    return JSON.stringify({ options: rows.flatMap(row => record(row) ? [{ value: field === 'regionId' ? row.id : field === 'branchId' ? row.branchId : row.providerProjectId,
      label: field === 'regionId' ? row.title : row.name }] : []), ...(typeof value.nextCursor === 'string' ? { nextCursor: value.nextCursor } : {}) });
  },
  observe: () => ({ dispose() {} }),
};
export const dataInputResources = { 'input-options': { source: 'dynamic', kind: 'config', scope: 'global', execution,
  contentType: 'application/json', runtime } } satisfies NonNullable<DefinePluginInput['resources']>;
export const dataInputTypes = {
  project: { title: 'Neon project', semantic: 'neonProject', valueSchema: { type: 'string', minLength: 1 }, options: { resource: 'input-options' } },
  branch: { title: 'Neon branch', semantic: 'neonBranch', valueSchema: { type: 'string', minLength: 1 }, options: { resource: 'input-options' } },
  region: { title: 'Neon region', semantic: 'neonRegion', valueSchema: { type: 'string', minLength: 1 }, options: { resource: 'input-options' } },
} satisfies NonNullable<DefinePluginInput['inputTypes']>;
export const dataInputHints = {
  account: { path: 'providerAccountId', title: 'Organization ID', widget: 'text', required: true },
  project: { path: 'projectId', title: 'Project', widget: 'select', required: true, inputType: { pluginId, localId: 'project' } },
  branch: { path: 'branchId', title: 'Branch', widget: 'select', required: true, inputType: { pluginId, localId: 'branch' } },
  region: { path: 'regionId', title: 'Region', widget: 'select', required: true, inputType: { pluginId, localId: 'region' } },
  save: [
    { path: 'id', title: 'Saved secret kind', widget: 'text', defaultValue: 'database', disabledWhen: { path: 'id', op: 'truthy' } },
    { path: 'purpose', title: 'Secret purpose', widget: 'text', defaultValue: 'data.connection', disabledWhen: { path: 'purpose', op: 'truthy' } },
    { path: 'audience', title: 'Secret audience', widget: 'json', required: true },
    { path: 'labels.DATABASE_URL', title: 'Application connection label', widget: 'text', required: true },
    { path: 'labels.DIRECT_URL', title: 'Migration connection label', widget: 'text', required: true },
    { path: 'database', title: 'Database name', widget: 'text', required: true },
    { path: 'role', title: 'Database role', widget: 'text', required: true },
    { path: 'previous', title: 'Previous save', widget: 'json', visibleWhen: { path: 'previous', op: 'truthy' }, disabledWhen: { path: 'previous', op: 'truthy' } },
  ],
} as const;
