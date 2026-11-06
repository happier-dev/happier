import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import type { UsageModelPriceOverridesV1 } from '@happier-dev/protocol/usage/usageModelPriceCatalog';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ITEM_ROW_PADDING_HORIZONTAL } from '@/components/ui/lists/itemDensityMetrics';
import { useResolvedItemDensity } from '@/components/ui/lists/useResolvedItemDensity';
import { SelectionList } from '@/components/ui/selectionList/SelectionList';
import { SelectionListFilterChip } from '@/components/ui/selectionList/SelectionListFilterChips';
import { Text } from '@/components/ui/text/Text';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { Typography } from '@/constants/Typography';
import { useSetting } from '@/sync/domains/state/storage';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { formatUsageObservedAt } from '@/sync/domains/usage/usageCalendarPresentation';
import {
  buildUsagePriceEditorModel,
  createUsageModelPriceSettingsIntent,
  type UsagePriceEditorRow,
} from '@/sync/domains/usage/usagePriceEditorModel';
import { formatTokenCount, formatUsageCost } from '@/utils/format/usageNumbers';
import { t } from '@/text';
import { USAGE_SETTINGS } from '../usageSettings';
import { usageDimensionLabel } from './usageBodyKit';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import { usePlanText } from './plans/UsagePlanParts';
import type { ItemAction } from '@/components/ui/lists/itemActions';

type RateField = 'input' | 'output' | 'cacheRead' | 'cacheWrite';
const RATE_FIELDS: readonly RateField[] = [
  'input',
  'output',
  'cacheRead',
  'cacheWrite',
];
const RATE_KEY = {
  input: 'inputUsdPerMillion',
  output: 'outputUsdPerMillion',
  cacheRead: 'cacheReadUsdPerMillion',
  cacheWrite: 'cacheWriteUsdPerMillion',
} as const;
const RATE_TITLE = {
  input: 'usage.board.page.priceInput',
  output: 'usage.board.page.priceOutput',
  cacheRead: 'usage.board.page.priceCacheRead',
  cacheWrite: 'usage.board.page.priceCacheWrite',
} as const;

/**
 * The model prices behind every API-equivalent figure (U10): where they come from and how old they
 * are, which models have none, and a per-model "Set price", "Price as…" and "Reset". Every edit is
 * the Account's own `usage.modelPrices` setting through the ordinary settings Action, so history
 * re-prices at query time; reported and invoiced money never change.
 */
export function UsageModelPricesEditor(props: Readonly<{ slice: UsageQueryResultSlice; serverId: string; testID: string }>) {
  const overrides = useSetting('usageModelPriceOverridesV1');
  const model = React.useMemo(() => buildUsagePriceEditorModel(props.slice, overrides), [props.slice, overrides]);
  const rows = React.useMemo(() => [...model.rows].filter(row => row.modelId !== null)
    // What needs a decision first: unpriced, then the viewer's own prices, then the catalog.
    .sort((left, right) => rank(left) - rank(right)), [model.rows]);
  return (
    <View style={styles.body} testID={props.testID}>
      <UsagePriceProvenance provenance={model.provenance} serverId={props.serverId} testID={`${props.testID}.provenance`} />
      <View style={styles.rows}>
        {rows.map((row, index) => <UsageModelPriceRow key={row.modelId!} row={row} overrides={overrides}
          mappingTargets={model.mappingTargets} serverId={props.serverId} last={index === rows.length - 1}
          testID={`${props.testID}.model.${row.modelId}`} />)}
      </View>
    </View>
  );
}

/**
 * One quiet line under the money facts: whose prices, how old, how many models have none, and the
 * editor behind it. The editor opens as a sheet so any widget size keeps its facts whole.
 */
export function UsageModelPricesLine(props: Readonly<{ slice: UsageQueryResultSlice; serverId: string; testID: string }>) {
  const text = usePlanText();
  const overrides = useSetting('usageModelPriceOverridesV1');
  const model = React.useMemo(() => buildUsagePriceEditorModel(props.slice, overrides), [props.slice, overrides]);
  const unpriced = model.rows.filter(row => row.modelId !== null && row.effectivePrice === null).length;
  const asOf = t('usage.board.page.pricesAsOf', { date: formatUsageObservedAt(model.provenance.asOfMs) });
  const open = () => openUsageModelPrices(props.slice, props.serverId, props.testID);
  return (
    <View style={styles.provenance} testID={props.testID}>
      <Text style={[styles.quiet, text.detail, styles.grow]} numberOfLines={1}>
        {asOf}
        {unpriced ? <Text style={styles.attention}>{` · ${t('usage.board.page.pricesUnpriced', { count: unpriced })}`}</Text> : null}
      </Text>
      <RoundButton size="small" display="secondary" title={t('usage.board.page.pricesTitle')}
        testID={`${props.testID}.open`} onPress={open} />
    </View>
  );
}

/** The one way into the price editor, from the facts line and from the Cost facts ⋯ menu. */
function openUsageModelPrices(slice: UsageQueryResultSlice, serverId: string, testID: string): void {
  Modal.show({
    component: UsageModelPricesSheet,
    props: { slice, serverId, testID: `${testID}.editor` },
    chrome: { kind: 'card', material: 'solid', title: t('usage.board.page.pricesTitle'), phonePresentation: 'sheet',
      dimensions: { size: 'md' }, testID: `${testID}.sheet` },
  });
}

/** The Cost facts ⋯ entry; any widget size reaches the editor even when the line has no room. */
export function useUsageModelPricesAction(slice: UsageQueryResultSlice | null, serverId: string, testID: string): ItemAction | null {
  const latest = React.useRef(slice);
  latest.current = slice;
  const available = slice !== null;
  return React.useMemo(() => available ? {
    id: 'usageModelPrices',
    title: t('usage.board.page.pricesTitle'),
    icon: 'currency-dollar',
    onPress: () => { if (latest.current) openUsageModelPrices(latest.current, serverId, `${testID}.prices`); },
  } : null, [available, serverId, testID]);
}

function UsageModelPricesSheet(props: Readonly<{ slice: UsageQueryResultSlice; serverId: string; testID: string }> & CustomModalInjectedProps) {
  return (
    <ScrollView style={styles.sheet} contentContainerStyle={styles.sheetContent}>
      <UsageModelPricesEditor slice={props.slice} serverId={props.serverId} testID={props.testID} />
    </ScrollView>
  );
}

/** The sheet's own lines (provenance, the open row's fields) start on the model rows' edge. */
function useModelPriceRowInset() {
  const density = useResolvedItemDensity();
  return React.useMemo(() => ({ paddingHorizontal: ITEM_ROW_PADDING_HORIZONTAL[density] }), [density]);
}

function rank(row: UsagePriceEditorRow): number {
  return row.effectivePrice === null ? 0 : row.override ? 1 : 2;
}

/** Fetched, bundled or switched-off prices say so, with Refresh only where the Home fetches. */
function UsagePriceProvenance(
  props: Readonly<{
    provenance: ReturnType<typeof buildUsagePriceEditorModel>['provenance'];
    serverId: string;
    testID: string;
  }>,
) {
  const text = usePlanText();
  const rowInset = useModelPriceRowInset();
  const [state, setState] = React.useState<'idle' | 'refreshing' | 'failed'>(
    'idle',
  );
  const note =
    props.provenance.fetchStatus === 'disabled'
      ? t('usage.board.page.pricesFetchDisabled')
      : props.provenance.fetchStatus === 'error' || state === 'failed'
        ? t('usage.board.page.pricesFetchFailed')
        : null;
  const { execute, isCurrent } = useMountedActionExecution(props.serverId);
  const refresh = async () => {
    if (!isCurrent()) return;
    setState('refreshing');
    try {
      const executed = await execute('usage.prices.refresh', {});
      if (isCurrent()) setState(executed.ok || isActionApprovalDeclinedErrorCode(executed.errorCode) ? 'idle' : 'failed');
    } catch {
      if (isCurrent()) setState('failed');
    }
  };
  return (
    <View style={[styles.provenance, rowInset]}>
      <Text style={[styles.quiet, text.detail, styles.grow]}>
        {[t('usage.board.page.pricesAsOf', { date: formatUsageObservedAt(props.provenance.asOfMs) }), note].filter(Boolean).join(' · ')}
      </Text>
      {props.provenance.fetchStatus === 'disabled' ? null : (
        <RoundButton
          size="small"
          display="inverted"
          title={t('usage.board.page.pricesRefresh')}
          loading={state === 'refreshing'}
          disabled={state === 'refreshing'}
          testID={`${props.testID}.refresh`}
          onPress={() => {
            void refresh();
          }}
        />
      )}
    </View>
  );
}

/**
 * One model, one row: its name, where its price comes from (with a trouble dot when it has none) and
 * the rates in the tabular column. The row opens in place to change them — rates, Price as… and Reset
 * live there, not as buttons repeated on every row.
 */
function UsageModelPriceRow(
  props: Readonly<{
    row: UsagePriceEditorRow;
    overrides: UsageModelPriceOverridesV1;
    mappingTargets: readonly string[];
    serverId: string;
    last: boolean;
    testID: string;
  }>,
) {
  const modelId = props.row.modelId!;
  const { setSetting } = useSettingActionFeedback({ serverId: props.serverId });
  const [expanded, setExpanded] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const write = async (override: UsageModelPriceOverridesV1[string] | null) => {
    setBusy(true);
    try {
      const intent = createUsageModelPriceSettingsIntent(props.overrides, {
        modelId,
        override,
      });
      const accepted = await setSetting(
        USAGE_SETTINGS.settings.modelPrices,
        intent.input.value,
      );
      if (accepted) setExpanded(false);
    } finally {
      setBusy(false);
    }
  };
  const price = props.row.effectivePrice;
  const unpricedTokens = props.row.unpricedTokens;
  const source =
    price === null
      ? t('usage.board.page.priceNone')
      : price.source === 'mapping'
        ? t('usage.board.page.priceMapped', {
            model: usageDimensionLabel('model', price.modelId),
          })
        : price.source === 'override'
          ? t('usage.board.page.priceYours')
          : t('usage.board.page.priceCatalog');
  return (
    <ExpandableItem
      testID={props.testID}
      expanded={expanded}
      onExpandedChange={setExpanded}
      showDivider={!props.last}
      header={(state) => (
        <Item
          {...state.headerProps}
          testID={`${props.testID}.set`}
          title={usageDimensionLabel('model', modelId)}
          subtitle={price === null && unpricedTokens > 0 ? `${source} · ${formatTokenCount(unpricedTokens)}` : source}
          {...(price === null ? { subtitleLeading: <View style={collectionListStyles.troubleDot} /> } : {})}
          {...(price ? { detail: t('usage.board.page.priceRates', {
            input: formatUsageCost(price.rates.inputUsdPerMillion, 'USD'),
            output: formatUsageCost(price.rates.outputUsdPerMillion, 'USD'),
          }), detailStyle: styles.rates } : {})}
        />
      )}
    >
      <UsageModelPriceFields
        row={props.row}
        modelId={modelId}
        mappingTargets={props.mappingTargets}
        busy={busy}
        testID={props.testID}
        onCancel={() => setExpanded(false)}
        onMap={(target) => {
          void write({ kind: 'map', modelId: target });
        }}
        {...(props.row.override ? { onReset: () => { void write(null); } } : {})}
        onSave={(rates) => {
          void write({ kind: 'rates', ...rates });
        }}
      />
    </ExpandableItem>
  );
}

/**
 * The open row: four rates in $ per million tokens (input and output needed, cache rates optional),
 * then the other ways to price it — as another model, or back to the catalog — and one Save.
 */
function UsageModelPriceFields(
  props: Readonly<{
    row: UsagePriceEditorRow;
    modelId: string;
    mappingTargets: readonly string[];
    busy: boolean;
    testID: string;
    onCancel: () => void;
    onMap: (target: string) => void;
    onReset?: () => void;
    onSave: (rates: {
      inputUsdPerMillion: number;
      outputUsdPerMillion: number;
      cacheReadUsdPerMillion?: number;
      cacheWriteUsdPerMillion?: number;
    }) => void;
  }>,
) {
  const text = usePlanText();
  const rowInset = useModelPriceRowInset();
  const start =
    props.row.override?.kind === 'rates'
      ? props.row.override
      : props.row.catalogPrice;
  const [values, setValues] = React.useState<Record<RateField, string>>(
    () =>
      Object.fromEntries(
        RATE_FIELDS.map((field) => {
          const value = start?.[RATE_KEY[field]];
          // Catalog rates are binary floats ("0.09999999999"); show the decimal a person typed.
          return [field, value === undefined ? '' : String(Number(value.toPrecision(12)))];
        }),
      ) as Record<RateField, string>,
  );
  const parsed = Object.fromEntries(
    RATE_FIELDS.map((field) => {
      const raw = values[field].trim();
      const value = raw === '' ? undefined : Number(raw.replace(',', '.'));
      return [field, value];
    }),
  ) as Record<RateField, number | undefined>;
  const valid =
    RATE_FIELDS.every(
      (field) =>
        parsed[field] === undefined ||
        (Number.isFinite(parsed[field]) && parsed[field]! >= 0),
    ) &&
    parsed.input !== undefined &&
    parsed.output !== undefined;
  return (
    <View style={[styles.fields, rowInset]}>
      <View style={styles.fieldRow}>
        {RATE_FIELDS.map((field) => (
          <FieldItem key={field} label={t(RATE_TITLE[field])} style={styles.field}>
            <FieldTextInput
              testID={`${props.testID}.${field}`}
              value={values[field]}
              inputMode="decimal"
              keyboardType="decimal-pad"
              accessibilityLabel={`${t(RATE_TITLE[field])}, ${t('usage.board.page.priceUnit')}`}
              onChangeText={(next) =>
                setValues((current) => ({ ...current, [field]: next }))
              }
            />
          </FieldItem>
        ))}
      </View>
      <Text style={[styles.quiet, text.detail]}>
        {t('usage.board.page.priceUnit')}
      </Text>
      <View style={styles.footer}>
        <UsageModelPriceMapChip
          modelId={props.modelId}
          targets={props.mappingTargets}
          disabled={props.busy}
          onChoose={props.onMap}
          testID={`${props.testID}.map`}
        />
        {props.onReset ? (
          <RoundButton
            size="small"
            display="inverted"
            title={t('usage.board.page.priceReset')}
            disabled={props.busy}
            testID={`${props.testID}.reset`}
            onPress={props.onReset}
          />
        ) : null}
        <View style={styles.grow} />
        <RoundButton
          size="small"
          display="secondary"
          title={t('usage.board.page.priceCancel')}
          disabled={props.busy}
          testID={`${props.testID}.cancel`}
          onPress={props.onCancel}
        />
        <RoundButton
          size="small"
          title={t('usage.board.page.priceSave')}
          disabled={!valid || props.busy}
          loading={props.busy}
          testID={`${props.testID}.save`}
          onPress={() => {
            if (!valid) return;
            props.onSave({
              inputUsdPerMillion: parsed.input!,
              outputUsdPerMillion: parsed.output!,
              ...(parsed.cacheRead === undefined
                ? {}
                : { cacheReadUsdPerMillion: parsed.cacheRead }),
              ...(parsed.cacheWrite === undefined
                ? {}
                : { cacheWriteUsdPerMillion: parsed.cacheWrite }),
            });
          }}
        />
      </View>
    </View>
  );
}

/** "Price as…": the shared chip with a searchable list of the catalog's models. */
function UsageModelPriceMapChip(
  props: Readonly<{
    modelId: string;
    targets: readonly string[];
    disabled: boolean;
    testID: string;
    onChoose: (target: string) => void;
  }>,
) {
  const options = React.useMemo(
    () =>
      props.targets
        .filter((target) => target !== props.modelId)
        .map((target) => ({ id: target, label: target })),
    [props.targets, props.modelId],
  );
  return (
    <SelectionListFilterChip
      filter={{
        id: 'map',
        label: t('usage.board.page.priceMap'),
        valueLabel: t('usage.board.page.priceMap'),
        disabled: props.disabled || options.length === 0,
        renderPopoverContent: ({ close, maxHeight }) => (
          <SelectionList
            testID={`${props.testID}.list`}
            maxHeight={maxHeight}
            disableTransitions
            listAccessibilityLabel={t('usage.board.page.priceMap')}
            rootStep={{
              id: 'price-map',
              inputPlaceholder: t('usage.board.page.priceSearchModels'),
              sections: [{ kind: 'static', id: 'targets', options }],
            }}
            onSelect={(id: string) => {
              close();
              props.onChoose(id);
            }}
            onRequestClose={close}
          />
        ),
        testID: props.testID,
      }}
    />
  );
}


const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.space.s4 },
  sheet: { maxHeight: 640 },
  // The provenance line starts on the title's edge; the model rows carry their own row inset.
  sheetContent: { paddingBottom: theme.space.s16 },
  provenance: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s12 },
  grow: { flex: 1, minWidth: 0 },
  rows: { gap: 0 },
  quiet: { ...Typography.default(), color: theme.colors.text.secondary },
  attention: {
    ...Typography.default(),
    color: theme.colors.state.warning.foreground,
  },
  rates: { fontVariant: ['tabular-nums'] },
  fields: { gap: theme.space.s10, paddingBottom: 14 },
  fieldRow: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s12 },
  field: { flexGrow: 1, flexBasis: 120, minWidth: 0 },
  footer: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: theme.space.s8, paddingTop: theme.space.s2 },
}));
