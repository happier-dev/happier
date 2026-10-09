import * as z from 'zod/mini';

import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { PluginContributionIdentityV1Schema } from '../../plugins/contributionIdentity.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { EnvVarRequirementSchema } from '../../profiles/environmentVariables.js';
import { ProjectMemoryDemandV1Schema } from './projectMemoryDemandV1.js';

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

export const ProjectCommandSourceV1Schema = z.union([
  ProjectNativeRefV1Schema,
  z.strictObject({ kind: z.literal('command'), command: nonempty, cwd: z.optional(nonempty), platforms: z.optional(z.array(z.enum(['darwin', 'linux', 'windows']))) }),
]);
export type ProjectCommandSourceV1 = z.infer<typeof ProjectCommandSourceV1Schema>;

export const ProjectEnvironmentSelectionV1Schema = z.union([
  z.strictObject({ kind: z.literal('host') }),
  z.strictObject({ kind: z.literal('toolchain'), tool: z.enum(['mise', 'devbox', 'devenv', 'flox', 'nix_flake']), configPath: z.optional(containedPath) }),
  z.strictObject({ kind: z.literal('pluginToolchain'), adapter, configPath: z.optional(containedPath) }),
]);
export type ProjectEnvironmentSelectionV1 = z.infer<typeof ProjectEnvironmentSelectionV1Schema>;

export const ProjectDevcontainerSelectionV1Schema = z.strictObject({ configPath: z.optional(containedPath) });
export type ProjectDevcontainerSelectionV1 = z.infer<typeof ProjectDevcontainerSelectionV1Schema>;

function isFiniteSource(source: ProjectCommandSourceV1): boolean {
  return source.kind !== 'native' || (source.tool !== 'compose' && source.tool !== 'procfile');
}
const finiteSource = ProjectCommandSourceV1Schema.check(z.refine(isFiniteSource, 'Compose and Procfile references are services'));
const execution = z.optional(z.enum(['primary', 'portable']));
export const ProjectManifestV1Schema = z.strictObject({
  version: z.literal(1),
  $schema: z.optional(nonempty),
  environment: z.optional(ProjectEnvironmentSelectionV1Schema),
  devcontainer: z.optional(ProjectDevcontainerSelectionV1Schema),
  environmentVariables: z.optional(z.array(EnvVarRequirementSchema.strict())),
  workspace: z.optional(z.strictObject({
    setup: z.optional(z.array(finiteSource)), teardown: z.optional(z.array(finiteSource)),
    setupInputs: z.optional(z.array(containedPath)), memoryDemand: z.optional(ProjectMemoryDemandV1Schema),
  })),
  scripts: z.optional(z.record(nonempty, z.strictObject({ source: finiteSource, execution, memoryDemand: z.optional(ProjectMemoryDemandV1Schema) }))),
  services: z.optional(z.record(nonempty, z.strictObject({ source: ProjectCommandSourceV1Schema, execution, port: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(65535))) }))),
});
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

export const ProjectDefinitionDetectionV1Schema = z.strictObject({
  entries: z.array(z.strictObject({ source: ProjectNativeRefV1Schema, usage: z.enum(['script', 'service', 'setup']) }).check(z.refine(
    entry => entry.usage === 'service' || isFiniteSource(entry.source), 'Compose and Procfile references are services',
  ))),
  environments: z.array(ProjectEnvironmentSelectionV1Schema),
  devcontainers: z.array(ProjectDevcontainerSelectionV1Schema),
  coverage: z.enum(['complete', 'partial']),
  diagnostics: z.array(z.strictObject({ file: nonempty, code: nonempty })),
  tools: z.optional(z.array(ProjectToolRequirementV1Schema)),
});
export type ProjectDefinitionDetectionV1 = z.infer<typeof ProjectDefinitionDetectionV1Schema>;

/** Passive import offers: an unproved tool/version never becomes an automatic selection. */
export const ProjectDefinitionImportCandidateV1Schema = z.strictObject({
  source: ProjectNativeRefV1Schema,
  usage: z.enum(['script', 'service', 'setup']),
  availability: z.enum(['available', 'unavailable', 'unresolved', 'ambiguous']),
  code: z.optional(nonempty),
  preselected: z.boolean(),
  invocation: z.optional(ProjectNativeInvocationPreviewV1Schema),
}).check(z.refine(candidate => !candidate.preselected || candidate.availability === 'available', 'Only available unambiguous offers may be preselected'));
export type ProjectDefinitionImportCandidateV1 = z.infer<typeof ProjectDefinitionImportCandidateV1Schema>;
