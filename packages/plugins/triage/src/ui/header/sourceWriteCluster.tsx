import * as React from 'react';
import {
  Button,
  Icon,
  Menu,
  Popover,
  Row,
  Stack,
  Text,
  usePluginTranslation,
  useSurfaceContext,
  type IconName,
  type HappierTone,
  type MenuGroup,
  type MenuItem,
} from '@happier-dev/plugin-ui';
import type { TriageDetailPrimaryWriteV1 } from '@happier-dev/triage-sources/ui';

import {
  presentTriageMergeReadinessV1,
  type TriageMergeReadinessV1,
  type TriageReadinessCountV1,
  type TriageReadinessRowStateV1,
  type TriageReadinessRowV1,
} from './mergeReadiness.js';

/**
 * The source's own write in the entry header (plan 06, lab 'forge-ci/b4'): Merge with the one line that says what
 * still blocks it, the requirements it opens, Merge's alternatives, and the native queue and auto-merge states.
 *
 * The source keeps custody of every write and its confirmation; this control only calls 'execute' on the write or
 * the alternative the reader chose, so the source's Action admission, the host's confirmation and agent approval
 * stay the only gates. A write without merge status (Mark ready) is one plain button.
 */

const ROW_GLYPH: Readonly<
  Record<
    TriageReadinessRowStateV1,
    Readonly<{ icon: IconName; tone: HappierTone }>
  >
> = Object.freeze({
  met: { icon: 'check', tone: 'secondary' },
  failed: { icon: 'failure', tone: 'danger' },
  needed: { icon: 'attention', tone: 'attention' },
  waiting: { icon: 'waiting', tone: 'secondary' },
  unknown: { icon: 'info', tone: 'muted' },
});

/** A count sentence in the reader's plural form, from 'plugins.triage.<key>.<form>' then its '.other', then English. */
function useReadinessCount(): TriageReadinessCountV1 {
  const text = usePluginTranslation();
  const { locale } = useSurfaceContext();
  const rules = React.useMemo(() => {
    try {
      return new Intl.PluralRules(locale);
    } catch {
      return new Intl.PluralRules('en');
    }
  }, [locale]);
  return React.useCallback(
    (key, count, english) => {
      const values = { count: String(count) };
      const form = rules.select(count);
      const other = text(`plugins.triage.${key}.other`, english.other, values);
      return form === 'other'
        ? other
        : text(`plugins.triage.${key}.${form}`, form === 'one' ? english.one : other, values);
    },
    [rules, text],
  );
}

/** A native state line (the merge queue, auto-merge) stands where the write's button would, and says its own state. */
export function triageSourceWriteReplacedByNativeStateV1(
  write: TriageDetailPrimaryWriteV1,
): boolean {
  return write.id === 'dequeue' || write.alternatives?.some((alternative) => alternative.id === 'cancelAutoMerge') === true;
}

function ReadinessRows({
  rows,
}: Readonly<{ rows: readonly TriageReadinessRowV1[] }>): React.ReactElement {
  return (
    <Stack gap="small">
      {rows.map((row) => {
        const glyph = ROW_GLYPH[row.state];
        const met = row.state === 'met';
        return (
          <Row key={row.id} gap="small" align="flex-start">
            <Icon name={glyph.icon} size="small" tone={glyph.tone} />
            <Stack style={ROW_TEXT_STYLE}>
              <Text
                variant="label"
                tone={met ? 'secondary' : 'neutral'}
                value={row.title}
              />
              <Text variant="meta" tone="secondary" value={row.detail} />
            </Stack>
          </Row>
        );
      })}
    </Stack>
  );
}

function ReadinessLine({
  view,
  source,
}: Readonly<{
  view: TriageMergeReadinessV1;
  source: string;
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  const { locale } = useSurfaceContext();
  const [open, setOpen] = React.useState(false);
  const line = view.line;
  if (line === null) return null;
  const spoken =
    line.detail === null ? line.words : `${line.words}, ${line.detail}`;
  const checked =
    view.checkedAtMs === null
      ? null
      : new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(view.checkedAtMs);
  const footer =
    view.stale && checked !== null
      ? text(
          'plugins.triage.surface.merge.footer.stale',
          'As of {time} · {source} couldn’t be reached just now',
          { time: checked, source },
        )
      : text('plugins.triage.surface.merge.footer', 'What {source} reports for this pull request', {
          source,
        });
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={line.words}
      triggerAppearance="status"
      triggerTextTone={line.tone}
      triggerTextVariant="meta"
      {...(line.detail === null ? {} : { triggerDetail: line.detail })}
      {...(line.marks.length === 0 ? {} : { triggerMarks: line.marks })}
      triggerAccessibilityLabel={text(
        'plugins.triage.surface.merge.line.label',
        'Merge readiness: {state}',
        { state: spoken },
      )}
      contentAccessibilityLabel={view.head}
      floatingRole="panel"
      placement="bottom"
      sheet={{ title: view.head }}
    >
      <Stack gap="medium" style={POPOVER_STYLE}>
        <Stack gap="xsmall">
          <Text variant="heading" value={view.head} />
          {view.sub === null ? null : (
            <Text variant="meta" tone="secondary" value={view.sub} />
          )}
        </Stack>
        {view.rows.length === 0 ? null : <ReadinessRows rows={view.rows} />}
        <Text variant="micro" tone="muted" value={footer} />
      </Stack>
    </Popover>
  );
}

/** One alternative row, or one group of method rows when the alternative asks how to merge. */
function alternativeEntries(
  write: TriageDetailPrimaryWriteV1,
  text: ReturnType<typeof usePluginTranslation>,
  source: string,
) {
  const items: MenuItem[] = [];
  const groups: MenuGroup[] = [];
  const runs = new Map<string, () => void>();
  for (const alternative of write.alternatives ?? []) {
    if (alternative.id === 'cancelAutoMerge') continue;
    const destructive = alternative.id === 'withoutWaiting';
    const subtitle = destructive
      ? text(
          'plugins.triage.surface.merge.withoutWaiting.subtitle',
          '{source} reports you may do this on this pull request',
          { source },
        )
      : alternative.id === 'enableAutoMerge'
        ? text(
            'plugins.triage.surface.merge.autoMerge.subtitle',
            '{source} merges it once the requirements are met',
            { source },
          )
        : undefined;
    const blocked = alternative.pending || alternative.disabledReason !== null;
    const methods = alternative.methods;
    if (methods !== undefined && methods.length > 1 && !blocked) {
      groups.push({
        id: alternative.id ?? alternative.title,
        accessibilityLabel: alternative.title,
        items: methods.map((method) => {
          const id = `${alternative.id ?? alternative.title}:${method.id}`;
          runs.set(id, () => {
            void alternative.execute(method.id);
          });
          return {
            id,
            label: method.title,
            ...(destructive ? { destructive: true } : {}),
          };
        }),
      });
      continue;
    }
    const id = alternative.id ?? alternative.title;
    const only = methods?.length === 1 ? methods[0] : undefined;
    runs.set(id, () => {
      void (only === undefined
        ? alternative.execute()
        : alternative.execute(only.id));
    });
    items.push({
      id,
      label: destructive ? `${alternative.title}…` : alternative.title,
      ...(destructive ? { destructive: true } : {}),
      ...(blocked
        ? { disabled: true, subtitle: alternative.disabledReason ?? undefined }
        : subtitle === undefined
          ? {}
          : { subtitle }),
    });
  }
  return { items, groups, runs };
}

/**
 * Merge's alternatives (merge without waiting, auto-merge, a method choice) as menu content. The one owner of what
 * they are, what they run and why bypassing is unavailable; the header folds them into its one ⋯, and a card
 * without its own menu draws them behind `MergeChoices`.
 */
export type TriageMergeChoicesV1 = Readonly<{
  label: string;
  items: readonly MenuItem[];
  /**
   * What the source says about merging (its head sentence, then each requirement), as quiet rows that lead the
   * action row's ⋯ when the row has no room for the readiness line (lab c7 keeps the header to one row). Empty
   * when the write carries no merge status.
   */
  readinessItems: readonly MenuItem[];
  groups: readonly MenuGroup[];
  run: (id: string) => boolean;
  /** The menu sheet's title: refused until requirements are met, or the choices' own name. */
  sheetTitle: string;
  explanation: React.ReactElement | null;
}>;

export function useTriageMergeChoicesV1(
  write: TriageDetailPrimaryWriteV1 | undefined,
  sourceLabel: string | undefined,
): TriageMergeChoicesV1 | null {
  const text = usePluginTranslation();
  const count = useReadinessCount();
  if (write === undefined) return null;
  // A native state line (auto-merge on, queued) replaces Merge and its alternatives.
  if (write.id === 'dequeue' || write.alternatives?.some((alternative) => alternative.id === 'cancelAutoMerge') === true) return null;
  if (write.readiness === undefined && write.nativeStatus === undefined) return null;
  const source = sourceLabel ?? text('plugins.triage.surface.merge.sourceFallback', 'the source');
  const { items, groups, runs } = alternativeEntries(write, text, source);
  const view = presentTriageMergeReadinessV1(write, text, count, source);
  const readinessItems: MenuItem[] = view === null ? [] : [
    { id: 'triage-merge-readiness:head', label: view.head, disabled: true, ...(view.sub === null ? {} : { subtitle: view.sub }) },
    ...view.rows.map((row) => ({ id: `triage-merge-readiness:${row.id}`, label: row.title, subtitle: row.detail, disabled: true })),
  ];
  const bypassOffered = write.alternatives?.some((alternative) => alternative.id === 'withoutWaiting') === true;
  const refused = (write.unmetRequirements?.length ?? 0) > 0;
  // Never a disabled bypass control: when the source does not offer it, one quiet line under the choices says so.
  const explanation = refused && !bypassOffered ? (
    <Text
      variant="meta"
      tone="secondary"
      value={text(
        'plugins.triage.surface.merge.withoutWaiting.unavailable',
        'Merging without waiting for requirements isn’t available to you on this pull request.',
      )}
    />
  ) : null;
  if (items.length === 0 && groups.length === 0 && explanation === null && readinessItems.length === 0) return null;
  const label = text('plugins.triage.surface.merge.options', 'Merge options');
  return {
    label,
    items,
    readinessItems,
    groups,
    run: (id) => {
      const run = runs.get(id);
      if (run === undefined) return false;
      run();
      return true;
    },
    sheetTitle: refused
      ? text('plugins.triage.surface.merge.options.refused', 'Merge is refused until requirements are met')
      : label,
    explanation,
  };
}

function MergeChoices({ choices }: Readonly<{ choices: TriageMergeChoicesV1 }>): React.ReactElement | null {
  const [open, setOpen] = React.useState(false);
  // Beside its own readiness line, a card's ⋯ holds only the alternatives.
  if (choices.items.length === 0 && choices.groups.length === 0 && choices.explanation === null) return null;
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      trigger={choices.label}
      triggerIcon="more"
      triggerAccessibilityLabel={choices.label}
      items={[...choices.items]}
      {...(choices.groups.length === 0 ? {} : { groups: [...choices.groups], showGroupLabels: true })}
      sheet={{
        title: choices.sheetTitle,
        ...(choices.explanation === null ? {} : { footer: choices.explanation }),
      }}
      onSelect={(id) => {
        setOpen(false);
        choices.run(id);
      }}
    />
  );
}

/** The write itself: a method is always the reader's explicit choice, never a default picked for them. */
function PrimaryWrite({
  write,
  quiet,
}: Readonly<{
  write: TriageDetailPrimaryWriteV1;
  quiet: boolean;
}>): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const methods = write.methods;
  const blocked =
    write.pending ||
    write.reading === true ||
    write.disabledReason !== null ||
    (methods !== undefined && methods.length === 0);
  if (methods !== undefined && methods.length > 1 && !blocked) {
    return (
      <Menu
        open={open}
        onOpenChange={setOpen}
        trigger={write.title}
        triggerAppearance={quiet ? 'control' : 'primary'}
        triggerAccessibilityLabel={write.title}
        items={methods.map((method) => ({
          id: method.id,
          label: method.title,
        }))}
        onSelect={(id) => {
          setOpen(false);
          void write.execute(id);
        }}
      />
    );
  }
  const only = methods?.length === 1 ? methods[0] : undefined;
  return (
    <Button
      // One method is still an explicit choice: the menu row it would have been is the button's name.
      title={only === undefined || blocked ? write.title : only.title}
      variant={quiet || blocked ? 'secondary' : 'primary'}
      size="small"
      disabled={blocked}
      busy={write.pending}
      onPress={() =>
        only === undefined ? write.execute() : write.execute(only.id)
      }
    />
  );
}

/** A native state that replaces Merge while GitHub holds it: queued, or set to merge on its own. */
function NativeStateLine({
  icon,
  words,
  detail,
  action,
}: Readonly<{
  icon: IconName;
  words: string;
  detail: string | null;
  action: TriageDetailPrimaryWriteV1;
}>): React.ReactElement {
  return (
    <Row gap="small" align="center">
      <Icon name={icon} size="small" tone="secondary" />
      <Text variant="meta" value={words} numberOfLines={1} />
      {detail === null ? null : (
        <Text
          variant="meta"
          tone="secondary"
          value={detail}
          numberOfLines={1}
        />
      )}
      <Button
        title={action.title}
        variant="plain"
        size="small"
        disabled={action.pending || action.disabledReason !== null}
        busy={action.pending}
        onPress={() => action.execute()}
      />
    </Row>
  );
}

export function TriageSourceWriteCluster(
  props: Readonly<{
    write: TriageDetailPrimaryWriteV1;
    /** The source's name as the reader knows it ("GitHub"); the readiness copy says whose answer it reports. */
    sourceLabel?: string | undefined;
    /**
     * Where Merge's alternatives live: behind the cluster's own ⋯ (default), or in the enclosing action row's one ⋯,
     * which reads them from `useTriageMergeChoicesV1`.
     */
    choices?: 'own' | 'host';
  }>,
): React.ReactElement {
  const { write } = props;
  const text = usePluginTranslation();
  const count = useReadinessCount();
  const source = props.sourceLabel ?? text('plugins.triage.surface.merge.sourceFallback', 'the source');
  const choices = useTriageMergeChoicesV1(write, props.sourceLabel);
  const view = React.useMemo(
    () => presentTriageMergeReadinessV1(write, text, count, source),
    [write, text, count, source],
  );
  if (view === null) return <PrimaryWrite write={write} quiet />;
  const cancelAutoMerge = write.alternatives?.find(
    (alternative) => alternative.id === 'cancelAutoMerge',
  );
  if (cancelAutoMerge !== undefined) {
    const method = view.autoMerge?.method ?? null;
    return (
      <NativeStateLine
        icon="waiting"
        words={text(
          'plugins.triage.surface.merge.autoMerge.on',
          'Merges when the requirements are met',
        )}
        detail={
          method === null
            ? null
            : method === 'squash'
              ? text('plugins.triage.surface.merge.autoMerge.method.squash', 'Squash')
              : method === 'rebase'
                ? text('plugins.triage.surface.merge.autoMerge.method.rebase', 'Rebase')
                : text('plugins.triage.surface.merge.autoMerge.method.merge', 'Merge commit')
        }
        action={cancelAutoMerge}
      />
    );
  }
  if (write.id === 'dequeue') {
    const position = view.queue?.position ?? null;
    const eta = view.queue?.etaSeconds ?? null;
    return (
      <NativeStateLine
        icon="list"
        words={
          position === null
            ? text('plugins.triage.surface.merge.queue.in', 'In the merge queue')
            : text('plugins.triage.surface.merge.queue.position', '#{position} in the merge queue', {
                position: String(position),
              })
        }
        detail={
          eta === null
            ? null
            : count('surface.merge.queue.eta', Math.max(1, Math.round(eta / 60)), {
                one: 'about 1 min',
                other: 'about {count} min',
              })
        }
        action={write}
      />
    );
  }
  return (
    <Row gap="small" align="center" wrap>
      {/* In the action row (`host`), the readiness leads the row's ⋯ instead, so the header stays one row. */}
      {props.choices === 'host' ? null : <ReadinessLine view={view} source={source} />}
      <Row gap="xsmall" align="center">
        <PrimaryWrite write={write} quiet />
        {choices === null || props.choices === 'host' ? null : <MergeChoices choices={choices} />}
      </Row>
    </Row>
  );
}

const ROW_TEXT_STYLE = Object.freeze({ flexShrink: 1, minWidth: 0 });
const POPOVER_STYLE = Object.freeze({ maxWidth: 420 });
