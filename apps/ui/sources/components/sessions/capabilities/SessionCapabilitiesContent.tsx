import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { HAPPIER_MENU_ROW_TEXT, HAPPIER_STATE_LINE_METRICS } from '@happier-dev/plugin-ui/presentation';

import { CapabilityRow, type CapabilityRowProps } from '@/components/capabilities/row/CapabilityRow';
import { presentCapabilityStatus } from '@/components/capabilities/status/capabilityStatusPresentation';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { Icon } from '@/components/ui/icons/Icon';
import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import { Item } from '@/components/ui/lists/Item';
import { MENU_ROW_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

import type {
  SessionCapabilitiesModel,
  SessionCapabilityAddItem,
  SessionCapabilityRowModel,
} from './sessionCapabilitiesModel';

export type SessionCapabilitiesChange = (
  change: Readonly<{
    kind: 'skill' | 'mcp_server' | 'native_skill';
    id: string;
    state: 'on' | 'off' | 'inherit';
  }>,
) => Promise<unknown>;

/** The person's last add or removal, held by the controller for an in-place Undo ("pdf added · Undo"). */
export type SessionCapabilitiesUndo = Readonly<{
  title: string;
  change: 'added' | 'removed';
  onUndo: () => void;
}>;

/** The row control and mounted commands use the same Session removal intent. */
export function sessionCapabilityRowRemovalState(row: SessionCapabilityRowModel): 'off' | 'inherit' | null {
  if (row.action.kind === 'turn_on' || row.readOnlyReason !== null || row.dimmed) return null;
  return row.line2?.kind === 'change' && row.line2.change === 'added' ? 'inherit' : 'off';
}

export type SessionCapabilitiesContentProps = Readonly<{
  model: SessionCapabilitiesModel;
  /** A dedicated destination uses the same controls for one capability kind. */
  kind?: 'skills';
  /**
   * `embedded`: hosted inside another page's row (Session Info's Skills row, owner 11-16 F1). The host owns the
   * scroll, the heading and the edges: no scroller or top rule of its own, no group heading that repeats the host
   * row, dividers on the row inset, and the destinations as trailing rows.
   */
  presentation?: 'popover' | 'embedded';
  skillDetails?: (skillId: string) => Pick<CapabilityRowProps, 'description' | 'mark' | 'note' | 'onPress'>;
  skillSection?: (skillId: string) => Readonly<{ key: string; title: string; order?: number }>;
  adding?: boolean;
  onAddingChange?: (adding: boolean) => void;
  onChange: SessionCapabilitiesChange;
  /** Present while the last change can still be taken back; drawn by the shared line state above the footer. */
  undo?: SessionCapabilitiesUndo | null;
  testID: string;
  /** The popover's remaining height budget; the body scrolls under the fixed add field and footer. */
  maxHeight?: number;
  /** The MCP server's admitted identity mark, by catalog id. */
  renderMark?: (serverId: string) => React.ReactNode;
  /** The explicit retry for a failed or offline preview (always issues the request). */
  onRetry?: () => void;
  /** Destinations: the Skills and MCP servers pages ("Browse" for an empty group). */
  onOpen?: (destination: 'skills' | 'mcp') => void;
  openUnavailableReason?: string | null;
  /** Display name of the session's machine, for the offline line. */
  machineName?: string;
  /** The rows each group held when last seen: the first-load placeholders reserve that many (else the preview size). */
  knownRows?: Readonly<{ skills: number; mcp: number }>;
}>;

/** A group shows this many rows before "n more" (layout density, not a data cap; L3 §12). */
const GROUP_PREVIEW_ROWS = 6;

/**
 * The placeholder rows a group holds while the first preview loads, so the loaded rows land in the box that was
 * reserved (layout reservation, not a data cap): what the group held when last seen, else a full preview. A group
 * that held more than a preview also reserves the "n more" line.
 */
function skeletonRowsFor(known: number | undefined): Readonly<{ rows: number; reservesMore: boolean }> {
  if (known === undefined) return { rows: GROUP_PREVIEW_ROWS, reservesMore: false };
  return { rows: Math.min(Math.max(known, 1), GROUP_PREVIEW_ROWS), reservesMore: known > GROUP_PREVIEW_ROWS };
}
/** A placeholder row stands in a loaded menu row's box: two lines, so the real rows land without a jump. */
const SKELETON_ROW_BOX = {
  minHeight: MENU_ROW_METRICS.minHeightPx,
  paddingVertical: MENU_ROW_METRICS.paddingVerticalPx,
} as const;
const SKELETON_ROW_LINES = [
  HAPPIER_MENU_ROW_TEXT.label.lineHeight,
  HAPPIER_MENU_ROW_TEXT.subtitle.lineHeight + MENU_ROW_METRICS.subtitleGapPx,
] as const;
const SKELETON_ROW_GEOMETRY = {
  insetStart: MENU_ROW_METRICS.paddingHorizontalPx,
  insetEnd: MENU_ROW_METRICS.paddingHorizontalPx,
  glyphColumn: 0,
  gap: 0,
} as const;

/**
 * "This session gets": the one body for the composer chip's popover and its phone sheet (the shared
 * `AgentInputContentPopover` owns the title band and the presentation). Rows are P5's menu-density
 * `CapabilityRow`: mark | name + line 2 | scope | action, recomposed by the row itself on a phone.
 */
export function SessionCapabilitiesContent(
  props: SessionCapabilitiesContentProps,
): React.ReactElement {
  const { model } = props;
  const embedded = props.presentation === 'embedded';
  const groups = React.useMemo(() => (props.kind ? model.groups.filter(group => group.kind === props.kind) : model.groups)
    .flatMap(group => {
      const sectionFor = props.skillSection;
      if (group.kind !== 'skills' || !sectionFor || group.rows.length === 0) return [{ ...group, key: group.kind, sectionCount: undefined }];
      const sections = new Map<string, Readonly<{ key: string; title: string; order?: number }> & { rows: SessionCapabilityRowModel[] }>();
      for (const row of group.rows) {
        const section = sectionFor(row.id);
        const existing = sections.get(section.key);
        if (existing) existing.rows.push(row);
        else sections.set(section.key, { ...section, rows: [row] });
      }
      const result: Array<SessionCapabilitiesModel['groups'][number] & { key: string; sectionCount: number | undefined }> = [...sections.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map(section => ({ ...group, key: section.key, title: section.title, rows: section.rows,
          nativeRow: null, sectionCount: section.rows.filter(row => !row.dimmed).length }));
      if (group.nativeRow) result.push({ ...group, key: 'native', rows: [], sectionCount: 0 });
      return result;
    }), [model.groups, props.kind, props.skillSection]);
  // The phone sheet's title band sits on the 16 px gutter; menu rows start 12 px in, so the sheet's own
  // content takes the difference and the rows' text meets the title's edge.
  const onPhone = useDeviceType() === 'phone';
  const [localAdding, setLocalAdding] = React.useState(false);
  const adding = props.adding ?? localAdding;
  const setAdding = (value: boolean) => { setLocalAdding(value); props.onAddingChange?.(value); };
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const expand = React.useCallback(
    (key: string) => setExpanded((current) => new Set(current).add(key)),
    [],
  );
  const hasRows = groups.some(
    (group) => group.rows.length > 0 || group.nativeRow !== null,
  );
  const resolvingWithoutRows = model.state === 'resolving' && !hasRows;
  // Without a preview there is nothing to list: an offline machine or a failed check says so once, and
  // never as "No skills yet" groups, which would claim the session gets nothing.
  const groupsUnknown =
    !hasRows && model.state !== 'ready' && model.state !== 'resolving';

  const body = (
    <View testID={`${props.testID}:lists`}>
      {model.state === 'error' ? (
        <View style={styles.stateLine}>
          <SurfaceStateCard
            testID={`${props.testID}:error`}
            kind="error"
            size="line"
            title={t('capabilities.session.sheet.checkFailed')}
            {...(props.onRetry
              ? {
                  action: {
                    label: t('capabilities.status.fix.tryAgain'),
                    onPress: props.onRetry,
                  },
                }
              : {})}
          />
        </View>
      ) : model.state === 'machine_unreachable' ? (
        <View style={styles.stateLine}>
          <SurfaceStateCard
            testID={`${props.testID}:offline`}
            kind="unavailable"
            size="line"
            title={t('capabilities.session.sheet.offline', {
              machine: props.machineName ?? '',
            })}
            {...(props.onRetry
              ? {
                  action: {
                    label: t('capabilities.status.fix.tryAgain'),
                    onPress: props.onRetry,
                  },
                }
              : {})}
          />
        </View>
      ) : null}
      {groupsUnknown
        ? null
        : groups.map((group, index) => {
            const open = props.kind !== undefined || expanded.has(group.kind);
            const visible = open
              ? group.rows
              : group.rows.slice(0, GROUP_PREVIEW_ROWS);
            const hidden = group.rows.length - visible.length;
            const skeleton = skeletonRowsFor(props.knownRows?.[group.kind]);
            // Unknown is never zero: the heading of a group still loading carries no count.
            const count = resolvingWithoutRows
              ? undefined
              : group.sectionCount !== undefined ? group.sectionCount : group.kind === 'skills'
                ? model.counts.skills
                : model.counts.mcp;
            return (
              <View
                key={group.key}
                testID={`${props.testID}:group:${group.key}`}
                style={index > 0 ? (embedded ? styles.groupDividerEmbedded : styles.groupDivider) : null}
              >
                {/* Hosted in a row that already names the kind, the kind's own heading is not said again. */}
                {embedded && group.key === group.kind ? null : <CollectionListGroupLabel
                  presentation="menu"
                  title={group.title}
                  count={count}
                  first={index === 0}
                  trailing={
                    <Text
                      variant="meta"
                      numberOfLines={1}
                      style={styles.trailing}
                    >
                      {group.trailing}
                    </Text>
                  }
                />}
                {resolvingWithoutRows ? (
                  <SkeletonRows
                    testID={`${props.testID}:resolving${index === 0 ? '' : `:${group.kind}`}`}
                    rows={skeleton.rows}
                    rowBox={SKELETON_ROW_BOX}
                    lineHeights={SKELETON_ROW_LINES}
                    geometry={SKELETON_ROW_GEOMETRY}
                    {...(index === 0
                      ? { accessibilityLabel: t('capabilities.session.sheet.checking') }
                      : {})}
                  />
                ) : null}
                {resolvingWithoutRows && skeleton.reservesMore ? (
                  // The "n more" line this group will have, reserved at its height and not drawn.
                  <View style={[styles.more, styles.reserved]} aria-hidden testID={`${props.testID}:resolving-more:${group.kind}`}>
                    <TextLinkButton label={t('capabilities.where.more', { count: 0 })} expanded={false} onPress={() => {}} />
                  </View>
                ) : null}
                <View role="list" accessibilityLabel={group.title}>
                  {visible.map((row) => (
                    <SessionCapabilityRow
                      key={row.key}
                      row={row}
                      onChange={props.onChange}
                      renderMark={props.renderMark}
                      skillDetails={props.skillDetails}
                      testID={`${props.testID}:row:${row.key}`}
                    />
                  ))}
                </View>
                {hidden > 0 ? (
                  <View style={styles.more}>
                    <TextLinkButton
                      label={t('capabilities.where.more', { count: hidden })}
                      expanded={false}
                      onPress={() => expand(group.kind)}
                      testID={`${props.testID}:more:${group.kind}`}
                    />
                  </View>
                ) : null}
                {group.rows.length === 0 &&
                group.nativeRow === null &&
                !resolvingWithoutRows ? (
                  <View style={styles.stateLine}>
                    <SurfaceStateCard
                      testID={`${props.testID}:empty:${group.kind}`}
                      kind="empty"
                      size="line"
                      title={
                        group.kind === 'skills'
                          ? t('capabilities.session.sheet.noSkills')
                          : t('capabilities.session.sheet.noServers')
                      }
                      {...(props.onOpen && !props.openUnavailableReason
                        ? {
                            action: {
                              label: t('capabilities.session.sheet.browse'),
                              onPress: () =>
                                props.onOpen?.(
                                  group.kind === 'skills' ? 'skills' : 'mcp',
                                ),
                            },
                          }
                        : {})}
                    />
                  </View>
                ) : null}
                {group.nativeRow ? (
                  <NativeSkillsRow
                    nativeRow={group.nativeRow}
                    open={expanded.has('native')}
                    onOpen={() => expand('native')}
                    onChange={props.onChange}
                    testID={`${props.testID}:native`}
                  />
                ) : null}
              </View>
            );
          })}
    </View>
  );

  const footer = (
    <View style={embedded ? undefined : styles.footer}>
      {adding ? (
        <SessionCapabilityAddField
          items={props.kind ? model.addItems.filter(item => item.kind === 'skill') : model.addItems}
          onChange={props.onChange}
          onDone={() => setAdding(false)}
          testID={`${props.testID}:add`}
        />
      ) : (
        <AddRow
          onPress={() => setAdding(true)}
          disabled={model.state === 'resolving' && !hasRows}
          testID={`${props.testID}:add`}
        />
      )}
      {embedded ? null : <View style={styles.costLine}>
        <Text
          variant="meta"
          numberOfLines={1}
          style={styles.cost}
          testID={`${props.testID}:cost`}
        >
          {props.kind ? null : model.costLine}
        </Text>
        {props.onOpen && !embedded ? (
          <View style={styles.destinations}>
            <TextLinkButton
              size="meta"
              tone="strong"
              label={t(props.kind ? 'capabilities.skills.pane.allSkills' : 'capabilities.skills.title')}
              disabled={Boolean(props.openUnavailableReason)}
              accessibilityLabel={props.openUnavailableReason
                ? `${t(props.kind ? 'capabilities.skills.pane.allSkills' : 'capabilities.skills.title')}: ${props.openUnavailableReason}`
                : undefined}
              onPress={() => props.onOpen?.('skills')}
              testID={`${props.testID}:open:skills`}
            />
            {props.openUnavailableReason ? <Text variant="meta">{props.openUnavailableReason}</Text> : null}
            {props.kind ? null : <TextLinkButton
              size="meta"
              tone="strong"
              label={t('capabilities.session.mcpServers')}
              onPress={() => props.onOpen?.('mcp')}
              testID={`${props.testID}:open:mcp`}
            />}
          </View>
        ) : null}
      </View>}
      {props.onOpen && embedded ? (
        <Item
          testID={`${props.testID}:open:skills`}
          title={t(props.kind ? 'capabilities.skills.pane.allSkills' : 'capabilities.skills.title')}
          subtitle={props.openUnavailableReason ?? undefined}
          disabled={Boolean(props.openUnavailableReason)}
          density="compact"
          onPress={() => props.onOpen?.('skills')}
        />
      ) : null}
    </View>
  );

  if (embedded) {
    return (
      <View testID={props.testID}>
        {body}
        {props.undo ? (
          <View style={styles.undoLineEmbedded}>
            <SurfaceStateCard
              testID={`${props.testID}:undo`}
              kind="success"
              size="line"
              accessibilitySemantics="status"
              title={
                props.undo.change === 'added'
                  ? t('capabilities.session.sheet.itemAdded', { item: props.undo.title })
                  : t('capabilities.session.sheet.itemRemoved', { item: props.undo.title })
              }
              action={{ label: t('capabilities.session.ask.undo'), onPress: props.undo.onUndo }}
            />
          </View>
        ) : null}
        {footer}
      </View>
    );
  }

  return (
    <View
      testID={props.testID}
      style={[
        styles.root,
        props.kind ? { flex: 1 } : null,
        onPhone ? styles.rootPhone : null,
        props.maxHeight !== undefined ? { maxHeight: props.maxHeight } : null,
      ]}
    >
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {body}
      </ScrollView>
      {props.undo ? (
        <View style={styles.undoLine}>
          <SurfaceStateCard
            testID={`${props.testID}:undo`}
            kind="success"
            size="line"
            accessibilitySemantics="status"
            title={
              props.undo.change === 'added'
                ? t('capabilities.session.sheet.itemAdded', { item: props.undo.title })
                : t('capabilities.session.sheet.itemRemoved', { item: props.undo.title })
            }
            action={{
              label: t('capabilities.session.ask.undo'),
              onPress: props.undo.onUndo,
            }}
          />
        </View>
      ) : null}
      {footer}
    </View>
  );
}

function SessionCapabilityRow(
  props: Readonly<{
    row: SessionCapabilityRowModel;
    onChange: SessionCapabilitiesChange;
    renderMark?: (serverId: string) => React.ReactNode;
    skillDetails?: SessionCapabilitiesContentProps['skillDetails'];
    testID: string;
  }>,
) {
  const { row } = props;
  const details = row.kind === 'skill' ? props.skillDetails?.(row.id) : undefined;
  const set = (state: 'on' | 'off' | 'inherit') =>
    props.onChange({ kind: row.kind, id: row.id, state });
  const status = row.line2?.kind === 'status' ? row.line2.status : null;
  const fix = row.action.kind === 'fix' ? row.action.status : null;
  const fixLabel = fix
    ? presentCapabilityStatus(fix, 'row').fixLabel
    : undefined;
  const removalState = sessionCapabilityRowRemovalState(row);
  const rowAction = row.action;
  const action =
    rowAction.kind === 'turn_on' ? (
      <TextLinkButton
        tone="strong"
        label={t('capabilities.status.fix.turnOn')}
        accessibilityLabel={t('capabilities.session.sheet.turnOnLabel', {
          item: row.title,
        })}
        onPress={() => set(rowAction.state)}
        testID={`${props.testID}:turn-on`}
      />
    ) : (
      <>
        {fix?.fix && fixLabel ? (
          <TextLinkButton
            tone="strong"
            label={fixLabel}
            onPress={fix.fix.onPress}
            testID={`${props.testID}:fix`}
          />
        ) : null}
        {removalState !== null ? (
          <IconButton
            iconName="x"
            size={24}
            variant="plain"
            accessibilityLabel={t('capabilities.session.sheet.removeLabel', {
              item: row.title,
            })}
            tooltip={t('capabilities.session.sheet.removeLabel', {
              item: row.title,
            })}
            onPress={() => set(removalState)}
            testID={`${props.testID}:remove`}
          />
        ) : null}
      </>
    );
  const description =
    row.line2?.kind === 'change'
      ? row.line2.change === 'added'
        ? t('capabilities.session.sheet.added')
        : t('capabilities.session.sheet.turnedOff')
      : null;
  return (
    <CapabilityRow
      density="menu"
      title={row.title}
      description={description ?? details?.description}
      note={details?.note}
      onPress={details?.onPress}
      status={status}
      {...(row.line2?.kind === 'cost'
        ? { facts: { cost: row.line2.cost, presentation: 'row' as const } }
        : {})}
      whereSummary={row.scope}
      mark={
        row.mark === 'none'
          ? details?.mark
          : props.renderMark?.(row.mark.mcpServerId)
      }
      action={action}
      dimmed={row.dimmed}
      testID={props.testID}
    />
  );
}

function NativeSkillsRow(
  props: Readonly<{
    nativeRow: NonNullable<
      SessionCapabilitiesModel['groups'][number]['nativeRow']
    >;
    open: boolean;
    onOpen: () => void;
    onChange: SessionCapabilitiesChange;
    testID: string;
  }>,
) {
  const { nativeRow } = props;
  const cannotTurnOff = nativeRow.rows.every(
    (row) => row.readOnlyReason === 'native_disable_unsupported',
  );
  if (!props.open) {
    return (
      <View style={styles.more}>
        <TextLinkButton
          label={t('capabilities.session.sheet.nativeFound', {
            count: nativeRow.rows.length,
            machine: nativeRow.machineName,
          })}
          expanded={false}
          onPress={props.onOpen}
          testID={props.testID}
        />
      </View>
    );
  }
  return (
    <View testID={props.testID}>
      {cannotTurnOff ? (
        <Text variant="meta" style={styles.nativeNote}>
          {t('capabilities.session.sheet.nativeCantTurnOff', {
            agent: nativeRow.agentName,
          })}
        </Text>
      ) : null}
      {nativeRow.rows.map((row) => (
        <SessionCapabilityRow
          key={row.key}
          row={row}
          onChange={props.onChange}
          testID={`${props.testID}:${row.key}`}
        />
      ))}
    </View>
  );
}

function AddRow(
  props: Readonly<{ onPress: () => void; disabled: boolean; testID: string }>,
) {
  const { theme } = useUnistyles();
  return (
    <Item
      title={t('capabilities.session.sheet.add')}
      icon={<Icon name="plus" size={18} color={theme.colors.text.secondary} />}
      onPress={props.onPress}
      disabled={props.disabled}
      showChevron={false}
      rowRole="menu"
      testID={props.testID}
    />
  );
}

/** PD10: one list — library skills and every item that exists but is off here; a pick adds it for this session. */
function SessionCapabilityAddField(
  props: Readonly<{
    items: readonly SessionCapabilityAddItem[];
    onChange: SessionCapabilitiesChange;
    onDone: () => void;
    testID: string;
  }>,
) {
  const [query, setQuery] = React.useState('');
  const needle = query.trim().toLowerCase();
  const matches = props.items.filter(
    (item) =>
      needle === '' ||
      item.title.toLowerCase().includes(needle) ||
      item.id.toLowerCase().includes(needle),
  );
  return (
    <View testID={props.testID} style={styles.addField}>
      {matches.length === 0 ? (
        <Text
          variant="meta"
          style={styles.addEmpty}
          testID={`${props.testID}:empty`}
        >
          {props.items.length === 0
            ? t('capabilities.session.sheet.nothingToAdd')
            : t('capabilities.session.sheet.noMatch', { query: query.trim() })}
        </Text>
      ) : (
        <ScrollView
          style={styles.addResults}
          keyboardShouldPersistTaps="handled"
        >
          {matches.map((item) => (
            <Item
              key={`${item.kind}:${item.id}`}
              title={item.title}
              subtitle={
                // A pick that can't apply to this running session says why instead of its kind (PD12).
                item.readOnlyReason === 'new_sessions_only'
                  ? t('capabilities.session.apply.newSessionsOnly', { item: '', machine: '' })
                  : item.kind === 'skill'
                    ? t('capabilities.skills.title')
                    : t('capabilities.session.mcpServers')
              }
              disabled={item.readOnlyReason !== null}
              showChevron={false}
              rowRole="menu"
              onPress={() => {
                void props.onChange({
                  kind: item.kind,
                  id: item.id,
                  state: 'on',
                });
                props.onDone();
              }}
              testID={`${props.testID}:pick:${item.kind}:${item.id}`}
            />
          ))}
        </ScrollView>
      )}
      <CompactSearchField
        value={query}
        onChangeText={setQuery}
        placeholder={t('capabilities.session.sheet.search')}
        autoFocus
        accessibilityLabel={t('capabilities.session.sheet.add')}
        onKeyPress={(event) => {
          if (event.nativeEvent.key === 'Escape') props.onDone();
        }}
        testID={`${props.testID}:search`}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The owner's separator between the popover's title band and what this session gets.
  root: {
    minHeight: 0,
    flexShrink: 1,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.subtle,
  },
  rootPhone: {
    paddingHorizontal:
      theme.space.s16 - MENU_ROW_METRICS.paddingHorizontalPx,
  },
  scroll: { flexShrink: 1 },
  scrollContent: { paddingBottom: theme.space.s4 },
  // A state line draws its own column inset; here its glyph starts on the menu rows' text edge.
  stateLine: {
    marginHorizontal:
      MENU_ROW_METRICS.paddingHorizontalPx -
      HAPPIER_STATE_LINE_METRICS.paddingHorizontalPx,
    paddingVertical: theme.space.s8,
  },
  undoLine: {
    marginHorizontal:
      MENU_ROW_METRICS.paddingHorizontalPx -
      HAPPIER_STATE_LINE_METRICS.paddingHorizontalPx,
    paddingVertical: theme.space.s4,
  },
  groupDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.subtle,
    marginTop: theme.space.s8,
  },
  // Hosted in a page row, a rule between groups starts on the rows' text edge, as the host's dividers do.
  groupDividerEmbedded: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.subtle,
    marginTop: theme.space.s8,
    marginLeft: MENU_ROW_METRICS.paddingHorizontalPx,
  },
  undoLineEmbedded: {
    paddingVertical: theme.space.s4,
  },
  trailing: { color: theme.colors.text.tertiary },
  reserved: { opacity: 0 },
  more: {
    paddingHorizontal: theme.space.s12,
    paddingVertical: theme.space.s6,
    alignItems: 'flex-start',
  },
  nativeNote: {
    color: theme.colors.text.secondary,
    paddingHorizontal: theme.space.s12,
    paddingVertical: theme.space.s4,
  },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.subtle,
  },
  costLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
    paddingHorizontal: theme.space.s12,
    paddingVertical: theme.space.s10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.subtle,
  },
  cost: {
    flex: 1,
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  destinations: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
  },
  addField: {
    gap: theme.space.s6,
    paddingHorizontal: theme.space.s8,
    paddingVertical: theme.space.s8,
  },
  addResults: { maxHeight: 220 },
  addEmpty: {
    color: theme.colors.text.secondary,
    paddingHorizontal: theme.space.s4,
    paddingVertical: theme.space.s6,
  },
}));
