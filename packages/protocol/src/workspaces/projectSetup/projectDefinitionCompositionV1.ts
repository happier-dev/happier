import * as z from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ProjectSetupSelectionV1Schema, type ProjectAcceptedSharedSetupV1 } from '../../projects/projectSetupV1.js';
import { ProjectManifestV1Schema, type ProjectManifestV1 } from './projectManifestV1.js';

export const ProjectDefinitionOriginV1Schema = z.strictObject({
  path: z.array(z.string()), layer: z.enum(['repository', 'shared', 'personal']), overridden: z.boolean(),
});
export type ProjectDefinitionOriginV1 = z.infer<typeof ProjectDefinitionOriginV1Schema>;
export const ProjectEffectiveDefinitionV1Schema = lazyZodSchema(() => z.strictObject({
  effectiveManifest: z.nullable(ProjectManifestV1Schema), origins: z.array(ProjectDefinitionOriginV1Schema),
  sharedBasis: z.optional(ProjectSetupSelectionV1Schema),
}));
export type ProjectEffectiveDefinitionV1 = z.infer<typeof ProjectEffectiveDefinitionV1Schema>;

/** Ordered authored layers, never execution placement, private bindings or runtime assignments. */
export function resolveProjectDefinitionV1(input: Readonly<{
  repositoryManifest: ProjectManifestV1 | null;
  acceptedSharedSetup?: ProjectAcceptedSharedSetupV1;
  setupOverrides?: ProjectManifestV1;
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
  if (!input.acceptedSharedSetup) return { effectiveManifest, origins };
  const { manifest: _sharedManifest, ...sharedBasis } = input.acceptedSharedSetup;
  return { effectiveManifest, origins, sharedBasis };
}
