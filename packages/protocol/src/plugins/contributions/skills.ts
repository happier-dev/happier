import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { isPortableRelativePath } from '../../filesystem/portablePathSegment.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { buildQualifiedPluginContributionKey, createPluginContributionIdentity, PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import type { PluginProjectedSkillEntryV1 } from '../../daemon/contributionRegistryProjection.js';

/** A packaged directory; content metadata is read from SKILL.md by the skill owner. */
export const PluginSkillContributionV1Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  directory: z.string().check(z.refine(value => isPortableRelativePath(value.startsWith('./') ? value.slice(2) : value),
    'Skill directories must be confined portable package-relative paths')),
}));

export type PluginSkillContributionV1 = z.infer<typeof PluginSkillContributionV1Schema>;

/** Cold Account declarations and daemon discovery publish the same qualified descriptor. */
export function projectPluginSkillDeclarationV1(input: Readonly<{
  pluginId: string;
  pluginVersion: string;
  pluginName?: string;
  definition: PluginSkillContributionV1;
}>): PluginProjectedSkillEntryV1 {
  return { ...input, id: buildQualifiedPluginContributionKey(createPluginContributionIdentity({
    pluginId: input.pluginId, localId: input.definition.id,
  })) };
}
