import * as z from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ProjectDefinitionOriginV1Schema, type ProjectEffectiveDefinitionV1 } from './projectDefinitionCompositionV1.js';
import { ProjectManifestV1Schema, type ProjectManifestV1 } from './projectManifestV1.js';

/** One declaration a shared setup can carry, and the layer that decides it today. */
export const ProjectSetupExportUnitV1Schema = lazyZodSchema(() => z.strictObject({
  path: z.array(z.string().check(z.minLength(1))).check(z.minLength(1), z.maxLength(2)),
  layer: ProjectDefinitionOriginV1Schema.shape.layer,
}));
export type ProjectSetupExportUnitV1 = z.infer<typeof ProjectSetupExportUnitV1Schema>;
export type ProjectSetupExportPathV1 = ProjectSetupExportUnitV1['path'];

/** What `projects.inspect` returns for an export demand: the choices, the chosen subset and its exact bytes. */
export const ProjectSetupExportV1Schema = lazyZodSchema(() => z.strictObject({
  units: z.array(ProjectSetupExportUnitV1Schema),
  selected: z.array(ProjectSetupExportUnitV1Schema.shape.path),
  manifest: ProjectManifestV1Schema,
  bytes: z.string(),
}));
export type ProjectSetupExportV1 = z.infer<typeof ProjectSetupExportV1Schema>;

const KEYED_FIELDS = new Set(['workspace', 'scripts', 'services', 'environmentVariables']);

function declares(manifest: ProjectManifestV1, path: readonly string[]): boolean {
  const [field, key] = path;
  if (field === undefined || field === 'version' || field === '$schema') return false;
  const value = (manifest as Record<string, unknown>)[field];
  if (value === undefined) return false;
  if (!KEYED_FIELDS.has(field)) return key === undefined;
  if (key === undefined) return false;
  if (field === 'environmentVariables') return (value as NonNullable<ProjectManifestV1['environmentVariables']>).some(entry => entry.name === key);
  return Object.hasOwn(value as Record<string, unknown>, key) && (value as Record<string, unknown>)[key] !== undefined;
}

/**
 * The declarations a share can carry, in the composed definition's order, each with its deciding layer.
 * A cleared collection (an explicit empty list) is not a declaration to carry.
 */
export function listProjectSetupExportUnitsV1(definition: Pick<ProjectEffectiveDefinitionV1, 'effectiveManifest' | 'origins'>): ProjectSetupExportUnitV1[] {
  const manifest = definition.effectiveManifest;
  if (!manifest) return [];
  return definition.origins.filter(origin => !origin.overridden && declares(manifest, origin.path))
    .map(origin => ({ path: [...origin.path], layer: origin.layer }));
}

/** Plan A §2: the default carries the shared copy and personal changes; repository entries are a deliberate choice. */
export function defaultProjectSetupExportSelectionV1(units: readonly ProjectSetupExportUnitV1[]): ProjectSetupExportPathV1[] {
  return units.filter(unit => unit.layer !== 'repository').map(unit => [...unit.path]);
}

/** Builds the shared manifest from selected declarations only: never runtime assignments, bindings or values. */
export function selectProjectSetupExportV1(manifest: ProjectManifestV1, selected: readonly ProjectSetupExportPathV1[]): ProjectManifestV1 {
  const out: Record<string, unknown> = { version: 1 };
  for (const path of selected) {
    if (!declares(manifest, path)) continue;
    const [field, key] = path as [keyof ProjectManifestV1 & string, string | undefined];
    if (key === undefined) { out[field] = manifest[field]; continue; }
    if (field === 'environmentVariables') {
      const requirement = manifest.environmentVariables!.find(entry => entry.name === key)!;
      out[field] = [...(out[field] as unknown[] | undefined ?? []), requirement];
      continue;
    }
    out[field] = { ...(out[field] as Record<string, unknown> | undefined), [key]: (manifest[field] as Record<string, unknown>)[key] };
  }
  return ProjectManifestV1Schema.parse(out);
}

/** The exact bytes a person inspects before sharing: the `.happier/project.json` form. */
export function formatProjectSetupExportBytesV1(manifest: ProjectManifestV1): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** One export decision for the share sheet and for agents: the default subset unless a selection is given. */
export function projectSetupExportV1(definition: Pick<ProjectEffectiveDefinitionV1, 'effectiveManifest' | 'origins'>,
  selection?: readonly ProjectSetupExportPathV1[]): ProjectSetupExportV1 {
  const units = listProjectSetupExportUnitsV1(definition);
  const selected = selection ? selection.map(path => [...path]) : defaultProjectSetupExportSelectionV1(units);
  const manifest = selectProjectSetupExportV1(definition.effectiveManifest ?? { version: 1 }, selected);
  return { units, selected, manifest, bytes: formatProjectSetupExportBytesV1(manifest) };
}
