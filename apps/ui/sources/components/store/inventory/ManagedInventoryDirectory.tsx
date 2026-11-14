import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { getResolvedAgentCatalogEntries } from '@/agents/backendCatalog/agentCatalogProjection';
import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import { CapabilityRow } from '@/components/capabilities/row/CapabilityRow';
import {
  presentCapabilityStatus,
  type CapabilityStatus,
} from '@/components/capabilities/status/capabilityStatusPresentation';
import { SkillMark } from '@/components/settings/skills/SkillKindGlyph';
import { PluginMark } from '@/components/settings/plugins/PluginMark';
import { skillDisplayName } from '@/components/settings/skills/skillsCollectionModel';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { StoreItemMark } from '../catalog/StoreItemMark';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { buildPluginsHomeRoute } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { useStoreMachineScope } from '@/components/settings/plugins/model/useStoreMachineScope';
import { useStoreProjectScope } from '@/components/settings/plugins/model/useStoreProjectScope';
import { ItemGroupColumn, ItemGroupColumns } from '@/components/ui/lists/ItemGroupColumns';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { HappierBrandMark } from '@/components/ui/media/HappierBrandMark';
import { Text } from '@/components/ui/text/Text';
import { PROVIDER_CONNECTION_STATUS_KEY } from '@/providers/connection/presentation';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { useReachMachines, useReachProjects } from '@/sync/domains/capabilities/reach/useReachProjection';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
  STORE_KIND_ORDER,
  type StoreInstalledInput,
  type StoreKind,
} from '../catalog/storeKinds';
import type { ManagedInventoryRow as InstalledRow } from './useManagedInventory';
import { groupManagedInventoryAttention, type ManagedInventoryAttention, type ManagedInventoryAttentionLine } from './inventoryAttention';
import {
  inventoryMachineKey,
  inventoryKindTitle,
  inventoryWhereWords,
  type InventoryMachineNames,
  inventoryKindWord,
  partitionIncludedRows,
  type ManagedInventoryRowPresentation,
} from './inventoryRows';
import type {
  ManagedInventoryGroupBy,
  ManagedInventorySectionsState,
} from './ManagedInventorySections';
import { ManagedInventoryCoverage } from './ManagedInventoryCoverage';
import { showStoreSoftwareRemovalReview } from '../StoreSoftwareReview';
import { canManageMachine } from '@/sync/domains/machines/canManageMachine';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { useMachineListForServerSelection } from '@/sync/store/hooks';

/** A view preview, never a read limit: All opens the rest in place (S50 §4.3). */
const PREVIEW_ROWS = 4;
const MARK_PX = 26;
const GLYPH_PX = 20;

type Href = ManagedInventoryRowPresentation['home']['href'];
type Section = Readonly<{
  key: string;
  title: string;
  description?: string;
  rows: readonly InstalledRow[];
  /** Native family facts for a kind section; Machine/Project groups mix families and carry none. */
  family?: ManagedInventorySectionsState['families'][number];
}>;

export type ManagedInventoryDirectoryProps = Readonly<{
  state: ManagedInventorySectionsState;
  input: StoreInstalledInput;
  groupBy: ManagedInventoryGroupBy;
  /** Two columns where the page column is wide enough (Installed); the Machine page keeps one. */
  columns: 1 | 2;
  /** Rows per section before All; null shows every held row (the Machine page's own inventory). */
  preview: number | null;
  testIDPrefix: string;
  /** Inside another section (the Machine page): its sections read one step quieter than the parent title. */
  nested?: boolean;
}>;

/**
 * The one rendering of a managed inventory for both doors (Store → Installed and What's on this
 * Machine): Needs you first, then each kind or placement group, every row opening its canonical home.
 * Data, coverage and continuations come unchanged from `ManagedInventorySections`.
 */
export function ManagedInventoryDirectory(
  props: ManagedInventoryDirectoryProps,
): React.ReactNode {
  const { state, input, groupBy } = props;
  const go = useGo();
  const names = useMachineNames();
  const { projects } = useReachProjects(input.scope?.serverId);
  // What ships with Happier (decided once in the row presentation) is its own group, never mixed into what the person added.
  const { added, included } = React.useMemo(
    () => partitionIncludedRows(state.rows, state.presentations),
    [state.rows, state.presentations],
  );
  const sections = React.useMemo<readonly Section[]>(() => {
    const shipped = new Set(included);
    const own = (rows: readonly InstalledRow[]) =>
      shipped.size === 0 ? rows : rows.filter((row) => !shipped.has(row));
    if (groupBy === 'kind') {
      const byKind = new Map<InstalledRow['kind'], InstalledRow[]>();
      for (const row of added) {
        const rows = byKind.get(row.kind);
        if (rows) rows.push(row);
        else byKind.set(row.kind, [row]);
      }
      return state.families.flatMap((family) => {
        const kind = family.kind;
        const rows = byKind.get(kind) ?? [];
        if (!family && rows.length === 0) return [];
        // Everything of this kind ships with Happier: it lives in the included group, not under an empty header.
        if (rows.length === 0 && family && family.result.rows.length > 0) return [];
        return [
          {
            key: kind,
            title: inventoryKindTitle(kind),
            rows,
            ...(family ? { family } : {}),
          },
        ];
      });
    }
    const projectNames = new Map<string, string>();
    if (groupBy === 'project') {
      for (const project of projects) projectNames.set(project.projectKey, project.name);
      for (const row of state.rows) {
        if ((row.kind === 'app' || row.kind === 'configuredBackup') && row.projectSource) {
          projectNames.set(row.projectSource.id, row.projectSource.name);
        }
      }
    }
    return state.groups.flatMap((group) => {
      const rows = own(group.rows);
      return rows.length === 0 ? [] : [{ ...group, rows }];
    }).map((group) =>
      group.key === 'account'
        ? {
            key: group.key,
            title: t('storeInstalled.accountGroup'),
            description: t('storeInstalled.accountGroupBody'),
            rows: group.rows,
          }
        : group.key === 'unassigned'
          ? {
              key: group.key,
              title: t(groupBy === 'project' ? 'storeInstalled.noProjectGroup' : 'storeInstalled.unassignedGroup'),
              description: t(groupBy === 'project' ? 'storeInstalled.noProjectGroupBody' : 'storeInstalled.unassignedGroupBody'),
              rows: group.rows,
            }
          : {
              key: group.key,
              title: groupBy === 'project'
                ? projectNames.get(group.key) ?? t('storeInstalled.noProjectGroup')
                : names.byKey.get(group.key) ?? t('storeInstalled.machineFallback'),
              rows: group.rows,
            },
    );
  }, [added, groupBy, included, names.byKey, projects, state.families, state.groups, state.rows]);
  const lines = React.useMemo(() => groupManagedInventoryAttention(state.attention), [state.attention]);
  const mixed = groupBy !== 'kind';
  const pluginFolded =
    groupBy === 'kind' &&
    included.length > 0 &&
    !added.some((row) => row.kind === 'plugin')
      ? state.families.find((entry) => entry.kind === 'plugin')
      : undefined;
  return (
    <>
      {state.attention.length > 0 ? (
        <ItemGroup
          testID={`${props.testIDPrefix}.needs`}
          title={t('storeInstalled.needsYou')}
          titleStyle={props.nested ? styles.nestedTitle : undefined}
          titleAccessory={<Count value={state.attention.length} />}
          surface="none"
        >
          {lines.map((line) => line.kind === 'one' ? (
            <AttentionRow
              key={line.entry.key}
              entry={line.entry}
              state={state}
              input={input}
              names={names}
              go={go}
              testID={`${props.testIDPrefix}.needs.${line.entry.key}`}
            />
          ) : (
            <MachineReasonGroup
              key={line.key}
              line={line}
              state={state}
              input={input}
              names={names}
              go={go}
              testIDPrefix={`${props.testIDPrefix}.needs`}
            />
          ))}
        </ItemGroup>
      ) : null}
      <ManagedInventoryCoverage families={state.families} testIDPrefix={props.testIDPrefix} sectionsPage />
      {sections.map((section) => (
        <InventorySection
          key={section.key}
          section={section}
          state={state}
          input={input}
          names={names}
          go={go}
          mixed={mixed}
          nested={props.nested === true}
          columns={props.columns}
          preview={props.preview}
          testID={`${props.testIDPrefix}.section.${section.key}`}
        />
      ))}
      {included.length > 0 ? (
        <InventorySection
          section={{
            key: 'included',
            title: t('settingsPlugins.rowSource.bundled'),
            description: t('storeInstalled.includedBody'),
            rows: included,
            // The Plugins family's coverage and refresh follow its rows when nothing was added.
            ...(pluginFolded ? { family: pluginFolded } : {}),
          }}
          state={state}
          input={input}
          names={names}
          go={go}
          mixed={new Set(included.map((row) => row.kind)).size > 1}
          nested={props.nested === true}
          columns={props.columns}
          // A few are simply shown; many sit behind the closed line, as on the Plugins page.
          preview={included.length <= PREVIEW_ROWS ? null : 0}
          testID={`${props.testIDPrefix}.section.included`}
        />
      ) : null}
    </>
  );
}

function Count(props: Readonly<{ value: number }>) {
  return (
    <Text variant="meta" style={styles.count}>
      {String(props.value)}
    </Text>
  );
}

function useGo() {
  const router = useRouter();
  return React.useCallback(
    (href: Href) => {
      const result = runGuardedNavigation(() => router.push(href as never));
      if (result !== true)
        fireAndForget(result, { tag: 'ManagedInventoryDirectory.go' });
    },
    [router],
  );
}

type MachineNames = InventoryMachineNames;
/** Display names from the existing Reach presentation owner; never a native read. */
function useMachineNames(): MachineNames {
  const reach = useReachMachines();
  return React.useMemo(() => {
    const byId = new Map<string, string>();
    const byKey = new Map<string, string>();
    const serverIdentityId = reach.scope ? getServerProfileById(reach.scope.serverId)?.serverIdentityId : undefined;
    for (const machine of reach.machines) {
      if (!machine.name) continue;
      byId.set(machine.machineId, machine.name);
      if (reach.scope && serverIdentityId) {
        byKey.set(inventoryMachineKey(reach.scope, { serverIdentityId, machineId: machine.machineId }), machine.name);
      }
    }
    return { byKey, byId };
  }, [reach.machines, reach.scope]);
}

/** The installed row's identity mark, shared with Store → Updates. */
export function RowMark(
  props: Readonly<{
    row: InstalledRow;
    title: string;
    input: StoreInstalledInput;
  }>,
) {
  const { theme } = useUnistyles();
  const { row } = props;
  switch (row.kind) {
    case 'skill':
      return (
        <SkillMark firstParty={row.native.provenance?.kind === 'first_party'} />
      );
    case 'plugin':
      return <PluginMark title={props.title} pluginId={row.native.pluginId} />;
    case 'agent': {
      if (row.subject === 'machineAgent') {
        const entry = getResolvedAgentCatalogEntries({
          enabledAgentIds: [],
        }).find((candidate) => candidate.agentId === row.native);
        if (entry)
          return (
            <AgentCatalogIdentityIcon
              entry={entry}
              machineId={props.input.machine?.machineId ?? null}
              serverId={row.scope.serverId}
              current
              size={MARK_PX}
            />
          );
      }
      return <StoreItemMark facts={{ kind: 'agent', title: props.title }} size={MARK_PX} />;
    }
    case 'software':
      // The same mark the setup editor draws for this recipe: its plugin's artwork, else its declared glyph.
      return <StoreItemMark facts={{ kind: 'software', title: props.title,
        bundledPluginId: row.subject === 'recipe' ? row.native.ref.pluginId : null, iconToken: row.presentation.icon ?? null }} size={MARK_PX} />;
    case 'watchedService':
      return <Icon name="eye" size={GLYPH_PX} color={theme.colors.text.secondary} />;
    case 'setup':
      return <Icon name="stack" size={GLYPH_PX} color={theme.colors.text.secondary} />;
    case 'configuredCheck':
      return <Icon name="pulse" size={GLYPH_PX} color={theme.colors.text.secondary} />;
    case 'configuredBackup':
      return <Icon name="archive" size={GLYPH_PX} color={theme.colors.text.secondary} />;
    default:
      // The same mark Discover and Search draw: its artwork, otherwise its kind's glyph, never a letter.
      return <StoreItemMark facts={{ kind: row.kind, title: props.title }} size={MARK_PX} />;
  }
}

/** Both inventory doors offer native removal only for an installation this viewer can manage. */
/** Removal is a rare, consequential act: it lives in the row's "…" menu, never as an inline button (J50). */
function SoftwareRecipeRemovalAction(props: Readonly<{
  row: Extract<InstalledRow, { kind: 'software'; subject: 'recipe' }>;
  name: string;
  testID: string;
}>) {
  const machineIds = React.useMemo(() => new Set(props.row.installations.map(installation => installation.machineId)), [props.row.installations]);
  const selectCanRemove = React.useCallback((machines: readonly Machine[]) =>
    machines.some(machine => machineIds.has(machine.id) && canManageMachine(machine)), [machineIds]);
  const canRemove = useMachineListForServerSelection(props.row.scope.serverId, selectCanRemove);
  return canRemove ? <ItemRowActions title={props.name} overflowOnly overflowTriggerTestID={`${props.testID}.more`}
    actions={[{ id: `${props.testID}.remove`, title: t('common.remove'), icon: 'trash', destructive: true,
      onPress: () => showStoreSoftwareRemovalReview({ name: props.name, row: props.row }) }]} /> : null;
}

function InventorySection(
  props: Readonly<{
    section: Section;
    state: ManagedInventorySectionsState;
    input: StoreInstalledInput;
    names: MachineNames;
    go: (href: Href) => void;
    mixed: boolean;
    nested: boolean;
    columns: 1 | 2;
    preview: number | null;
    testID: string;
  }>,
) {
  const { section, state } = props;
  const [expanded, setExpanded] = React.useState(false);
  const family = section.family?.result;
  const coverage = family?.coverage;
  const continuation = family?.continuation as (() => unknown) | undefined;
  const known = coverage === undefined || coverage === 'available';
  const limit = props.preview !== null && !expanded ? props.preview : Infinity;
  const shown =
    section.rows.length > limit ? section.rows.slice(0, limit) : section.rows;
  const hidden = section.rows.length > shown.length;
  // A family read in native pages (Apps) moves by page, Previous and Next under its rows; All never fetches its next page.
  // The native page order is the producer's, so the words name no direction in time.
  const paging = family && 'navigation' in family ? family.navigation : undefined;
  const canContinue = typeof continuation === 'function' && !(typeof coverage === 'object' && 'unavailable' in coverage) && !paging;
  const fewer = expanded && props.preview !== null && section.rows.length > props.preview;
  // A kind section that holds nothing yet (some Machines haven't answered) says so, and leads to that kind's page,
  // where an item is added; an "All" over no rows would open nothing.
  const { project } = useStoreProjectScope();
  const machine = useStoreMachineScope();
  const browsableKind = section.family && (STORE_KIND_ORDER as readonly string[]).includes(section.family.kind)
    ? section.family.kind as StoreKind : null;
  const none = section.rows.length === 0 && coverage !== 'loading' && browsableKind !== null;
  const all = none ? (
    <SectionActionButton
      testID={`${props.testID}.browse`}
      title={t('storeInstalled.browseKind')}
      destination
      onPress={() => props.go(buildPluginsHomeRoute('app', { view: 'kind', kind: browsableKind, project, machine }) as Href)}
    />
  ) : hidden || (canContinue && !expanded) ? (
    // All shows the rest in place and follows the family's own next page on intent (never on open).
    <SectionActionButton
      testID={`${props.testID}.all`}
      title={known && !canContinue ? t('storeInstalled.all', { count: section.rows.length }) : t('storeInstalled.allUnknown')}
      destination
      onPress={() => {
        setExpanded(true);
        if (canContinue) continuation();
      }}
    />
  ) : fewer ? (
    <SectionActionButton icon="caret-up" testID={`${props.testID}.fewer`} title={t('storeInstalled.fewer')} onPress={() => setExpanded(false)} />
  ) : undefined;
  // The page rail moves only from a fully open page: under the preview, Next would skip this page's unseen rows.
  const rail = paging && !hidden && (paging.hasPreviousPage || paging.hasNextPage) ? paging : undefined;
  if (section.rows.length === 0 && coverage !== 'loading' && !canContinue) return null;
  // A section of names alone (Agents) is a genuinely title-only collection: compact rows, not the described floor
  // its columns would otherwise stand at; one described row keeps its peers on the catalog floor (S10 §5.2).
  const titleOnly = shown.every((row) => !state.presentations.get(row.key)?.facts.context);
  const rows = shown.map((row) => {
    const presentation = state.presentations.get(row.key);
    const title = presentation?.facts.title ?? row.key;
    const home = presentation?.home.href;
    const rendered = (
      <CapabilityRow
        key={row.key}
        testID={`${props.testID}.row.${row.key}`}
        title={title}
        qualifier={props.mixed ? inventoryKindWord(row.kind) : undefined}
        description={presentation?.facts.context ?? null}
        whereSummary={inventoryWhereWords(presentation, props.input, props.names)}
        mark={<RowMark row={row} title={title} input={props.input} />}
        rowRole={titleOnly ? 'item' : undefined}
        divider={false}
        action={row.kind === 'software' && row.subject === 'recipe' ? (
          <SoftwareRecipeRemovalAction row={row} name={title} testID={`${props.testID}.row.${row.key}`} />
        ) : undefined}
        onPress={home ? () => props.go(home) : undefined}
      />
    );
    return props.columns > 1 ? <ItemGroupColumn key={row.key}>{rendered}</ItemGroupColumn> : rendered;
  });
  return (
    <ItemGroup
      testID={props.testID}
      title={section.title}
      titleStyle={props.nested ? styles.nestedTitle : undefined}
      description={section.description}
      titleAccessory={known && !canContinue && section.rows.length > 0 ? <Count value={section.rows.length} /> : undefined}
      action={all}
      // All / Fewer is a short continuation: it stays beside the title (lab ip:all), even above a description.
      actionLayout="trailing"
      surface="none"
    >
      {coverage === 'loading' && section.rows.length === 0 ? <SkeletonRows rows={2} testID={`${props.testID}.loading`} /> : null}
      {none ? (
        <Item testID={`${props.testID}.none`} title={t('storeInstalled.sectionNone')} titleStyle={styles.noneTitle} mode="info" showChevron={false} showDivider={false} />
      ) : null}
      {props.columns > 1 ? (
        <ItemGroupColumns columns={props.columns} paddingHorizontal={0} paddingVertical={0}>{rows}</ItemGroupColumns>
      ) : rows}
      {rail ? (
        // A long open page closes where it ends too: Fewer sits between Previous and Next.
        <View style={styles.paging}>
          {rail.hasPreviousPage ? (
            <SectionActionButton testID={`${props.testID}.previous`} title={t('projects.deployments.pagePrevious')}
              icon="caret-left" onPress={rail.previousPage} />
          ) : null}
          {fewer ? (
            <SectionActionButton icon="caret-up" testID={`${props.testID}.paging.fewer`} title={t('storeInstalled.fewer')}
              onPress={() => setExpanded(false)} />
          ) : null}
          {rail.hasNextPage ? (
            <SectionActionButton testID={`${props.testID}.next`} title={t('projects.deployments.pageNext')}
              destination onPress={rail.nextPage} />
          ) : null}
        </View>
      ) : null}
    </ItemGroup>
  );
}

/**
 * One Machine reason with one fix, said once for every Machine it holds on ("Short on memory · 13 machines"). All
 * opens each Machine's own line, with its fix, in place; nothing is hidden behind another page.
 */
function MachineReasonGroup(
  props: Readonly<{
    line: Extract<ManagedInventoryAttentionLine, { kind: 'group' }>;
    state: ManagedInventorySectionsState;
    input: StoreInstalledInput;
    names: MachineNames;
    go: (href: Href) => void;
    testIDPrefix: string;
  }>,
) {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const toggle = React.useCallback(() => setOpen((value) => !value), []);
  const testID = `${props.testIDPrefix}.${props.line.key}`;
  const count = props.line.entries.length;
  return (
    <>
      <CapabilityRow
        testID={testID}
        title={props.line.word}
        description={t('allMachines.machinesCount', { count })}
        mark={<Icon name="desktop" size={GLYPH_PX} color={theme.colors.text.secondary} />}
        divider={false}
        action={
          <RoundButton
            testID={`${testID}.toggle`}
            size="small"
            display="secondary"
            // The line already says how many: the toggle doesn't repeat it.
            title={open ? t('storeInstalled.fewer') : t('storeInstalled.allUnknown')}
            onPress={toggle}
          />
        }
        onPress={toggle}
      />
      {open ? props.line.entries.map((entry) => (
        <AttentionRow
          key={entry.key}
          entry={entry}
          state={props.state}
          input={props.input}
          names={props.names}
          go={props.go}
          testID={`${props.testIDPrefix}.${entry.key}`}
        />
      )) : null}
    </>
  );
}

/** One current reason and one fix, each from its source owner (S50 §4.5). */
function AttentionRow(
  props: Readonly<{
    entry: ManagedInventoryAttention;
    state: ManagedInventorySectionsState;
    input: StoreInstalledInput;
    names: MachineNames;
    go: (href: Href) => void;
    testID: string;
  }>,
) {
  const { entry } = props;
  const { theme } = useUnistyles();
  const row = 'row' in entry ? entry.row : undefined;
  const presentation = row ? props.state.presentations.get(row.key) : undefined;
  const open = React.useCallback(
    () => props.go(entry.href),
    [props.go, entry.href],
  );
  let title = presentation?.facts.title ?? '';
  let description: string | null = null;
  let status: CapabilityStatus | null = null;
  let fix: string | undefined;
  if (entry.kind === 'machine') {
    title = entry.native.title;
    fix = entry.native.actionLabel;
  } else if (entry.kind === 'notice') {
    title = entry.native.header.title;
    description = entry.native.header.body ?? null;
    fix = t('common.open');
  } else {
    const native = entry.native;
    if (native.kind === 'provider') {
      description = t(PROVIDER_CONNECTION_STATUS_KEY[native.status]);
      fix = t('common.open');
    } else if (native.kind === 'agent') {
      status = { kind: 'signin' };
      fix = presentCapabilityStatus(status, 'row').fixLabel ?? undefined;
    } else if (native.kind === 'unreadable' && 'unavailable' in native) {
      title = skillDisplayName(native.unavailable.title, native.key);
      description = t('capabilities.skills.home.unreadable');
      fix = t('common.retry');
    } else if (
      (native.kind === 'update' ||
        native.kind === 'removed' ||
        native.kind === 'masked') &&
      'item' in native
    ) {
      description =
        native.kind === 'masked'
          ? t('capabilities.skills.home.maskedOn', {
              machine: native.machineName,
            })
          : native.kind === 'removed'
            ? t('capabilities.skills.home.removedFromSource')
            : native.item.modified
              ? t('capabilities.skills.home.modifiedUpstream')
              : t('capabilities.skills.home.updateWaiting');
      fix =
        native.kind === 'masked'
          ? t('capabilities.skillsFound.compare')
          : native.kind === 'removed'
            ? t('capabilities.skills.home.decide')
            : t('capabilities.skills.home.review');
    } else {
      status = native as CapabilityStatus;
      fix = presentCapabilityStatus(status, 'row').fixLabel ?? undefined;
    }
  }
  const where = inventoryWhereWords(presentation, props.input, props.names);
  return (
    <CapabilityRow
      testID={props.testID}
      title={title}
      qualifier={row ? inventoryKindWord(row.kind) : undefined}
      description={[where, description].filter(Boolean).join(' · ') || null}
      status={status}
      mark={
        row ? (
          <RowMark row={row} title={title} input={props.input} />
        ) : (
          <Icon
            name={entry.kind === 'machine' ? 'desktop' : 'bell'}
            size={MARK_PX}
            color={theme.colors.text.secondary}
          />
        )
      }
      divider={false}
      action={
        fix ? (
          <RoundButton
            testID={`${props.testID}.fix`}
            size="small"
            display="secondary"
            title={fix}
            onPress={open}
          />
        ) : undefined
      }
      onPress={open}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  nestedTitle: { color: theme.colors.text.secondary },
  // An empty section's line is a quiet note, not a row title.
  noneTitle: { color: theme.colors.text.secondary },
  count: { color: theme.colors.text.secondary, fontVariant: ['tabular-nums'] },
  // The native collection's own page controls (the Deployments rail's Previous / Next), centred under the rows.
  paging: { flexDirection: 'row', justifyContent: 'center', gap: theme.space.s8, paddingVertical: theme.space.s8 },
}));

export const MANAGED_INVENTORY_PREVIEW_ROWS = PREVIEW_ROWS;
