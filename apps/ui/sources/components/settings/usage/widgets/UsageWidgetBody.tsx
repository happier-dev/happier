import * as React from 'react';
import { UsageChartInteractions } from '../usageChartInteractions';
import { useUsageModelPricesAction } from './UsageModelPrices';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { UsageBuiltinWidgetIdV1 } from '@happier-dev/protocol/widgets';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useWidgetFrameResourceActivity } from '@/components/widgets/frame/widgetFrameResourceActivity';
import { t } from '@/text';
import { UsageBodyReading, type UsageBodyProps, type UsageWidgetPresentationInputs } from './usageBodyKit';
import { useUsageRetryCommand } from './usageMountedControls';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import { useUsageWidgetModel } from './usageWidgetBatch';
import { useUsageQueryActions } from './useUsageQueryActions';
import { UsageDailyWidget, resolveUsageDailyChartShape } from './UsageDailyWidget';
import { useDeviceType } from '@/utils/platform/responsive';
import type { UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageWidgetBodyModel } from '../useUsageWidgetResource';
import { UsagePeriodSummaryWidget } from './UsagePeriodSummaryWidget';
import { UsageCostFactsWidget } from './UsageCostFactsWidget';
import { UsageFlowWidget } from './UsageFlowWidget';
import { UsageEfficiencyWidget } from './UsageEfficiencyWidget';
import { UsageBreakdownsWidget } from './UsageBreakdownsWidget';
import { UsageCapacityWidget } from './UsageCapacityWidget';
import { UsageProjectionsWidget } from './UsageProjectionsWidget';
import { UsageResetPlannerWidget } from './UsageResetPlannerWidget';
import { UsagePlanFitWidget } from './UsagePlanFitWidget';
import { UsageProjectLedgerWidget } from './UsageProjectLedgerWidget';
import { UsageSessionValueWidget } from './UsageSessionValueWidget';
import { UsageOutcomesWidget } from './UsageOutcomesWidget';
import { UsageCoachWidget, isUsageCoachStrip } from './UsageCoachWidget';
import { UsageRhythmWidget } from './UsageRhythmWidget';
import { UsageParallelWidget } from './UsageParallelWidget';
import { UsageHumanLoopWidget } from './UsageHumanLoopWidget';
import { UsageNightShiftWidget } from './UsageNightShiftWidget';
import { UsageRecapWidget } from './UsageRecapWidget';
import { UsageFootprintWidget } from './UsageFootprintWidget';
import { UsageSourcesWidget } from './UsageSourcesWidget';
import { UsageSourceCoverageWidget, UsageUnpricedWidget } from './UsageSourcePanels';
import { UsageConstellationBody, UsagePlanetBody, UsageRunLengthBody, UsageScoreBody } from './UsageChartStyleBodies';
import { UsageAtmosphereBody, UsageMachinesBody, UsageOrbitStyleBody, UsageProjectsBody } from './UsagePlanetFamilyBodies';
import { UsageBodySettledReportContext, useReportUsageBodySettled, useUsageBodyHeightMemory } from './usageBodyHeightMemory';

/** The one body per builtin Usage definition; all share the descriptor owner's ids. */
const USAGE_QUERY_BODIES: Readonly<
  Record<
    Exclude<UsageBuiltinWidgetIdV1, 'usage_sources'>,
    React.ComponentType<UsageBodyProps>
  >
> = {
  usage_daily: UsageDailyWidget,
  usage_period_summary: UsagePeriodSummaryWidget,
  usage_cost_facts: UsageCostFactsWidget,
  usage_flow: UsageFlowWidget,
  usage_efficiency: UsageEfficiencyWidget,
  usage_breakdowns: UsageBreakdownsWidget,
  usage_capacity: UsageCapacityWidget,
  usage_projections: UsageProjectionsWidget,
  usage_resets: UsageResetPlannerWidget,
  usage_plan_fit: UsagePlanFitWidget,
  usage_project_ledger: UsageProjectLedgerWidget,
  usage_session_value: UsageSessionValueWidget,
  usage_outcomes: UsageOutcomesWidget,
  usage_coach: UsageCoachWidget,
  usage_rhythm: UsageRhythmWidget,
  usage_parallel: UsageParallelWidget,
  usage_human_loop: UsageHumanLoopWidget,
  usage_night_shift: UsageNightShiftWidget,
  usage_recap: UsageRecapWidget,
  usage_footprint: UsageFootprintWidget,
  usage_source_coverage: UsageSourceCoverageWidget,
  usage_unpriced: UsageUnpricedWidget,
  usage_score: UsageScoreBody,
  usage_orbit: UsageOrbitStyleBody,
  usage_constellation: UsageConstellationBody,
  usage_planet: UsagePlanetBody,
  usage_run_length: UsageRunLengthBody,
  usage_machines: UsageMachinesBody,
  usage_projects: UsageProjectsBody,
  usage_atmosphere: UsageAtmosphereBody,
};


export type UsageWidgetBodyInput = Readonly<{
  id: UsageBuiltinWidgetIdV1;
  /** The platform binder's resolved input (widget value → group → surface slot). */
  input: Readonly<Record<string, JsonValue>>;
  serverId: string;
  testID: string;
}>;

/**
 * Mounted by the generic builtin dispatch for every Usage occurrence (Usage page, Home, Project,
 * Session Usage). Lifecycle states live here once; bodies render admitted facts only.
 */
export function UsageWidgetBody(
  props: UsageWidgetBodyInput,
): React.ReactElement {
  // Cold-load geometry is decided here once for every Usage body: until a body's reads settle it holds the
  // height it last settled at on this device (same occurrence and width), so arrivals land inside that room.
  const [settled, setSettled] = React.useState(false);
  const width = useWidgetPresentation()?.geometry?.width;
  const memory = useUsageBodyHeightMemory(`${props.serverId}:${props.testID}`, width, settled);
  return <UsageChartInteractions>
    <UsageBodySettledReportContext.Provider value={setSettled}>
      <View style={memory.minHeight === undefined ? styles.body : [styles.body, { minHeight: memory.minHeight }]} onLayout={memory.onLayout}>
        {props.id === 'usage_sources'
          ? <UsageSourcesWidget input={props.input} serverId={props.serverId} testID={props.testID} />
          : <UsageQueryWidgetBody {...props} id={props.id} />}
      </View>
    </UsageBodySettledReportContext.Provider>
  </UsageChartInteractions>;
}

function UsageQueryWidgetBody(
  props: UsageWidgetBodyInput &
    Readonly<{ id: Exclude<UsageBuiltinWidgetIdV1, 'usage_sources'> }>,
) {
  const { model, query } = useUsageWidgetModel(props.input, props.id);
  return <>
    <UsageQueryWidgetActions {...props} query={model.slice?.shownQuery ?? query} slice={model.slice} />
    <UsageQueryWidgetContent {...props} model={model} query={query} />
  </>;
}

/** Command credential resolution updates the frame's actions, independently of its facts. */
function UsageQueryWidgetActions(props: UsageWidgetBodyInput & Readonly<{
  query: UsageQuery | null;
  slice: UsageWidgetBodyModel['slice'];
}>) {
  const pricesAction = useUsageModelPricesAction(props.id === 'usage_cost_facts' || props.id === 'usage_unpriced' ? props.slice : null, props.serverId, props.testID);
  useUsageQueryActions(props.id, props.query, pricesAction);
  return null;
}

function UsageQueryWidgetContent(props: UsageWidgetBodyInput & Readonly<{
  id: Exclude<UsageBuiltinWidgetIdV1, 'usage_sources'>;
  model: UsageWidgetBodyModel;
  query: UsageQuery | null;
}>) {
  const { model, query } = props;
  const slice = model.slice;
  const retry = useUsageRetryCommand(model.refresh, !!query && !slice && !!model.error && !model.pending);
  // Dim only facts that are being replaced: a previous period held while the new one arrives. A
  // re-read of the shown facts keeps them at full strength and says "Refreshing" in the frame's meta
  // slot; a source that is still outstanding is said by the body's own coverage line.
  const replacing = slice !== null && model.updatingPreviousPeriod;
  useWidgetFrameResourceActivity(replacing || model.refreshing);
  // Settled for the cold-load floor: facts are shown and none of their sources is still being read.
  useReportUsageBodySettled(!query || (slice !== null
    ? !slice.sources.some(source => source.status === 'pending' || source.status === 'not_loaded')
    : !!model.error && !model.pending || !model.requestedQuery && !model.pending));
  const Body = USAGE_QUERY_BODIES[props.id];
  const style = props.input.style, colourBy = props.input.colourBy, day = props.input.day;
  // Keyed on the three scalars so an unrelated input change keeps the body's props stable.
  const ownInputs = React.useMemo(() => readUsagePresentationInputs({ ...(style !== undefined ? { style } : {}), ...(colourBy !== undefined ? { colourBy } : {}), ...(day !== undefined ? { day } : {}) }), [style, colourBy, day]);
  // Frame activity and batch registration do not change admitted facts. Bodies
  // consume only the refresh command from the Resource model; keep that narrow
  // contract at the dispatch boundary while loading and frame meta still update.
  const factBody = React.useMemo(() => slice ? <Body
    id={props.id}
    model={{ refresh: model.refresh }}
    slice={slice}
    query={slice.shownQuery}
    serverId={props.serverId}
    testID={props.testID}
    presentation={ownInputs}
  /> : null, [Body, props.id, model.refresh, slice, props.serverId, props.testID, ownInputs]);
  // A first read holds the room of the shape that lands (Period summary's figures, the Coach's strip), so the
  // widgets below it do not move when the facts arrive; every other body holds three list rows.
  const presentation = useWidgetPresentation();
  const phone = useDeviceType() === 'phone';
  const readingShape = props.id === 'usage_period_summary' ? { kind: 'summary' as const }
    : props.id === 'usage_capacity' ? { kind: 'capacity' as const }
    : props.id === 'usage_coach' && isUsageCoachStrip(presentation) ? { kind: 'strip' as const }
    : props.id === 'usage_daily' ? resolveUsageDailyChartShape(presentation, phone) : undefined;
  if (!query)
    return (
      <SurfaceStateCard
        testID={`${props.testID}.invalid`}
        kind="unavailable"
        layout="inline"
        size="line"
        title={t('usage.board.page.queryInvalidTitle')}
        reason={t('usage.board.page.queryInvalidReason')}
      />
    );
  if (!slice) {
    if (model.error && !model.pending)
      return (
        <SurfaceStateCard
          testID={`${props.testID}.error`}
          kind="error"
          layout="inline"
          title={t('usage.board.page.readFailedTitle')}
          reason={t('usage.board.page.readFailedReason')}
          diagnosticCode={model.error.code}
          action={{ label: t('common.retry'), onPress: retry }}
        />
      );
    if (!model.requestedQuery && !model.pending)
      return (
        <SurfaceStateCard
          testID={`${props.testID}.unavailable`}
          kind="unavailable"
          layout="inline"
          size="line"
          title={t('usage.board.page.signedOutTitle')}
        />
      );
    // Pending is never zero: the rows' space is held until the first facts arrive.
    if (readingShape) return <UsageBodyReading testID={`${props.testID}.loading`} shape={readingShape} />;
    return (
      <ItemLoadStateRows
        testID={`${props.testID}.loading`}
        state={{ kind: 'loading' }}
        rows={3}
        lines={2}
        shape="list"
        accessibilityLabel={t('usage.board.page.loading')}
      />
    );
  }
  return (
    <View
      testID={props.testID}
      style={[styles.body, replacing ? styles.replacing : null]}
      accessibilityState={{ busy: replacing }}
    >
      {factBody}
    </View>
  );
}

/** The widget's own presentation inputs, read once from the binder's resolved input. */
function readUsagePresentationInputs(input: Readonly<Record<string, JsonValue>>): UsageWidgetPresentationInputs {
  const text = (value: JsonValue | undefined) => typeof value === 'string' && value.length > 0 ? value : undefined;
  const style = text(input.style), colourBy = text(input.colourBy), day = text(input.day);
  return { ...(style ? { style } : {}), ...(colourBy ? { colourBy } : {}), ...(day ? { day } : {}) };
}

const styles = StyleSheet.create(() => ({
  body: {
    minWidth: 0,
  },
  replacing: {
    opacity: 0.55,
  },
}));
