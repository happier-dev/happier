import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import {
  HappierCollectionListMark,
  createHappierCollectionDraftTitleStore,
} from '@happier-dev/plugin-ui/presentation';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import {
  CollectionDraftRow,
  CollectionList,
  CollectionListGroupLabel,
  collectionListStyles,
} from '@/components/ui/lists/collection/CollectionList';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { describeProjectSourceRow } from './projectSourceAddress';
import { readSourceTeamId, type ProjectSourceGroup } from './projectSourceGroups';
export { groupProjectSources, readSourceTeamId, type ProjectSourceGroup } from './projectSourceGroups';

/** The name typed into the open new-source draft, shown by the rail's draft row. */
export const projectSourceDraftTitle = createHappierCollectionDraftTitleStore();

export const ProjectSourcesRail = React.memo(function ProjectSourcesRail(
  props: Readonly<{
    groups: readonly ProjectSourceGroup[];
    total: number;
    query: string;
    onChangeQuery: (query: string) => void;
    selectedId: string | null;
    drafting: boolean;
    teamName: (teamId: string) => string | null;
    /** Retained rows under a Home that isn't answering: as of when, and Retry. */
    stale: Readonly<{ reason: string; onRetry: () => void }> | null;
    onSelect: (sourceId: string) => void;
    onAdd: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const mark = React.useCallback(
    (dimmed?: boolean) => (
      <HappierCollectionListMark dimmed={dimmed}>
        <Icon name="git-branch" size={18} color={theme.colors.text.secondary} />
      </HappierCollectionListMark>
    ),
    [theme.colors.text.secondary],
  );
  return (
    <CollectionList
      testID="projects.sources.rail"
      title={t('projects.sources.title')}
      count={props.total}
      headerAction={
        <IconButton
          testID="projects.sources.rail.add"
          iconName="plus"
          variant="plain"
          accessibilityLabel={t('projects.sources.new')}
          tooltip={t('projects.sources.new')}
          onPress={props.onAdd}
        />
      }
      search={{
        value: props.query,
        onChangeText: props.onChangeQuery,
        placeholder: t('projects.sources.search'),
        testID: 'projects.sources.rail.search',
      }}
    >
      {props.stale ? (
        <SurfaceFreshnessLine
          testID="projects.sources.rail.stale"
          reason={props.stale.reason}
          action={{ label: t('common.retry'), onPress: props.stale.onRetry }}
        />
      ) : null}
      {props.drafting ? (
        <CollectionDraftRow
          testID="projects.sources.rail.draft"
          titles={projectSourceDraftTitle}
          placeholder={t('projects.sources.new')}
          mark={mark()}
        />
      ) : null}
      {props.groups.length === 0 && props.query.trim() ? (
        <Item
          testID="projects.sources.rail.noMatches"
          title={t('common.noMatches')}
          density="compact"
          showChevron={false}
          mode="info"
        />
      ) : null}
      {props.groups.map((group, index) => (
        <React.Fragment key={group.id}>
          <CollectionListGroupLabel
            title={group.title}
            count={group.sources.length}
            first={index === 0 && !props.drafting && !props.stale}
          />
          {group.sources.map((source) => {
            const teamId =
              group.id === 'yours' ? readSourceTeamId(source) : null;
            const team = teamId ? props.teamName(teamId) : null;
            return (
              <Item
                key={source.id}
                testID={`projects.sources.row.${source.id}`}
                title={source.name}
                titleAccessory={
                  team ? (
                    <Text style={collectionListStyles.dimmedTitle}>{team}</Text>
                  ) : undefined
                }
                subtitle={describeProjectSourceRow(source)}
                icon={mark()}
                selected={props.selectedId === source.id}
                density="compact"
                showChevron={false}
                pressableStyle={collectionListStyles.row}
                onPress={() => props.onSelect(source.id)}
              />
            );
          })}
        </React.Fragment>
      ))}
    </CollectionList>
  );
});
