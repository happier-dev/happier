import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { MemoryScopeTargetV1 } from '@happier-dev/protocol/actions/executor/types';

import { resolveWorkspaceRefDisplayName, resolveWorkspaceRefDisplayNames } from '@/components/projects/resolveWorkspaceRefDisplayName';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { MemoryDecisionTarget } from '@/sync/ops/promptLibrary/memoryDocuments';
import { t } from '@/text';

import { useMemoryDocument } from './useMemoryDocument';
import type { useSaveMemoryDecision } from './useSaveMemoryDecision';

type Model = ReturnType<typeof useSaveMemoryDecision>;

const noop = () => undefined;

/**
 * The sheet's own gutter already insets its body, so its choice rows sit flush in it: their text
 * starts on the same edge as the Decision and Reason fields instead of one row inset further in.
 */
export const memoryDecisionSheetRowStyle = { paddingHorizontal: 0 } as const;

/**
 * Up to this many places read as one segmented row (lab K2-Sd); more become a menu. A single place is still
 * shown: for a Session it is an alternative to the Session's own default, and for a Discussion it is the
 * held "Only me" row the sheet already showed while loading.
 */
const MAX_SEGMENTS = 3;

/**
 * Segments are for short names (DESIGN.md control table): three content-width segments must fit the
 * sheet's field width, so a longer Project name moves the choice into the field menu instead of
 * breaking inside a segment.
 */
const MAX_SEGMENT_LABEL_CHARS = 16;

/** Which control offers the places: one segmented row for a few short names, otherwise the field menu. */
export function memoryDecisionTargetControl(labels: readonly string[]): 'segmented' | 'menu' | 'none' {
  if (labels.length === 0) return 'none';
  return labels.length <= MAX_SEGMENTS && labels.every((label) => label.length <= MAX_SEGMENT_LABEL_CHARS)
    ? 'segmented'
    : 'menu';
}

export function memoryDecisionTargetId(target: MemoryScopeTargetV1): string {
  return target.scope === 'account'
    ? 'account'
    : `project:${target.projectRef.serverId}:${target.projectRef.projectKey}`;
}

function memoryDecisionBaseLabel(row: MemoryDecisionTarget): string {
  if (row.target.scope === 'account') return t('memoryContext.memory.sheetSaveToOnlyMe');
  return row.label ?? (row.workspaceRef ? resolveWorkspaceRefDisplayName(row.workspaceRef) : row.target.projectRef.projectKey);
}

/** Names for the offered places; Projects that share a name are told apart by the one workspace-label owner. */
export function memoryDecisionTargetLabels(rows: readonly MemoryDecisionTarget[]): ReadonlyMap<string, string> {
  const refs = rows.flatMap((row) => (row.workspaceRef ? [row.workspaceRef] : []));
  const displayNames = resolveWorkspaceRefDisplayNames(refs);
  const namesByRef = new Map(refs.map((ref, index) => [ref, displayNames[index]!]));
  const baseLabels = rows.map(memoryDecisionBaseLabel);
  const counts = new Map<string, number>();
  for (const base of baseLabels) counts.set(base, (counts.get(base) ?? 0) + 1);
  return new Map(rows.map((row, index) => {
    const base = baseLabels[index]!;
    const label = (counts.get(base) ?? 0) > 1 && row.workspaceRef ? namesByRef.get(row.workspaceRef)! : base;
    return [memoryDecisionTargetId(row.target), label] as const;
  }));
}

/** Display-only default. A Session's qualified destination remains owned by its save Action. */
type NaturalTarget = Readonly<{ id: string | null }>;

/** Who can read the chosen memory, from its admitted audience; a memory not yet created is only the person's. */
function TargetAudienceLine(props: Readonly<{ row: MemoryDecisionTarget }>) {
  const { row } = props;
  const source = useMemoryDocument({
    ref: row.ref,
    serverId: row.ref?.serverId ?? null,
    enabled: row.ref !== null,
  });
  const audience = source.view?.audience ?? null;
  const shared =
    row.ref === null
      ? false
      : source.stale
        ? null
        : (source.view?.shared ?? null);
  if (shared === null) return null;
  const text = shared
    ? audience?.team
      ? t('memoryContext.memory.sharedWithTeam', { team: audience.team })
      : t('memoryContext.memory.accessShared')
    : t('memoryContext.memory.accessPrivate');
  return (
    <View style={styles.audience} testID="save-memory-decision.audience">
      <Icon name={shared ? 'users' : 'lock'} size={14} />
      <Text style={styles.meta}>{text}</Text>
    </View>
  );
}

function TargetChoice(
  props: Readonly<{ model: Model; natural: NaturalTarget }>,
) {
  const { model, natural } = props;
  const { targets, selectedTarget, selectTarget, clearTarget, targetCoverage } = model;
  const [menuOpen, setMenuOpen] = React.useState(false);
  const activeId = selectedTarget
    ? memoryDecisionTargetId(selectedTarget)
    : natural.id;
  const active =
    targets.find((row) => memoryDecisionTargetId(row.target) === activeId) ??
    null;
  const locked =
    model.busy || model.notice === 'pending' || model.creationReceipt !== null;
  const choose = React.useCallback(
    (id: string) => {
      const row = targets.find(
        (candidate) => memoryDecisionTargetId(candidate.target) === id,
      );
      // The default is a state, not a selection: choosing it again is the way back to it.
      if (row) {
        if (id === natural.id) clearTarget();
        else selectTarget(row.target);
      }
      setMenuOpen(false);
    },
    [clearTarget, natural.id, selectTarget, targets],
  );
  // A Session's own memory is the default until the person picks a place: the sheet header names it,
  // and the chooser says it is only an optional override.
  const sessionDefault = natural.id === null && selectedTarget === null;
  // A Discussion's default is its own "Only me" option; a Session's is not a catalog row, so it needs its way back.
  const sessionOverridden = natural.id === null && selectedTarget !== null;
  const overrideNote = sessionDefault ? t('memoryContext.memory.sheetSaveToElsewhere') : undefined;
  const labels = React.useMemo(() => memoryDecisionTargetLabels(targets), [targets]);
  const options = React.useMemo(
    () =>
      targets.map((row) => ({
        id: memoryDecisionTargetId(row.target),
        label: labels.get(memoryDecisionTargetId(row.target)) ?? memoryDecisionBaseLabel(row),
      })),
    [labels, targets],
  );
  const control = memoryDecisionTargetControl(options.map((option) => option.label));
  return (
    <View testID="save-memory-decision.target" style={styles.target}>
      {control === 'segmented' ? (
        <SegmentedChoiceItem<string>
          title={t('memoryContext.memory.sheetSaveTo')}
          subtitle={overrideNote}
          options={options}
          value={active ? memoryDecisionTargetId(active.target) : ''}
          onChange={choose}
          testIDPrefix="save-memory-decision.target"
          accessoryLayout="adaptive"
          showDivider={false}
          style={memoryDecisionSheetRowStyle}
          disabled={locked}
        />
      ) : control === 'menu' ? (
        <DropdownMenu
          testID="save-memory-decision.targetMenu"
          open={menuOpen}
          onOpenChange={setMenuOpen}
          items={options.map((option) => ({
            id: option.id,
            title: option.label,
            testID: `save-memory-decision.target:${option.id}`,
          }))}
          selectedId={
            active ? memoryDecisionTargetId(active.target) : undefined
          }
          onSelect={choose}
          search
          searchPlaceholder={t('common.search')}
          itemTrigger={{
            title: t('memoryContext.memory.sheetSaveTo'),
            // A select with nothing chosen still names where the save goes.
            detailFormatter: (selected) => selected?.title
              ?? (sessionDefault ? t('memoryContext.memory.sheetSaveToSessionDefault') : null),
            itemProps: {
              accessoryLayout: 'adaptive',
              disabled: locked,
              showDivider: false,
              style: memoryDecisionSheetRowStyle,
            },
          }}
        />
      ) : null}
      {active ? (
        <TargetAudienceLine
          key={memoryDecisionTargetId(active.target)}
          row={active}
        />
      ) : null}
      {sessionOverridden ? (
        <TextLinkButton
          testID="save-memory-decision.target.default"
          label={t('memoryContext.memory.sheetSaveToBackToSession')}
          tone="quiet"
          size="meta"
          disabled={locked}
          onPress={clearTarget}
        />
      ) : null}
      {targetCoverage === 'partial' ? (
        <Text style={styles.meta}>
          {t('memoryContext.memory.sheetSaveToPartial')}
        </Text>
      ) : null}
    </View>
  );
}

function ChooserBody(
  props: Readonly<{ model: Model; natural: NaturalTarget }>,
) {
  const { model } = props;
  const { refreshTargets, targetStatus, targets } = model;
  // The sheet opening is the demand: the finite read happens once, on first show.
  React.useEffect(() => {
    void refreshTargets();
  }, [refreshTargets]);
  // Loading choices must not turn a display default into an explicit write destination.
  // Only a person's choice calls selectTarget; otherwise save retains the Session/Account owner.
  const naturalId = props.natural.id;
  if (targetStatus === 'unavailable') {
    return (
      <Text testID="save-memory-decision.targetUnavailable" style={styles.meta}>
        {t('memoryContext.memory.sheetSaveToUnavailable')}
      </Text>
    );
  }
  if (targetStatus !== 'ready' || targets.length < 1) {
    // A person's own memory is where a Discussion saves meanwhile; holding its row keeps the sheet from shifting on arrival.
    return naturalId === 'account' ? (
      <SegmentedChoiceItem<string>
        title={t('memoryContext.memory.sheetSaveTo')}
        options={[{ id: 'account', label: t('memoryContext.memory.sheetSaveToOnlyMe') }]}
        value="account"
        onChange={noop}
        testIDPrefix="save-memory-decision.target"
        accessoryLayout="adaptive"
        showDivider={false}
        style={memoryDecisionSheetRowStyle}
        disabled
      />
    ) : null;
  }
  return <TargetChoice model={model} natural={props.natural} />;
}

/** "Save to": Only me and the Projects this person may write, with the real audience of the chosen memory. */
export function SaveMemoryDecisionTargetChooser(
  props: Readonly<{ model: Model }>,
) {
  const { model } = props;
  return <ChooserBody model={model} natural={{ id: model.sessionSource ? null : 'account' }} />;
}

/** The chosen place's name for the header's one-line subtitle; null while it is the Action's own default. */
export function memoryDecisionChosenLabel(model: Model): string | null {
  const { selectedTarget, targets } = model;
  return selectedTarget ? (memoryDecisionTargetLabels(targets).get(memoryDecisionTargetId(selectedTarget)) ?? null) : null;
}

const styles = StyleSheet.create((theme) => ({
  target: { gap: theme.space.s6 },
  audience: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6 },
  meta: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
}));
