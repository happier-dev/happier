import * as z from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ProjectSetupSelectionV1Schema, projectSetupSelectionV1, type ProjectAcceptedSharedSetupV1, type ProjectSetupSelectionV1 } from '../../projects/projectSetupV1.js';
import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { ProjectManifestV1Schema, type ProjectCommandSourceV1, type ProjectManifestV1 } from './projectManifestV1.js';

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

const SUMMARY_KIND_OF_ROW_V1 = {
  login: 'toolchain', tool: 'devcontainer', ports: 'worktreePorts', env: 'environmentVariables',
  input: 'workspaceInputs', script: 'scripts', service: 'services',
} as const satisfies Record<Exclude<ProjectSharedSetupChangeRowV1['entry'], 'step'>, ProjectSetupSummaryV1[number]['kind']>;
const SUMMARY_KIND_ORDER_V1 = ProjectSetupSummaryKindV1Schema.options;

/** What taking a Source setup changes here, counted from the same rows its review lists (never the raw layer). */
function summarizeProjectSetupChangeV1(rows: readonly ProjectSharedSetupChangeRowV1[]): ProjectSetupSummaryV1 {
  const counts = new Map<ProjectSetupSummaryV1[number]['kind'], number>();
  for (const row of rows) {
    const kind = row.entry === 'step' ? (row.phase === 'setup' ? 'workspaceSetup' : 'workspaceTeardown') : SUMMARY_KIND_OF_ROW_V1[row.entry];
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return SUMMARY_KIND_ORDER_V1.flatMap(kind => counts.has(kind) ? [{ kind, count: counts.get(kind)! }] : []);
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
  const current: ProjectEffectiveDefinitionV1 = { effectiveManifest, origins };
  // The review compares these same two compositions: the accepted layers, then the Source's setup taken as the shared layer.
  const pendingSharedSetup = input.pendingSharedSetup ? {
    source: { id: input.pendingSharedSetup.source.id, name: input.pendingSharedSetup.source.name },
    setup: projectSetupSelectionV1(input.pendingSharedSetup.setup),
    summary: summarizeProjectSetupChangeV1(projectSharedSetupChangeRowsV1(current, resolveProjectDefinitionV1({
      repositoryManifest: input.repositoryManifest,
      acceptedSharedSetup: { ...input.pendingSharedSetup.setup, manifest: input.pendingSharedSetup.manifest },
      ...(input.setupOverrides ? { setupOverrides: input.setupOverrides } : {}),
    }))),
  } : undefined;
  if (!input.acceptedSharedSetup) return pendingSharedSetup ? { effectiveManifest, origins, pendingSharedSetup } : { effectiveManifest, origins };
  const sharedBasis = projectSetupSelectionV1(input.acceptedSharedSetup);
  return pendingSharedSetup ? { effectiveManifest, origins, sharedBasis, pendingSharedSetup } : { effectiveManifest, origins, sharedBasis };
}

type ProjectDeclarationChangeV1<T> =
  | Readonly<{ op: 'added'; after: T }>
  | Readonly<{ op: 'removed'; before: T }>
  | Readonly<{ op: 'changed'; before: T; after: T }>;
type ProjectChangeRowV1<Entry extends string, Value> = Readonly<{
  entry: Entry; key: string;
  origin: Readonly<{ before: ProjectDefinitionOriginV1 | null; after: ProjectDefinitionOriginV1 | null }>;
}> & ProjectDeclarationChangeV1<Value>;

/** Declaration edits only: captured login bytes and lifecycle consent remain preparation-owned. */
export type ProjectSharedSetupChangeRowV1 =
  | (ProjectChangeRowV1<'step', ProjectCommandSourceV1> & Readonly<{ phase: 'setup' | 'teardown' }>)
  | ProjectChangeRowV1<'login', NonNullable<ProjectManifestV1['toolchain']>>
  | ProjectChangeRowV1<'input', readonly string[]>
  | ProjectChangeRowV1<'tool', NonNullable<ProjectManifestV1['devcontainer']>>
  | ProjectChangeRowV1<'env', NonNullable<ProjectManifestV1['environmentVariables']>[number]>
  | ProjectChangeRowV1<'ports', NonNullable<ProjectManifestV1['worktreePorts']>>
  | ProjectChangeRowV1<'script', NonNullable<ProjectManifestV1['scripts']>[string]>
  | ProjectChangeRowV1<'service', NonNullable<ProjectManifestV1['services']>[string]>;

function declarationChange<T>(before: T | undefined, after: T | undefined): ProjectDeclarationChangeV1<T> | null {
  if (before === undefined) return after === undefined ? null : { op: 'added', after };
  if (after === undefined) return { op: 'removed', before };
  return createCanonicalJsonSigningInput(before) === createCanonicalJsonSigningInput(after)
    ? null : { op: 'changed', before, after };
}

function namedDeclarations<T>(before: Iterable<readonly [string, T]>, after: Iterable<readonly [string, T]>) {
  const previous = new Map(before);
  const next = new Map(after);
  return [...new Set([...previous.keys(), ...next.keys()])].sort().map(key => ({
    key, before: previous.get(key), after: next.get(key),
  }));
}

/**
 * Project the review owner's effective values; never compare raw publication layers in a consumer.
 * Ordered setup/teardown commands use their position. Named declarations use their identity.
 * Origins and publication revisions alone produce no rows. Ports describe declarations, never
 * assigned values. These rows do not decide whether consent changed or reconstruct login bytes.
 */
export function projectSharedSetupChangeRowsV1(
  before: ProjectEffectiveDefinitionV1, after: ProjectEffectiveDefinitionV1,
): readonly ProjectSharedSetupChangeRowV1[] {
  const rows: ProjectSharedSetupChangeRowV1[] = [];
  const previous = before.effectiveManifest;
  const next = after.effectiveManifest;
  const previousOrigin = createProjectDefinitionOriginLookupV1(before);
  const nextOrigin = createProjectDefinitionOriginLookupV1(after);
  const origin = (path: readonly string[]) => ({ before: previousOrigin(path), after: nextOrigin(path) });
  for (const phase of ['setup', 'teardown'] as const) {
    const previousCommands = previous?.workspace?.[phase] ?? [];
    const nextCommands = next?.workspace?.[phase] ?? [];
    for (let index = 0; index < Math.max(previousCommands.length, nextCommands.length); index++) {
      const change = declarationChange(previousCommands[index], nextCommands[index]);
      if (change) rows.push({ entry: 'step', phase, key: `${phase}:${index}`, ...change, origin: origin(['workspace', phase]) });
    }
  }
  const login = declarationChange(previous?.toolchain, next?.toolchain);
  if (login) rows.push({ entry: 'login', key: 'toolchain', ...login, origin: origin(['toolchain']) });
  const previousInputs = previous?.workspace?.setupInputs;
  const nextInputs = next?.workspace?.setupInputs;
  const inputs = declarationChange(previousInputs?.length ? previousInputs : undefined, nextInputs?.length ? nextInputs : undefined);
  if (inputs) rows.push({ entry: 'input', key: 'setupInputs', ...inputs, origin: origin(['workspace', 'setupInputs']) });
  const tool = declarationChange(previous?.devcontainer, next?.devcontainer);
  if (tool) rows.push({ entry: 'tool', key: 'devcontainer', ...tool, origin: origin(['devcontainer']) });
  for (const declaration of namedDeclarations(
    (previous?.environmentVariables ?? []).map(value => [value.name, value] as const),
    (next?.environmentVariables ?? []).map(value => [value.name, value] as const),
  )) {
    const change = declarationChange(declaration.before, declaration.after);
    if (change) rows.push({ entry: 'env', key: declaration.key, ...change, origin: origin(['environmentVariables', declaration.key]) });
  }
  const ports = declarationChange(previous?.worktreePorts, next?.worktreePorts);
  if (ports) rows.push({ entry: 'ports', key: 'worktreePorts', ...ports, origin: origin(['worktreePorts']) });
  for (const declaration of namedDeclarations(Object.entries(previous?.scripts ?? {}), Object.entries(next?.scripts ?? {}))) {
    const change = declarationChange(declaration.before, declaration.after);
    if (change) rows.push({ entry: 'script', key: declaration.key, ...change, origin: origin(['scripts', declaration.key]) });
  }
  for (const declaration of namedDeclarations(Object.entries(previous?.services ?? {}), Object.entries(next?.services ?? {}))) {
    const change = declarationChange(declaration.before, declaration.after);
    if (change) rows.push({ entry: 'service', key: declaration.key, ...change, origin: origin(['services', declaration.key]) });
  }
  return rows;
}
