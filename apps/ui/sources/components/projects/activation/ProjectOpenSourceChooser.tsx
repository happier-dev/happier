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
  CollectionNavigationRow,
  collectionListStyles,
} from '@/components/ui/lists/collection/CollectionList';
import { useTeamsDirectory } from '@/hooks/teams/useTeamsDirectory';
import type { CustomModalInjectedProps } from '@/modal/types';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

import { describeProjectSourceRow, formatProjectSourceAddress } from '../sources/projectSourceAddress';
import {
  groupProjectSources,
  type ProjectSourceGroup,
} from '../sources/projectSourceGroups';
import { useProjectSources } from '../sources/useProjectSources';
import type { ProjectOpenSubject } from './projectOpenChoices';

/** The chosen subject as the source list's row: the list always shows what the form stands on as selected. */
export type ProjectOpenChosenRow = Readonly<{ id: string; title: string; subtitle: string | null; mono: boolean }>;

/**
 * What the source list shows for the form's subject. A folder has its own row ("A folder on a machine…"); a saved
 * Source, a repository address and an existing checkout are named by the row below, which the list draws selected
 * wherever the catalog does not list it (a checkout opened elsewhere, a Source the search or catalog leaves out).
 */
export function describeProjectOpenChosenRow(subject: ProjectOpenSubject | null, sourceName: string | null): ProjectOpenChosenRow | null {
  if (!subject || subject.kind === 'folder') return null;
  if (subject.kind === 'source') {
    const address = subject.source.repository ? formatProjectSourceAddress(subject.source.repository) : null;
    return { id: subject.source.id, title: sourceName ?? address ?? subject.source.id,
      subtitle: subject.source.repository ? describeProjectSourceRow(subject.source) : null, mono: false };
  }
  if (subject.kind === 'repository') {
    const address = formatProjectSourceAddress(subject.selector);
    return { id: `repository:${address}`, title: subject.selector.repository.nameWithOwner.split('/').pop() || address,
      subtitle: address, mono: false };
  }
  // A checkout reads as a folder row: its name, then the folder it sits in.
  const path = subject.workspace.rootPath.replace(/(?<=.)[\\/]+$/u, '');
  const name = path.split(/[\\/]/u).filter(Boolean).pop() ?? path;
  const parent = path.slice(0, Math.max(0, path.length - name.length)).replace(/[\\/]+$/u, '') || null;
  return { id: `workspace:${path}`, title: name, subtitle: parent, mono: true };
}

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
      /** The form's subject, drawn selected when no catalog row stands for it. */
      chosen: ProjectOpenChosenRow | null;
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
    const listed = props.groups.some(group => group.sources.some(source => source.repository && source.id === props.chosen?.id));
    const chosen = listed ? null : props.chosen;
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
        {chosen ? (
          <CollectionNavigationRow
            surface="page"
            testID="projects.open.chosen"
            title={chosen.title}
            {...(chosen.subtitle ? { subtitle: chosen.subtitle } : {})}
            subtitleMono={chosen.mono}
            icon={mark('git-branch')}
            selected
            onPress={noop}
          />
        ) : null}
        {props.groups.filter(group => group.sources.some(source => source.repository)).map((group, index) => (
          <React.Fragment key={group.id}>
            <CollectionListGroupLabel title={group.title} first={index === 0} />
            {group.sources.filter(source => source.repository).map((source) => (
              <CollectionNavigationRow
                surface="page"
                key={source.id}
                testID={`projects.open.source.${source.id}`}
                title={source.name}
                subtitle={describeProjectSourceRow(source)}
                icon={mark('git-branch')}
                selected={props.selectedSourceId === source.id}
                onPress={() => props.onSelectSource(source)}
              />
            ))}
          </React.Fragment>
        ))}
        {props.empty && !chosen ? (
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
          rowRole="item"
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

const noop = () => {};

export type ProjectOpenSourceSheetProps = CustomModalInjectedProps &
  Readonly<{
    scope: ServerAccountScope;
    selectedSourceId: string | null;
    chosen: ProjectOpenChosenRow | null;
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
        chosen={props.chosen}
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
