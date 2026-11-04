import type { CollectionSpaceIconV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import type { SessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';

import { findPluginUiIconTokenForIconName } from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
import { resolveSessionSectionIcon } from '@/components/sessions/organization/sessionSectionIcons';
import { COLLECTION_SPACE_GLYPHS } from '@/components/ui/lists/collection/collectionSpaceGlyphs';

type SectionAddress = NonNullable<
  SessionListFilterV1['sections']
>['include'][number];

/**
 * The icon Save as space suggests: the one chosen Section's own icon, else
 * the one chosen Project's mark, else Needs me, else the list lines. Reads held organization only.
 */
export function suggestSessionSpaceIcon(
  filters: Readonly<
    Partial<Pick<SessionListFilterV1, 'sections' | 'projects' | 'attention'>>
  >,
  readSectionIcon: (section: SectionAddress) => string | null | undefined,
): CollectionSpaceIconV1 {
  const sections = filters.sections?.include ?? [];
  if (sections.length === 1) {
    const token = findPluginUiIconTokenForIconName(
      resolveSessionSectionIcon(readSectionIcon(sections[0]!)),
      COLLECTION_SPACE_GLYPHS,
    );
    return { kind: 'icon', name: token ?? 'list' };
  }
  const projects = filters.projects?.include ?? [];
  if (projects.length === 1) return { kind: 'project', project: projects[0]! };
  if (filters.attention === 'needs_my_attention')
    return { kind: 'icon', name: 'attention' };
  return { kind: 'icon', name: 'list' };
}
