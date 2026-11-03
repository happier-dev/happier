import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { CapabilityRow } from '@/components/capabilities/row/CapabilityRow';
import { CapabilityStatusChip } from '@/components/capabilities/status/CapabilityStatusChip';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { mcpServerRoute } from '@/components/settings/mcpServers/collection/mcpServerCollectionModel';
import { McpServerMark } from '@/components/settings/mcpServers/identity/McpServerMark';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { skillHref } from '@/components/settings/skills/skillsCollectionModel';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Icon } from '@/components/ui/icons/Icon';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { CollectionSkeletonRows } from '@/components/ui/lists/collection/CollectionList';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import {
  ItemGroupColumn,
  ItemGroupColumns,
} from '@/components/ui/lists/ItemGroupColumns';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Switch } from '@/components/ui/forms/Switch';
import { Text } from '@/components/ui/text/Text';
import { useReachRules } from '@/sync/domains/capabilities/reach/useReachRules';
import { useFoundSkillsCount } from '@/sync/domains/skills/useFoundSkills';
import { t } from '@/text';
import { joinList } from '@/utils/text/joinList';
import { describeOfflineMachines } from '@/components/capabilities/where/whereItsOnPresentation';

import {
  SCOPE_ROW_LIMIT,
  describeScope,
  readScope,
  scopeWrite,
  type ScopeMachine,
  type ScopePlace,
} from './capabilityScopeModel';
import {
  useCapabilityScope,
  type CapabilityScopeData,
  type ScopeListData,
  type ScopeRowData,
} from './useCapabilityScope';

/** The least width a sheet reads well at; below two of these side by side, the sheets stack (Skills first). */
const SHEET_MIN_WIDTH_PX = 300;

type Place = Readonly<{
  place: ScopePlace;
  /** The place's own name in the words a change speaks ("nl2", "happier"). */
  label: string;
}>;

/**
 * One switch row: the place's agent-general state, the words under it naming where it differs, and the status that
 * needs the person. The row reads and writes through the shared rules owner, so a flip is optimistic, Undo-able
 * and refused or failed visibly there; nothing here decides precedence.
 */
const ScopeRow = React.memo(function ScopeRow(
  props: Readonly<{
    row: ScopeRowData;
    place: Place;
    data: Pick<CapabilityScopeData, 'machines' | 'names' | 'open'>;
    testID: string;
  }>,
) {
  const { row, place, data } = props;
  const owner = useReachRules(row.kind, row.id);
  const read = React.useMemo(
    () => readScope(owner.rules, place.place, data.machines, owner.resolveReach),
    [owner.rules, owner.resolveReach, place.place, data.machines],
  );
  const words = React.useMemo(
    () => describeScope(read, place.place, data.names),
    [read, place.place, data.names],
  );
  const { change, rules } = owner;
  const flip = React.useCallback(
    (requestedOn: boolean) => {
      void change(scopeWrite(rules, place.place, data.machines, requestedOn, owner.resolveReach), {
        message: t(
          requestedOn
            ? 'capabilities.scopeSection.turnedOn'
            : 'capabilities.scopeSection.turnedOff',
          { name: row.name, place: place.label },
        ),
      }).then((result) => {
        if (!result.ok) {
          publishPresentationNotice({
            key: `scope:${row.id}`,
            message: t('capabilities.control.changeFailed'),
            severity: 'error',
          });
        }
      });
    },
    [change, data.machines, place.label, place.place, row.id, row.name, rules, owner.resolveReach],
  );
  const href =
    row.kind === 'skill' ? skillHref(row.id) : mcpServerRoute(row.id);
  const { open } = data;
  return (
    <CapabilityRow
      testID={props.testID}
      title={row.name}
      whereSummary={words}
      {...(row.kind === 'mcp_server' && row.transport
        ? {
            mark: (
              <McpServerMark
                transport={row.transport}
                iconUrl={row.iconUrl ?? null}
                size={20}
              />
            ),
          }
        : {})}
      {...(row.status
        ? {
            note: (
              <CapabilityStatusChip
                status={row.status}
                showFix
                testID={`${props.testID}.status`}
              />
            ),
          }
        : {})}
      {...(row.masked
        ? {}
        : {
            action: (
              <Switch
                value={read.on}
                onValueChange={flip}
                // A write waits for the rules' current read; offering it earlier would only refuse it.
                disabled={owner.status !== 'ready'}
                testID={`${props.testID}.switch`}
              />
            ),
          })}
      onPress={() => open(href)}
    />
  );
});

function EmptyLine(
  props: Readonly<{
    testID: string;
    title: string;
    actionLabel: string;
    onPress: () => void;
  }>,
) {
  return (
    <Item
      testID={props.testID}
      mode="info"
      showChevron={false}
      title={props.title}
      rightElement={
        <TextLinkButton label={props.actionLabel} onPress={props.onPress} />
      }
    />
  );
}

/** One sheet of the section; exported for its mounted state tests, which give it plain list data. */
export const ScopeSheet = React.memo(function ScopeSheet(
  props: Readonly<{
    testID: string;
    kind: 'skill' | 'mcp_server';
    title: string;
    list: ScopeListData;
    place: Place;
    data: Pick<CapabilityScopeData, 'machines' | 'names' | 'open'>;
    /** The name of the covered machine that is offline: its list comes when it runs, so a failed read is not an error. */
    offlineMachine: string | null;
  }>,
) {
  const { list, data, kind } = props;
  const skills = kind === 'skill';
  const collectionRoute = skills ? SETTINGS_ROUTES.skills : SETTINGS_ROUTES.mcp;
  return (
    <ItemGroup testID={props.testID} header="none">
      <View style={styles.heading}>
        <Text variant="label" emphasis="semiBold" style={styles.title}>{props.title}</Text>
        {list.total > 0 ? <Text variant="meta" style={styles.count}>{String(list.total)}</Text> : null}
      </View>
      {/* A read that failed while its machine is offline is not an error: the list comes when the machine runs. */}
      {list.state !== 'ready' && props.offlineMachine !== null ? (
        <Item
          testID={`${props.testID}.offline`}
          mode="info"
          showChevron={false}
          title={t('capabilities.scopeSection.whenRunning', { machine: props.offlineMachine })}
        />
      ) : null}
      {list.state === 'unavailable' && props.offlineMachine === null ? (
        <EmptyLine
          testID={`${props.testID}.unavailable`}
          title={t('capabilities.scopeSection.loadFailed')}
          actionLabel={t('common.retry')}
          onPress={list.retry}
        />
      ) : null}
      {list.state === 'loading' && props.offlineMachine === null ? (
        <CollectionSkeletonRows count={SCOPE_ROW_LIMIT} />
      ) : null}
      {list.state === 'ready' && list.total === 0 ? (
        <EmptyLine
          testID={`${props.testID}.empty`}
          title={t(
            skills
              ? 'capabilities.scopeSection.emptySkills'
              : 'capabilities.scopeSection.emptyMcp',
          )}
          actionLabel={t(
            skills
              ? 'capabilities.scopeSection.addSkill'
              : 'capabilities.scopeSection.addMcp',
          )}
          onPress={() =>
            data.open(
              skills ? SETTINGS_ROUTES.skillsNew : `${SETTINGS_ROUTES.mcp}/new`,
            )
          }
        />
      ) : null}
      {list.rows.map((row) => (
        <ScopeRow
          key={row.id}
          row={row}
          place={props.place}
          data={data}
          testID={`${props.testID}.row.${row.id}`}
        />
      ))}
      {list.total > list.rows.length ? (
        <Item
          testID={`${props.testID}.all`}
          title={t(
            skills
              ? 'capabilities.scopeSection.allSkills'
              : 'capabilities.scopeSection.allMcp',
            { count: list.total },
          )}
          showChevron
          onPress={() =>
            data.open(
              props.place.place.t === 'machine' && skills
                ? `${collectionRoute}?machine=${encodeURIComponent(props.place.place.machineId)}`
                : collectionRoute,
            )
          }
        />
      ) : null}
    </ItemGroup>
  );
});

/** "3 more skills live only on nl2 · Found on your machines": the Found cache's own count, no new read. */
function FoundMoreLine(
  props: Readonly<{
    machineId: string;
    machineName: string;
    open: (href: string) => void;
    testID: string;
  }>,
) {
  const count = useFoundSkillsCount(
    React.useMemo(() => [props.machineId], [props.machineId]),
  );
  if (count === 0) return null;
  return (
    <View style={styles.foundLine} testID={props.testID}>
      <Icon name="copy" size={16} />
      <Text variant="meta" style={styles.foundText}>
        {t('capabilities.scopeSection.foundMore', {
          count,
          machine: props.machineName,
        })}
      </Text>
      <TextLinkButton
        label={t('capabilities.scopeSection.foundLink')}
        size="meta"
        onPress={() => props.open(SETTINGS_ROUTES.skillsFound)}
      />
    </View>
  );
}

/**
 * "Skills and MCP servers" on a machine page and on Project → Context (P8 U8.6, lab xs M/Mp/P/Pp): what sessions
 * there get, as two sheets of at most four switch rows (Skills first, side by side where they fit). The page that
 * mounts it keeps its own composition; the section owns its content.
 */
export const CapabilityScopeSection = React.memo(
  function CapabilityScopeSection(
    props: Readonly<{
      testID: string;
      place: ScopePlace;
      /** The place's own name ("nl2", "happier"). */
      placeLabel: string;
      description: string;
      /** The page already says the place is offline (a machine's own Overview), so the section does not say it again. */
      offlineStatedAbove?: boolean;
    }>,
  ) {
    const data = useCapabilityScope(props.place);
    const place = React.useMemo<Place>(
      () => ({ place: props.place, label: props.placeLabel }),
      [props.place, props.placeLabel],
    );
    const rowData = React.useMemo(
      () => ({
        machines: data.machines as readonly ScopeMachine[],
        names: data.names,
        open: data.open,
      }),
      [data.machines, data.names, data.open],
    );
    const migratedNames = data.migrated.names;
    const offlineMachine = data.unreachableMachineName;
    const offlineNote = describeOfflineMachines(data.offlineNames);
    return (
      <ItemGroup
        testID={props.testID}
        title={t('capabilities.scopeSection.title')}
        description={props.description}
        surface="none"
      >
        {offlineNote && props.offlineStatedAbove !== true ? (
          <View style={styles.offline}>
            <SurfaceFreshnessLine
              testID={`${props.testID}.offline`}
              reason={offlineNote}
            />
          </View>
        ) : null}
        {migratedNames.length > 0 ? (
          <AttentionBanner
            testID={`${props.testID}.migrated`}
            tone="neutral"
            title={t('capabilities.scopeSection.migrationNote', {
              names: joinList(migratedNames),
            })}
            onDismiss={data.migrated.dismiss}
          />
        ) : null}
        <ListPresentationProvider value="page" pageInsets="contained">
          <ItemGroupColumns columns={2} minColumnWidthPx={SHEET_MIN_WIDTH_PX} paddingHorizontal={0} paddingVertical={0}>
            <ItemGroupColumn>
              <ScopeSheet
                testID={`${props.testID}.skills`}
                kind="skill"
                title={t('capabilities.scopeSection.skills')}
                list={data.skills}
                place={place}
                data={rowData}
                offlineMachine={offlineMachine}
              />
            </ItemGroupColumn>
            <ItemGroupColumn>
              <ScopeSheet
                testID={`${props.testID}.mcp`}
                kind="mcp_server"
                title={t('capabilities.scopeSection.mcp')}
                list={data.mcp}
                place={place}
                data={rowData}
                offlineMachine={offlineMachine}
              />
            </ItemGroupColumn>
          </ItemGroupColumns>
        </ListPresentationProvider>
        {props.place.t === 'machine' ? (
          <FoundMoreLine
            machineId={props.place.machineId}
            machineName={props.placeLabel}
            open={data.open}
            testID={`${props.testID}.found`}
          />
        ) : null}
      </ItemGroup>
    );
  },
);

const styles = StyleSheet.create((theme) => ({
  heading: { flexDirection: 'row', alignItems: 'baseline', gap: theme.space.s8, paddingHorizontal: theme.space.s16, paddingTop: theme.space.s12, paddingBottom: theme.space.s4 },
  title: { color: theme.colors.text.primary },
  count: { color: theme.colors.text.secondary, fontVariant: ['tabular-nums'] },
  offline: { paddingBottom: theme.space.s12 },
  foundLine: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s12,
    paddingTop: theme.space.s12,
  },
  foundText: { color: theme.colors.text.secondary, flexShrink: 1 },
}));
