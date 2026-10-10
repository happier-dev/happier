import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { buildQualifiedPluginContributionKey, parseQualifiedPluginContributionKey, type PluginContributionIdentityV1 } from '../plugins/contributionIdentity.js';

export type WorkflowDefinitionRefV1 =
  | Readonly<{ kind: 'artifact'; artifactId: string }>
  | Readonly<{ kind: 'builtin'; id: string }>
  | Readonly<{ kind: 'plugin'; contribution: PluginContributionIdentityV1 }>;

const ArtifactIdSchema = lazyZodSchema(() => z.string().uuid());
const BuiltinIdSchema = lazyZodSchema(() => z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$(?![\s\S])/u));

/** Routing identities are canonical, never trimmed or repaired. Catalog availability is separate. */
export function parseWorkflowDefinitionRefV1(value: unknown): WorkflowDefinitionRefV1 | null {
  if (typeof value !== 'string') return null;
  if (value.startsWith('builtin:')) {
    const parsed = BuiltinIdSchema.safeParse(value.slice('builtin:'.length));
    return parsed.success ? { kind: 'builtin', id: parsed.data } : null;
  }
  if (value.startsWith('plugin:')) {
    const contribution = parseQualifiedPluginContributionKey(value.slice('plugin:'.length));
    return contribution ? { kind: 'plugin', contribution } : null;
  }
  return ArtifactIdSchema.safeParse(value).success ? { kind: 'artifact', artifactId: value } : null;
}

export function formatWorkflowDefinitionRefV1(ref: WorkflowDefinitionRefV1): string {
  const value = ref.kind === 'artifact' ? ref.artifactId
    : ref.kind === 'builtin' ? `builtin:${ref.id}`
      : `plugin:${buildQualifiedPluginContributionKey(ref.contribution)}`;
  if (!parseWorkflowDefinitionRefV1(value)) throw new TypeError('Invalid Workflow reference');
  return value;
}

export const WorkflowDefinitionRefV1StringSchema = lazyZodSchema(() => z.string().refine(
  (value) => parseWorkflowDefinitionRefV1(value) !== null,
  'Invalid canonical Workflow reference',
));
export type WorkflowDefinitionRefV1String = z.infer<typeof WorkflowDefinitionRefV1StringSchema>;
