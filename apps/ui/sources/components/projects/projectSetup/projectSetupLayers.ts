import {
  createProjectDefinitionOriginLookupV1,
  type ProjectEffectiveDefinitionV1,
} from '@happier-dev/protocol/workspaces/projectSetup/projectDefinitionCompositionV1';

import { t } from '@/text';

/**
 * Where each piece of a project's setup comes from, for the Scripts page (plan A §7): the repository's
 * project file says nothing; a shared setup or a change just for this person says so in quiet words.
 */
export type ProjectSetupLayers = Readonly<{
  /** The origin words for one declaration path, or null for the repository's own. */
  originOf: (path: readonly string[]) => string | null;
  /** The layer's name for a review line ("repository", the shared setup's name, "just for you"). */
  layerOf: (path: readonly string[]) => string | null;
  sharedSourceId: string | null;
  personalChanges: number;
}>;

export function readProjectSetupLayers(
  definition: Pick<
    ProjectEffectiveDefinitionV1,
    'origins' | 'sharedBasis'
  > | null,
  sharedName: string | null,
): ProjectSetupLayers {
  if (!definition)
    return { originOf: () => null, layerOf: () => null, sharedSourceId: null, personalChanges: 0 };
  const lookup = createProjectDefinitionOriginLookupV1(definition);
  return {
    originOf: (path) => {
      const layer = lookup(path)?.layer;
      if (layer === 'shared')
        return sharedName
          ? t('projects.scripts.origin.shared', { name: sharedName })
          : t('projects.scripts.origin.sharedUnnamed');
      return layer === 'personal'
        ? t('projects.scripts.origin.personal')
        : null;
    },
    layerOf: (path) => {
      const layer = lookup(path)?.layer;
      if (layer === 'shared') return sharedName ?? t('projects.scripts.layers.sharedUnnamed');
      if (layer === 'personal') return t('projects.scripts.layer.personal');
      return layer === 'repository' ? t('projects.scripts.layer.repository') : null;
    },
    sharedSourceId: definition.sharedBasis?.sourceId ?? null,
    personalChanges: definition.origins.filter(
      (origin) => origin.layer === 'personal' && !origin.overridden,
    ).length,
  };
}
