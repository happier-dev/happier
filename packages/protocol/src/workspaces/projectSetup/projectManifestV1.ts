import { lazyZodSchema } from '../../lazyZodSchema.js';
import * as z from '../../zodRuntimePolicy.js';

import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { PluginContributionIdentityV1Schema } from '../../plugins/contributionIdentity.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { EnvVarRequirementSchema } from '../../profiles/environmentVariables.js';
import { ProjectMemoryDemandV1Schema } from './projectMemoryDemandV1.js';
import { ProjectWorktreePortSlotsV1Schema } from './worktreePortsV1.js';

export { ProjectMemoryDemandV1Schema, type ProjectMemoryDemandV1 } from './projectMemoryDemandV1.js';

const nonempty = z.string().check(z.minLength(1));
export const ProjectNativeFilePathV1Schema = nonempty.check(z.regex(
  /^(?![\s\S]*\u0000)(?![\\/]|[a-zA-Z]:|~[\\/])(?!\.\.(?:[\\/]|$))(?![\s\S]*[\\/]\.\.(?:[\\/]|$))[\s\S]+$/u,
  'Native paths must stay within the project root',
));
const containedPath = ProjectNativeFilePathV1Schema;
const adapter = asProtocolZod(PluginContributionIdentityV1Schema);

export const ProjectNativeRefV1Schema = z.union([
  z.strictObject({ kind: z.literal('native'), tool: z.enum(['package_script', 'mise', 'make', 'just', 'taskfile', 'turbo', 'compose', 'procfile', 'devbox', 'devenv', 'flox']), file: containedPath, target: nonempty }),
  z.strictObject({ kind: z.literal('pluginNative'), adapter, file: containedPath, target: nonempty }),
]);
export type ProjectNativeRefV1 = z.infer<typeof ProjectNativeRefV1Schema>;

/** Contained selected execution bytes, never a workspace-wide file inventory. */
export const ProjectExecutionInputV1Schema = z.strictObject({
  file: ProjectNativeFilePathV1Schema,
  hash: z.string().check(z.regex(/^[a-f0-9]{64}$/u)),
});
export type ProjectExecutionInputV1 = z.infer<typeof ProjectExecutionInputV1Schema>;

/**
 * A checkout file a reviewed command line runs: its bytes, its absence, a folder operand,
 * or the target of a link out of the checkout. Computed on the Machine holding the checkout.
 */
export const ProjectCommandFileFactV1Schema = z.union([
  z.strictObject({ file: ProjectNativeFilePathV1Schema, digest: z.string().check(z.regex(/^[a-f0-9]{64}$/u)) }),
  z.strictObject({ file: ProjectNativeFilePathV1Schema, absent: z.literal(true) }),
  z.strictObject({ file: ProjectNativeFilePathV1Schema, directory: z.literal(true) }),
  z.strictObject({ file: ProjectNativeFilePathV1Schema, linkTarget: nonempty }),
]);
export type ProjectCommandFileFactV1 = z.infer<typeof ProjectCommandFileFactV1Schema>;

export const ProjectCommandSourceV1Schema = z.union([
  ProjectNativeRefV1Schema,
  z.strictObject({ kind: z.literal('command'), command: nonempty, cwd: z.optional(nonempty), platforms: z.optional(z.array(z.enum(['darwin', 'linux', 'windows']))) }),
]);
export type ProjectCommandSourceV1 = z.infer<typeof ProjectCommandSourceV1Schema>;

export const ProjectToolchainSelectionV1Schema = z.union([
  z.strictObject({ kind: z.literal('host') }),
  z.strictObject({ kind: z.literal('toolchain'), tool: z.enum(['mise', 'devbox', 'devenv', 'flox', 'nix_flake']), configPath: z.optional(containedPath) }),
  z.strictObject({ kind: z.literal('pluginToolchain'), adapter, configPath: z.optional(containedPath) }),
]);
export type ProjectToolchainSelectionV1 = z.infer<typeof ProjectToolchainSelectionV1Schema>;

export const ProjectDevcontainerSelectionV1Schema = z.strictObject({ configPath: z.optional(containedPath) });
export type ProjectDevcontainerSelectionV1 = z.infer<typeof ProjectDevcontainerSelectionV1Schema>;

/** Deliberate Project intent; absent preserves fixed-port behavior. */
export const ProjectWorktreePortsV1Schema = z.discriminatedUnion('enabled', [
  z.strictObject({ enabled: z.literal(false) }),
  z.strictObject({ enabled: z.literal(true), slots: ProjectWorktreePortSlotsV1Schema }),
]);
export type ProjectWorktreePortsV1 = z.infer<typeof ProjectWorktreePortsV1Schema>;
export const ProjectServiceRuntimeV1Schema = z.strictObject({
  portSlot: z.optional(z.number().check(z.int(), z.minimum(0))),
  primary: z.optional(z.boolean()), terminal: z.optional(z.boolean()),
  title: z.optional(nonempty), autostart: z.optional(z.boolean()),
});
export type ProjectServiceRuntimeV1 = z.infer<typeof ProjectServiceRuntimeV1Schema>;

function isFiniteSource(source: ProjectCommandSourceV1): boolean {
  return source.kind !== 'native' || (source.tool !== 'compose' && source.tool !== 'procfile');
}
const finiteSource = ProjectCommandSourceV1Schema.check(z.refine(isFiniteSource, 'Compose and Procfile references are services'));
const execution = z.optional(z.enum(['primary', 'portable']));
export const ProjectManifestV1Schema = z.strictObject({
  version: z.literal(1),
  $schema: z.optional(nonempty),
  toolchain: z.optional(ProjectToolchainSelectionV1Schema),
  devcontainer: z.optional(ProjectDevcontainerSelectionV1Schema),
  worktreePorts: z.optional(ProjectWorktreePortsV1Schema),
  environmentVariables: z.optional(z.array(lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(EnvVarRequirementSchema)))
    .check(z.refine(requirements => new Set(requirements.map(requirement => requirement.name)).size === requirements.length,
      'Environment requirement names must be unique'))),
  workspace: z.optional(z.strictObject({
    setup: z.optional(z.array(finiteSource)), teardown: z.optional(z.array(finiteSource)),
    setupInputs: z.optional(z.array(containedPath)), memoryDemand: z.optional(ProjectMemoryDemandV1Schema),
  })),
  scripts: z.optional(z.record(nonempty, z.strictObject({ source: finiteSource, execution, memoryDemand: z.optional(ProjectMemoryDemandV1Schema) }))),
  services: z.optional(z.record(nonempty, z.strictObject({ source: ProjectCommandSourceV1Schema, execution,
    port: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(65535))), runtime: z.optional(ProjectServiceRuntimeV1Schema) }))),
}).check(z.refine(manifest => {
  if (!manifest.worktreePorts?.enabled) return true;
  const used = new Set<number>();
  for (const service of Object.values(manifest.services ?? {})) {
    const runtime = service.runtime;
    if (!runtime) continue;
    if (runtime.primary && runtime.portSlot !== undefined && runtime.portSlot !== 0) return false;
    const slot = runtime.primary ? 0 : runtime.portSlot;
    if (slot === undefined) continue;
    if (slot >= manifest.worktreePorts.slots || used.has(slot)) return false;
    used.add(slot);
  }
  return true;
}, 'Allocated services must select distinct declared slots; the primary service uses slot zero'));
export type ProjectManifestV1 = z.infer<typeof ProjectManifestV1Schema>;
export const ProjectManifestV1StoredSchema = createStoredReadSchema(ProjectManifestV1Schema);

export const ProjectToolRequirementV1Schema = z.strictObject({
  tool: nonempty, file: containedPath, requestedVersion: z.optional(nonempty),
});
export type ProjectToolRequirementV1 = z.infer<typeof ProjectToolRequirementV1Schema>;
export const ProjectToolInspectionV1Schema = z.extend(ProjectToolRequirementV1Schema, {
  availability: z.enum(['available', 'unavailable', 'unresolved']), version: z.optional(nonempty),
});
export type ProjectToolInspectionV1 = z.infer<typeof ProjectToolInspectionV1Schema>;
export const ProjectNativeInvocationPreviewV1Schema = z.strictObject({
  tool: nonempty, args: z.readonly(z.array(z.string())), cwd: nonempty, requestedVersion: z.optional(nonempty),
});

/** Passive declarations, not execution or deployability. Command refs omit script bodies. */
export const ProjectDetectedApplicationV1Schema = z.strictObject({
  file: ProjectNativeFilePathV1Schema,
  framework: z.nullable(nonempty),
  runtime: z.nullable(z.strictObject({ name: nonempty, version: nonempty })),
  build: z.nullable(ProjectNativeRefV1Schema), start: z.nullable(ProjectNativeRefV1Schema),
  port: z.nullable(z.number().check(z.int(), z.minimum(1), z.maximum(65535))),
});
export type ProjectDetectedApplicationV1 = z.infer<typeof ProjectDetectedApplicationV1Schema>;
/** Only the conventional files at the inspected checkout root; unknown is not absence. */
export const ProjectRootContainerFilesV1Schema = z.strictObject({
  dockerfile: z.enum(['present', 'absent', 'unknown']), compose: z.enum(['present', 'absent', 'unknown']),
});
export const ProjectDefinitionDetectionV1Schema = z.strictObject({
  entries: z.array(z.strictObject({ source: ProjectNativeRefV1Schema, usage: z.enum(['script', 'service', 'setup']) }).check(z.refine(
    entry => entry.usage === 'service' || isFiniteSource(entry.source), 'Compose and Procfile references are services',
  ))),
  toolchains: z.array(ProjectToolchainSelectionV1Schema),
  devcontainers: z.array(ProjectDevcontainerSelectionV1Schema),
  coverage: z.enum(['complete', 'partial']),
  diagnostics: z.array(z.strictObject({ file: nonempty, code: nonempty })),
  tools: z.optional(z.array(ProjectToolRequirementV1Schema)),
  applications: z.optional(z.array(ProjectDetectedApplicationV1Schema)),
  rootFiles: z.optional(ProjectRootContainerFilesV1Schema),
  observedAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
});
export type ProjectDefinitionDetectionV1 = z.infer<typeof ProjectDefinitionDetectionV1Schema>;
/** Last observed declarations, not current deployability. Application paths are checkout-relative. */
export const ProjectRepositoryObservationV1Schema = z.strictObject({
  observedAtMs: z.nonoptional(ProjectDefinitionDetectionV1Schema.shape.observedAtMs),
  coverage: ProjectDefinitionDetectionV1Schema.shape.coverage,
  rootFiles: z.nonoptional(ProjectDefinitionDetectionV1Schema.shape.rootFiles),
  applications: z.array(z.pick(ProjectDetectedApplicationV1Schema, { file: true, framework: true, runtime: true })),
});
export type ProjectRepositoryObservationV1 = z.infer<typeof ProjectRepositoryObservationV1Schema>;

/** Passive import offers: an unproved tool/version never becomes an automatic selection. */
export const ProjectDefinitionImportCandidateV1Schema = z.strictObject({
  source: ProjectNativeRefV1Schema,
  usage: z.enum(['script', 'service', 'setup']),
  availability: z.enum(['available', 'unavailable', 'unresolved', 'ambiguous']),
  code: z.optional(nonempty),
  preselected: z.boolean(),
  invocation: z.optional(ProjectNativeInvocationPreviewV1Schema),
  executionInputs: z.optional(z.array(ProjectExecutionInputV1Schema)),
}).check(z.refine(candidate => !candidate.preselected || candidate.availability === 'available', 'Only available unambiguous offers may be preselected'));
export type ProjectDefinitionImportCandidateV1 = z.infer<typeof ProjectDefinitionImportCandidateV1Schema>;
