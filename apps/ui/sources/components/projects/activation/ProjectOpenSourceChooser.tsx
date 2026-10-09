import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierCollectionListMark } from '@happier-dev/plugin-ui/presentation';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';

import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import {
  CollectionList,
  CollectionListGroupLabel,
  collectionListStyles,
} from '@/components/ui/lists/collection/CollectionList';
import { useTeamsDirectory } from '@/hooks/teams/useTeamsDirectory';
import type { CustomModalInjectedProps } from '@/modal/types';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

import { describeProjectSourceRow } from '../sources/projectSourceAddress';
import {
  groupProjectSources,
  type ProjectSourceGroup,
} from '../sources/projectSourceGroups';
import { useProjectSources } from '../sources/useProjectSources';

/** Team names for a Home's Source groups ("From Acme"), from the one Teams directory owner. */
export function useProjectSourceTeamName(
  serverId: string,
): (teamId: string) => string | null {
  const teamsDirectory = useTeamsDirectory({ serverIds: [serverId] });
  return React.useCallback(
    (teamId: string) =>
      teamsDirectory.rows.find((row) => row.team.id === teamId)?.team.name ??
      null,
    [teamsDirectory.rows],
  );
}

/**
 * Open's source chooser (lab `p-open` OPEN left pane, plan 11 §8 "Collection source chooser"): the
 * Collection list anatomy with its search, the catalog's own groups, then "A folder on a machine…".
 * The dialog names the list, so it carries no heading of its own.
 */
export const ProjectOpenSourceChooser = React.memo(
  function ProjectOpenSourceChooser(
    props: Readonly<{
      groups: readonly ProjectSourceGroup[];
      /** The catalog answered and holds nothing: say what Open can still do. */
      empty: boolean;
      query: string;
      onChangeQuery: (query: string) => void;
      selectedSourceId: string | null;
      folderSelected: boolean;
      /** A folder is picked on a Machine, so the row waits for one. */
      folderDisabled: boolean;
      onSelectSource: (source: ProjectSourceV1) => void;
      onPickFolder: () => void;
    }>,
  ) {
    const { theme } = useUnistyles();
    const mark = (name: 'git-branch' | 'folder-open') => (
      <HappierCollectionListMark>
        <Icon name={name} size={18} color={theme.colors.text.secondary} />
      </HappierCollectionListMark>
    );
    return (
      <CollectionList
        testID="projects.open.sources"
        search={{
          value: props.query,
          onChangeText: props.onChangeQuery,
          placeholder: t('projects.sources.search'),
          testID: 'projects.open.search',
        }}
      >
        {props.groups.map((group, index) => (
          <React.Fragment key={group.id}>
            <CollectionListGroupLabel title={group.title} first={index === 0} />
            {group.sources.map((source) => (
              <Item
                key={source.id}
                testID={`projects.open.source.${source.id}`}
                title={source.name}
                subtitle={describeProjectSourceRow(source)}
                icon={mark('git-branch')}
                selected={props.selectedSourceId === source.id}
                density="compact"
                showChevron={false}
                pressableStyle={collectionListStyles.row}
                onPress={() => props.onSelectSource(source)}
              />
            ))}
          </React.Fragment>
        ))}
        {props.empty ? (
          <Item
            testID="projects.open.noSources"
            title={t('projects.open.noSources')}
            titleLines={0}
            density="compact"
            showChevron={false}
            mode="info"
          />
        ) : null}
        <Item
          testID="projects.open.folder"
          title={t('projects.open.aFolder')}
          icon={mark('folder-open')}
          selected={props.folderSelected}
          density="compact"
          showChevron={false}
          pressableStyle={collectionListStyles.row}
          disabled={props.folderDisabled}
          onPress={props.onPickFolder}
        />
      </CollectionList>
    );
  },
);

export type ProjectOpenSourceSheetProps = CustomModalInjectedProps &
  Readonly<{
    scope: ServerAccountScope;
    selectedSourceId: string | null;
    folderSelected: boolean;
    folderDisabled: boolean;
    onSelectSource: (source: ProjectSourceV1) => void;
    onPickFolder: () => void;
  }>;

/**
 * The phone's source choice sheet (plan 11 §2 "sequential selection pushes choice sheets"): the same
 * chooser over the same catalog owner; choosing returns to the retained draft.
 */
export function ProjectOpenSourceSheet(
  props: ProjectOpenSourceSheetProps,
): React.ReactElement {
  const { state: catalog, controller } = useProjectSources(props.scope);
  const teamName = useProjectSourceTeamName(props.scope.serverId);
  const [query, setQuery] = React.useState('');
  const groups = groupProjectSources({
    sources: catalog.rows,
    accountId: props.scope.accountId,
    teamName,
  });
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <ProjectOpenSourceChooser
        groups={groups}
        empty={groups.length === 0 && catalog.status === 'ready'}
        query={query}
        onChangeQuery={(next) => {
          setQuery(next);
          void controller.load(next);
        }}
        selectedSourceId={props.selectedSourceId}
        folderSelected={props.folderSelected}
        folderDisabled={props.folderDisabled}
        onSelectSource={(source) => {
          props.onClose();
          props.onSelectSource(source);
        }}
        onPickFolder={() => {
          props.onClose();
          props.onPickFolder();
        }}
      />
    </View>
  );
}
