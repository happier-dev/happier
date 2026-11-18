import * as z from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ProjectSetupSelectionV1Schema, projectSetupSelectionV1, type ProjectAcceptedSharedSetupV1, type ProjectSetupSelectionV1 } from '../../projects/projectSetupV1.js';
import { ProjectManifestV1Schema, type ProjectManifestV1 } from './projectManifestV1.js';

export const ProjectDefinitionOriginV1Schema = z.strictObject({
  path: z.array(z.string()), layer: z.enum(['repository', 'shared', 'personal']), overridden: z.boolean(),
});
export type ProjectDefinitionOriginV1 = z.infer<typeof ProjectDefinitionOriginV1Schema>;
const ProjectSetupSummaryKindV1Schema = z.enum([
  'toolchain', 'devcontainer', 'worktreePorts', 'environmentVariables',
  'workspaceSetup', 'workspaceTeardown', 'workspaceInputs', 'scripts', 'services',
]);
const ProjectSetupSummaryEntryV1Schema = z.strictObject({
  kind: ProjectSetupSummaryKindV1Schema, count: z.number().check(z.int(), z.nonnegative()),
});
export const ProjectSetupSummaryV1Schema = z.array(ProjectSetupSummaryEntryV1Schema);
export type ProjectSetupSummaryV1 = z.infer<typeof ProjectSetupSummaryV1Schema>;
const ProjectPendingSharedSetupSourceV1Schema = z.strictObject({
  id: z.string().check(z.trim(), z.minLength(1)), name: z.string().check(z.trim(), z.minLength(1)),
});
const ProjectPendingSharedSetupV1Schema = z.strictObject({
  source: ProjectPendingSharedSetupSourceV1Schema,
  setup: ProjectSetupSelectionV1Schema,
  summary: ProjectSetupSummaryV1Schema,
});
export type ProjectPendingSharedSetupV1 = z.infer<typeof ProjectPendingSharedSetupV1Schema>;
export const ProjectEffectiveDefinitionV1Schema = lazyZodSchema(() => z.strictObject({
  effectiveManifest: z.nullable(ProjectManifestV1Schema), origins: z.array(ProjectDefinitionOriginV1Schema),
  sharedBasis: z.optional(ProjectSetupSelectionV1Schema),
  pendingSharedSetup: z.optional(ProjectPendingSharedSetupV1Schema),
}));
export type ProjectEffectiveDefinitionV1 = z.infer<typeof ProjectEffectiveDefinitionV1Schema>;

/**
 * The layer that decides one declaration path: the deepest non-overridden origin at or above it.
 * Scripts rows and update reviews read origins through this one lookup.
 */
export function createProjectDefinitionOriginLookupV1(definition: Pick<ProjectEffectiveDefinitionV1, 'origins'>) {
  const index = new Map(definition.origins.filter(origin => !origin.overridden)
    .map(origin => [JSON.stringify(origin.path), origin] as const));
  return (path: readonly string[]): ProjectDefinitionOriginV1 | null => {
    for (let length = path.length; length > 0; length--) {
      const origin = index.get(JSON.stringify(path.slice(0, length)));
      if (origin) return origin;
    }
    return null;
  };
}

function summarizeProjectManifestV1(manifest: ProjectManifestV1): ProjectSetupSummaryV1 {
  const summary: ProjectSetupSummaryV1 = [];
  const add = (kind: ProjectSetupSummaryV1[number]['kind'], count: number) => {
    if (count > 0) summary.push({ kind, count });
  };
  add('toolchain', manifest.toolchain ? 1 : 0);
  add('devcontainer', manifest.devcontainer ? 1 : 0);
  add('worktreePorts', manifest.worktreePorts ? 1 : 0);
  add('environmentVariables', manifest.environmentVariables?.length ?? 0);
  add('workspaceSetup', manifest.workspace?.setup?.length ?? 0);
  add('workspaceTeardown', manifest.workspace?.teardown?.length ?? 0);
  add('workspaceInputs', manifest.workspace?.setupInputs?.length ?? 0);
  add('scripts', Object.keys(manifest.scripts ?? {}).length);
  add('services', Object.keys(manifest.services ?? {}).length);
  return summary;
}

/** Ordered authored layers, never execution placement, private bindings or runtime assignments. */
export function resolveProjectDefinitionV1(input: Readonly<{
  repositoryManifest: ProjectManifestV1 | null;
  acceptedSharedSetup?: ProjectAcceptedSharedSetupV1;
  setupOverrides?: ProjectManifestV1;
  pendingSharedSetup?: Readonly<{
    source: Readonly<{ id: string; name: string }>;
    setup: ProjectSetupSelectionV1;
    manifest: ProjectManifestV1;
  }>;
}>): ProjectEffectiveDefinitionV1 {
  let effectiveManifest: ProjectManifestV1 | null = null;
  const origins: ProjectDefinitionOriginV1[] = [];
  const currentOrigins = new Map<string, number>();
  function record(path: string[], layer: ProjectDefinitionOriginV1['layer'], clear = false) {
    const key = JSON.stringify(path);
    if (clear) for (const [priorKey, index] of currentOrigins) {
      const prior = origins[index]!;
      if (path.every((part, i) => prior.path[i] === part)) {
        prior.overridden = true;
        currentOrigins.delete(priorKey);
      }
    }
    const prior = currentOrigins.get(key);
    if (prior !== undefined) origins[prior]!.overridden = true;
    currentOrigins.set(key, origins.length);
    origins.push({ path, layer, overridden: false });
  }
  function entryOrigins(field: string, keys: string[], layer: ProjectDefinitionOriginV1['layer']) {
    if (!keys.length) record([field], layer, true);
    else {
      const cleared = currentOrigins.get(JSON.stringify([field]));
      if (cleared !== undefined) { origins[cleared]!.overridden = true; currentOrigins.delete(JSON.stringify([field])); }
      for (const key of keys) record([field, key], layer);
    }
  }
  for (const [layer, manifest] of [
    ['repository', input.repositoryManifest], ['shared', input.acceptedSharedSetup?.manifest], ['personal', input.setupOverrides],
  ] as const) {
    if (!manifest) continue;
    const previous: ProjectManifestV1 = effectiveManifest ?? { version: 1 };
    effectiveManifest = { ...previous, ...manifest,
      ...(manifest.workspace !== undefined ? { workspace: { ...previous.workspace, ...manifest.workspace } } : {}),
      ...(manifest.scripts !== undefined ? { scripts: Object.keys(manifest.scripts).length ? { ...previous.scripts, ...manifest.scripts } : {} } : {}),
      ...(manifest.services !== undefined ? { services: Object.keys(manifest.services).length ? { ...previous.services, ...manifest.services } : {} } : {}),
      ...(manifest.environmentVariables !== undefined ? { environmentVariables: manifest.environmentVariables.length
        ? [...new Map([...(previous.environmentVariables ?? []), ...manifest.environmentVariables].map(requirement => [requirement.name, requirement])).values()]
        : [] } : {}),
    };
    for (const field of Object.keys(manifest)) {
      if (field === 'version') continue;
      if (field === 'workspace') for (const name of Object.keys(manifest.workspace ?? {})) record(['workspace', name], layer);
      else if (field === 'scripts' || field === 'services') entryOrigins(field, Object.keys(manifest[field]!), layer);
      else if (field === 'environmentVariables') {
        entryOrigins(field, manifest.environmentVariables!.map(requirement => requirement.name), layer);
      } else record([field], layer);
    }
  }
  // Individually valid layers can conflict after keyed entries and port policy merge.
  if (effectiveManifest && !ProjectManifestV1Schema.safeParse(effectiveManifest).success) {
    throw Object.assign(new Error('invalid_manifest'), { code: 'invalid_manifest' });
  }
  const pendingSharedSetup = input.pendingSharedSetup ? {
    source: { id: input.pendingSharedSetup.source.id, name: input.pendingSharedSetup.source.name },
    setup: projectSetupSelectionV1(input.pendingSharedSetup.setup),
    summary: summarizeProjectManifestV1(input.pendingSharedSetup.manifest),
  } : undefined;
  if (!input.acceptedSharedSetup) return pendingSharedSetup ? { effectiveManifest, origins, pendingSharedSetup } : { effectiveManifest, origins };
  const sharedBasis = projectSetupSelectionV1(input.acceptedSharedSetup);
  return pendingSharedSetup ? { effectiveManifest, origins, sharedBasis, pendingSharedSetup } : { effectiveManifest, origins, sharedBasis };
}
