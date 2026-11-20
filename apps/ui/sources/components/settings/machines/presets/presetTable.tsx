import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
  Status,
  type CollectionAnatomy,
  type CollectionField,
} from '@happier-dev/plugin-ui';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useTeamBinding } from '@/hooks/teams/useTeamBinding';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { t } from '@/text';
import { formatRelativeTime } from '@/utils/time/formatShortRelativeTime';
import {
  isOpenedManagedMachinePresetV1,
  type ManagedMachinePresetListEntryV1,
} from '@/sync/ops/machines/machinePresetCollectionClient';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
  describePresetImage,
  type PresetImageState,
} from '../managed/presetPreparationPresentation';
import { describeManagedPresetKeyPending } from '../managed/managedNativeFailurePresentation';
import {
  MANAGED_PROVISIONER_MARK_SIZE,
  ManagedPresetMark,
  useManagedPresetFacts,
} from '../managed/useManagedProvisionerPresentation';

/**
 * One preset-shaped record in a table: a preset on Machines → Presets, or a sandbox type a Machine added on its
 * Isolation page (lab ideas-1118-platform scenes 6 and 7, approved as one table spec). Each fact has one cell owner
 * here, so both tables say the image, the size and where it comes from in the same words.
 */
export type PresetTableItem = Readonly<{
  key: string;
  serverId: string;
  accountScope?: ServerAccountScope | null;
  /** `null`: the preset this sandbox was added from can't be read any more; the row keeps its name and says so. */
  preset: ManagedMachinePresetListEntryV1 | null;
  title: string;
  /**
   * Who it is for ("Yours", a Team): a Team's name may still be read, and the row then says nothing rather than
   * "Loading…" (TH D12).
   */
  audience?:
    | Readonly<{ kind: 'account'; label: string }>
    | Readonly<{ kind: 'team'; teamId: string; knownName?: string }>;
  /** A note that ends line 2 (the sandbox type is no longer offered here). */
  note?: string;
  /** What uses it now: machines created from it, or sandboxes running; `undefined` while its owner delivers no fact. */
  inUse?: number;
  /** The Sandboxes table's Runs in cell ("On devbox", a cloud place). */
  runsIn?: string;
}>;

export type PresetTableHost = 'presets' | 'sandboxes';

const NO_IMAGE: PresetImageState = Object.freeze({
  kind: 'none',
  word: '',
  tone: 'quiet',
  line: null,
  next: null,
});

/** An unreadable body cannot tell us whether it has an image. */
export function readPresetTableImage(item: PresetTableItem): PresetImageState {
  if (!item.preset) return { ...NO_IMAGE, word: t('machinePresets.imageNone') };
  return isOpenedManagedMachinePresetV1(item.preset) ? describePresetImage(item.preset) : NO_IMAGE;
}

function describePresetTableKeyPending(item: PresetTableItem) {
  return item.preset && !isOpenedManagedMachinePresetV1(item.preset)
    ? describeManagedPresetKeyPending(item.preset.reason)
    : null;
}

/** Column widths at normal text size; the shared table scales them with the reader's text. */
const COLUMN = Object.freeze({
  size: 136,
  for: 80,
  inUse: 96,
  image: 148,
  lastUsed: 96,
  next: 80,
  runsIn: 132,
  running: 72,
});

/**
 * The table's anatomy for either host. Wide: the name with its provider and place under it, then Size, For (or
 * Runs in), In use (or Running), Image, Last used, then the row's one next step and its "…". A phone draws no
 * columns: line 2 is who it is for (or where it runs), then the image's word, toned only when it needs the person (two
 * lines, lab review 10).
 */
export function usePresetTableAnatomy(
  input: Readonly<{
    host: PresetTableHost;
    /** Columns whose owner delivers a fact today; the others wait for it rather than standing as a column of blanks. */
    facts: Readonly<{ inUse: boolean; lastUsed: boolean; runsIn?: boolean }>;
    onNextStep: (item: PresetTableItem, next: PresetTableStep) => void;
  }>,
): CollectionAnatomy<PresetTableItem> {
  const language = usePreferredLanguage();
  const { host, facts, onNextStep } = input;
  return React.useMemo((): CollectionAnatomy<PresetTableItem> => {
    const fields: CollectionField<PresetTableItem>[] = [
      {
        key: 'size',
        title: t('machinePresets.colSize'),
        minWidth: COLUMN.size,
        priority: 2,
        listColumn: true,
        render: (item) => <PresetSizeCell item={item} />,
      },
      ...(host === 'presets'
        ? [
            {
              key: 'for',
              title: t('machinePresets.colFor'),
              minWidth: COLUMN.for,
              priority: 3,
              listColumn: true,
              render: (item: PresetTableItem) => (
                <PresetAudienceText item={item} style={styles.cell} />
              ),
            },
          ]
        : facts.runsIn
          ? [
              {
                key: 'runsIn',
                title: t('machinePresets.colRunsIn'),
                minWidth: COLUMN.runsIn,
                priority: 3,
                listColumn: true,
                render: (item: PresetTableItem) => (
                  <Text numberOfLines={1} style={styles.cell}>
                    {item.runsIn ?? ''}
                  </Text>
                ),
              },
            ]
          : []),
      ...(facts.inUse
        ? [
            {
              key: 'inUse',
              title:
                host === 'presets'
                  ? t('machinePresets.colInUse')
                  : t('machinePresets.colRunning'),
              minWidth: host === 'presets' ? COLUMN.inUse : COLUMN.running,
              priority: 1,
              listColumn: true,
              render: (item: PresetTableItem) => (
                <PresetInUseCell item={item} host={host} />
              ),
            },
          ]
        : []),
      {
        key: 'image',
        title: t('machinePresets.colImage'),
        minWidth: COLUMN.image,
        priority: 4,
        listColumn: true,
        render: (item) => (
          <PresetImageCell
            image={readPresetTableImage(item)}
            testID={`preset-table.image.${item.key}`}
          />
        ),
      },
      ...(facts.lastUsed
        ? [
            {
              key: 'lastUsed',
              title: t('machinePresets.colLastUsed'),
              minWidth: COLUMN.lastUsed,
              priority: 0,
              listColumn: true,
              render: (item: PresetTableItem) => (
                <PresetLastUsedCell item={item} />
              ),
            },
          ]
        : []),

      // Only the next step stands in a row (lab review 5): Out of date → Rebuild, Failed or Cancelled → Retry. A healthy
      // image is quiet; its Rebuild stays on the preset's page. It is its own column, so a row with a button keeps
      // the same cell edges as the rows without one; a phone row says the image's word and the step stays on the page.
      {
        key: 'next',
        title: '',
        minWidth: COLUMN.next,
        priority: 5,
        listColumn: true,
        control: true,
        align: 'end',
        render: (item: PresetTableItem) => {
          const image = readPresetTableImage(item);
          const next = image.next === 'rebuild' || image.next === 'retry' ? image.next : null;
          return next ? (
            <RoundButton
              testID={`preset-table.next.${item.key}`}
              size="small"
              display="secondary"
              title={next === 'rebuild' ? t('machinePresets.prepareRebuild') : t('common.retry')}
              onPress={() => onNextStep(item, next)}
            />
          ) : null;
        },
      },    ];
    return {
      glyph: (item) =>
        item.preset ? (
          <ManagedPresetMark
            serverId={item.serverId}
            accountScope={item.accountScope}
            preset={item.preset}
            size={MANAGED_PROVISIONER_MARK_SIZE.row}
          />
        ) : null,
      title: (item) => describePresetTableKeyPending(item)?.title ?? item.title,
      // Wide: the provider and where it runs ("Hetzner · Falkenstein"); the columns carry the rest.
      // Narrow: who it is for, then the image's word; the step itself is in the row's "…".
      byline: (item, layout) => {
        const keyPending = describePresetTableKeyPending(item);
        return keyPending ? <Text numberOfLines={2} style={styles.cell}>{keyPending.reason}</Text>
          : layout?.fieldColumns ? (
          <PresetPlaceLine item={item} />
        ) : (
          <PresetPhoneLine item={item} host={host} />
        );
      },
      fields,
      // Only the next step stands beside a row (lab review 5): Out of date → Rebuild, Failed → Retry. A healthy
      // image is quiet; its Rebuild stays on the preset's page. The "…" keeps one slot on every row's end.
      accessibilityLabel: (item) => {
        const keyPending = describePresetTableKeyPending(item);
        return [keyPending?.title ?? item.title, keyPending?.reason ?? readPresetTableImage(item).word, item.note]
          .filter(Boolean)
          .join(', ');
      },
      testID: (item) => `preset-table.row.${item.key}`,
      columnTitles: {
        title:
          host === 'presets'
            ? t('machinePresets.colPreset')
            : t('machinePresets.colSandboxType'),
      },
    };
  }, [
    facts.inUse,
    facts.lastUsed,
    facts.runsIn,
    host,
    language,
    onNextStep,
  ]);
}

function toneOf(image: PresetImageState): 'warning' | 'danger' | 'secondary' {
  return image.tone === 'warning'
    ? 'warning'
    : image.tone === 'danger'
      ? 'danger'
      : 'secondary';
}

/** The image's one word, inked by its tone, with when it was built beneath it on a wide row. */
export const PresetImageCell = React.memo(function PresetImageCell(
  props: Readonly<{ image: PresetImageState; testID?: string }>,
) {
  const { image } = props;
  return (
    <View testID={props.testID} style={styles.imageCell}>
      {image.tone === 'quiet' ? (
        <Text
          numberOfLines={1}
          style={image.kind === 'ready' ? styles.cell : styles.quiet}
        >
          {image.word}
        </Text>
      ) : (
        <Status
          presentation="inline"
          tone={toneOf(image)}
          pulsing={image.tone === 'running'}
          indicator={image.tone === 'running'}
          label={image.word}
        />
      )}
      {image.line ? (
        <Text numberOfLines={1} style={styles.quiet}>
          {image.line}
        </Text>
      ) : null}
    </View>
  );
});

function PresetSizeCell(props: Readonly<{ item: PresetTableItem }>) {
  if (!props.item.preset)
    return (
      <Text numberOfLines={1} style={styles.quiet}>
        —
      </Text>
    );
  return (
    <PresetSizeText
      serverId={props.item.serverId}
      accountScope={props.item.accountScope}
      preset={props.item.preset}
    />
  );
}

function PresetSizeText(
  props: Readonly<{
    serverId: string;
    accountScope?: ServerAccountScope | null;
    preset: ManagedMachinePresetListEntryV1;
  }>,
) {
  const facts = useManagedPresetFacts(props);
  return (
    <Text
      numberOfLines={1}
      style={facts.size.length > 0 ? styles.cell : styles.quiet}
    >
      {facts.size.length > 0 ? facts.size.join(' · ') : '—'}
    </Text>
  );
}

/** A wide row's line 2: the provider and where it runs, then the row's note. */
function PresetPlaceLine(props: Readonly<{ item: PresetTableItem }>) {
  const { item } = props;
  if (!item.preset)
    return item.note ? (
      <Text numberOfLines={1} style={styles.quiet}>
        {item.note}
      </Text>
    ) : null;
  return (
    <PresetPlaceText
      serverId={item.serverId}
      accountScope={item.accountScope}
      preset={item.preset}
      note={item.note}
    />
  );
}

function PresetPlaceText(
  props: Readonly<{
    serverId: string;
    accountScope?: ServerAccountScope | null;
    preset: ManagedMachinePresetListEntryV1;
    note?: string;
  }>,
) {
  const facts = useManagedPresetFacts(props);
  const line = [facts.provider, ...facts.place, props.note]
    .filter(Boolean)
    .join(' · ');
  return line ? (
    <Text numberOfLines={1} style={styles.quiet}>
      {line}
    </Text>
  ) : null;
}

/**
 * A phone row's one line: who it is for (or where it runs), then the image's word
 * ("Acme · Image out of date"). Size and when it was built stay on the preset's page.
 */
function PresetPhoneLine(
  props: Readonly<{ item: PresetTableItem; host: PresetTableHost }>,
) {
  // A phone draws no columns, so line 2 always carries the image's word after who it is for ("Yours · Image ready",
  // "Acme · Image out of date"); only a word that needs the person takes its tone. The separator is its own glyph
  // between gaps, so no trailing space is trimmed away.
  const image = readPresetTableImage(props.item);
  const lead =
    props.host === 'presets'
      ? null
      : [props.item.runsIn, props.item.note].filter(Boolean).join(' · ');
  return (
    <View style={styles.phoneLine}>
      {props.host === 'presets' ? (
        <PresetAudienceText item={props.item} style={styles.quiet} />
      ) : lead ? (
        <Text numberOfLines={1} style={styles.quiet}>{lead}</Text>
      ) : (
        // Where it runs isn't known yet: the type's provider line stands in, so the row keeps its second line.
        <PresetPlaceLine item={props.item} />
      )}
      {image.word === '' ? null : <Text style={styles.quiet}>·</Text>}
      {image.word === '' ? null : image.tone === 'quiet' ? (
        <Text numberOfLines={1} style={styles.cell}>{image.word}</Text>
      ) : (
        <Status
          presentation="inline"
          tone={toneOf(image)}
          pulsing={image.tone === 'running'}
          indicator={false}
          label={image.word}
        />
      )}
    </View>
  );
}

/**
 * The row's "…" item for the image (lab review 5): a healthy or out-of-date image's Rebuild, a failed
 * build's Retry, a kept-but-unbuilt (or stopped) image's Build now. Every width reaches it there; a wide row also shows the
 * attention step as its own button.
 */
export function readPresetTableMenuStep(item: PresetTableItem): Readonly<{ id: PresetTableStep; label: string }> | null {
  const image = readPresetTableImage(item);
  switch (image.kind) {
    case 'ready':
    case 'stale':
      return { id: 'rebuild', label: t('machinePresets.prepareRebuild') };
    case 'failed':
      return { id: 'retry', label: t('common.retry') };
    case 'notBuilt':
      return { id: 'build', label: t('machinePresets.prepareBuild') };
    default:
      return null;
  }
}

export type PresetTableStep = 'build' | 'rebuild' | 'retry';

function PresetAudienceText(
  props: Readonly<{ item: PresetTableItem; style: object }>,
) {
  const audience = usePresetAudience(props.item);
  if (!audience) return null;
  return (
    <Text numberOfLines={1} style={props.style}>
      {audience}
    </Text>
  );
}

/** "Yours", or the Team's name; while a Team's name is read the cell stays empty, never "Loading…" (TH D12). */
function usePresetAudience(item: PresetTableItem): string | null {
  const audience = item.audience;
  const teamId =
    audience?.kind === 'team' && !audience.knownName ? audience.teamId : '';
  const binding = useTeamBinding(item.serverId, teamId);
  if (!audience) return null;
  if (audience.kind === 'account') return audience.label;
  if (audience.knownName) return audience.knownName;
  const state = binding.kind === 'bound' ? binding.state : null;
  return state?.kind === 'ready' && state.team.capabilities.viewTeam
    ? state.team.name
    : state?.kind === 'unavailable'
      ? t('common.unavailable')
      : null;
}

function PresetInUseCell(
  props: Readonly<{ item: PresetTableItem; host: PresetTableHost }>,
) {
  const count = props.item.inUse;
  if (count === undefined) return null;
  if (props.host === 'sandboxes') {
    return (
      <Text
        numberOfLines={1}
        style={[count > 0 ? styles.cell : styles.quiet, styles.tabular]}
      >
        {count > 0 ? String(count) : '—'}
      </Text>
    );
  }
  return (
    <Text numberOfLines={1} style={count > 0 ? styles.cell : styles.quiet}>
      {count > 0
        ? t('machinePresets.inUseMachines', { count })
        : t('machinePresets.inUseNone')}
    </Text>
  );
}

function PresetLastUsedCell(props: Readonly<{ item: PresetTableItem }>) {
  const at = props.item.preset?.lastUsedAt;
  if (at === undefined) return null;
  return (
    <Text numberOfLines={1} style={styles.cell}>
      {formatRelativeTime(at)}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  cell: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
  quiet: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
    flexShrink: 1,
  },
  tabular: {
    ...Typography.tabular(),
  },
  imageCell: {
    minWidth: 0,
  },
  phoneLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
    minWidth: 0,
  },
}));
