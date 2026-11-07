import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import { NPM_REGISTRY_PROFILE_ACTION_IDS_V1, NpmRegistryProfileActionInputSchemasV1 as inputs,
  NpmRegistryProfileActionOutputSchemasV1 as outputs } from '../npmRegistryProfileActionFamily.js';

const titles = {
  'plugins.npm_registry_profiles.list': 'List npm registry profiles',
  'plugins.npm_registry_profiles.add': 'Add npm registry profile',
  'plugins.npm_registry_profiles.update': 'Update npm registry profile',
  'plugins.npm_registry_profiles.remove': 'Remove npm registry profile',
  'plugins.npm_registry_profiles.login': 'Sign in to npm registry',
  'plugins.npm_registry_profiles.logout': 'Sign out of npm registry',
  'plugins.npm_registry_profiles.test': 'Test npm registry profile',
};
function createNpmRegistryProfileActionSpecsV1() {
  return NPM_REGISTRY_PROFILE_ACTION_IDS_V1.map((id): PreNormalizedActionSpec => ({
  id, title: titles[id], description: 'Manage the exact selected Machine’s revisioned npm registry profiles. Sign-in credentials are acquired privately by the answering app.',
  approval: { result: 'required' }, safety: id.endsWith('.remove') ? 'danger' : 'safe',
  ...(id === 'plugins.npm_registry_profiles.remove' ? { irreversible: true as const } : {}),
  ...(id.endsWith('.list') ? {} : { approvalPolicy: { retainUiFieldIntent: true } }),
  sideEffectClass: id.endsWith('.list') ? 'read' : 'write',
  requiredAuthority: 'account_automation', executionPlacement: 'client', placements: [],
  surfaces: { ui: true, agent: true, mcp: true, cli: true, voice: false, rpc: false },
  cli: { acceptsServerId: true, commands: [] },
  bindings: { mcpToolName: id.replaceAll('.', '_') }, inputSchema: inputs[id], outputSchema: outputs[id],
  inputHints: { fields: [
    { path: 'target', title: 'Exact Machine and Home identity', widget: 'json', required: true },
    ...(id.endsWith('.list') ? [] : [
      { path: 'profileId', title: 'Registry profile', widget: 'text' as const, required: true },
      { path: 'expectedRevision', title: 'Snapshot revision', widget: 'number' as const, required: true },
      { path: 'mutationId', title: 'Mutation identifier', widget: 'text' as const, required: true },
    ]),
    ...(['plugins.npm_registry_profiles.add', 'plugins.npm_registry_profiles.update'].includes(id)
      ? [{ path: 'profile', title: 'Registry profile settings', widget: 'json' as const, required: true }] : []),
  ] },
}));
}

export const NPM_REGISTRY_PROFILE_ACTION_SPECS_V1: ReturnType<typeof createNpmRegistryProfileActionSpecsV1> = lazyActionSpecArray(createNpmRegistryProfileActionSpecsV1);
