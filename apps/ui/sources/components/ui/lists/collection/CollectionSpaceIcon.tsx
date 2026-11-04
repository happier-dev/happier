import * as React from 'react';
import { View } from 'react-native';
import type { CollectionSpaceIconV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import type { QualifiedProjectKeyV1, WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { resolvePluginUiIconName } from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
import { SessionListProjectMark } from '@/components/sessions/shell/SessionListProjectMark';
import { useWorkspaceFavicon } from '@/components/sessions/shell/useWorkspaceFavicon';
import { Icon } from '@/components/ui/icons/Icon';
import { useSetting } from '@/sync/domains/state/storage';
import { getStorage } from '@/sync/domains/state/storageStore';
import { readProjectWorkspaceRefs } from '@/sync/store/domains/projectAccountRows';
import { readProjectBaselineRef } from '@/sync/domains/workspaces/projectGroupDisplay';

type CollectionSpaceIconProps = Readonly<{
  icon: CollectionSpaceIconV1;
  size: number;
  color: string;
  testID?: string;
}>;

/**
 * A space's mark wherever it is drawn (strip, title menu, form, Settings, row and composer menus): its glyph, or
 * for a Project space that Project's favicon through the shared Project mark (P5), folder until one is held.
 */
export const CollectionSpaceIcon = React.memo(function CollectionSpaceIcon(
  props: CollectionSpaceIconProps,
) {
  if (props.icon.kind === 'project') {
    return (
      <ProjectSpaceIcon
        project={props.icon.project}
        size={props.size}
        color={props.color}
        testID={props.testID}
      />
    );
  }
  return (
    <Icon
      testID={props.testID}
      name={resolvePluginUiIconName(props.icon.name)}
      size={props.size}
      color={props.color}
    />
  );
});

/**
 * Observes the favicon the Project's baseline already holds (`demand: false`): drawing a space never asks a
 * Machine for one, so choosing or filtering spaces adds no favicon requests. Lists and headers own that demand.
 */
function ProjectSpaceIcon(
  props: Readonly<{
    project: QualifiedProjectKeyV1;
    size: number;
    color: string;
    testID?: string;
  }>,
) {
  const { serverId, projectKey } = props.project;
  // Select only this Project's baseline (it re-elects when the refs change), never the whole ref collection.
  const selectBaseline = React.useMemo(() => {
    let lastRefs: readonly WorkspaceRefV1[] | null = null;
    let last: WorkspaceRefV1 | null = null;
    return (state: Parameters<typeof readProjectWorkspaceRefs>[0]) => {
      const refs = readProjectWorkspaceRefs(state);
      if (refs !== lastRefs) { lastRefs = refs; last = readProjectBaselineRef(refs, { serverId, projectKey }); }
      return last;
    };
  }, [projectKey, serverId]);
  const baseline = getStorage()(selectBaseline);
  const enabled = useSetting('workspaceFaviconsEnabled') !== false;
  const favicon = useWorkspaceFavicon({
    enabled,
    serverId: baseline?.serverId ?? null,
    machineId: baseline?.machineId ?? null,
    workspacePath: baseline?.rootPath ?? null,
    demand: false,
  });
  if (favicon)
    return (
      <SessionListProjectMark
        favicon={favicon}
        size={props.size}
        badge={null}
        testID={props.testID}
      />
    );
  return (
    <View
      testID={props.testID ? `${props.testID}-project-fallback` : undefined}
    >
      <Icon name="folder" size={props.size} color={props.color} />
    </View>
  );
}
