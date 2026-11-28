import * as React from 'react';
import { UsageChartInteractions } from '../usageChartInteractions';
import { UsageAgentColorProvider, useUsageAgentColor } from '../usageAccent';
import { useUsageModelPricesAction } from './UsageModelPrices';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { UsageBuiltinWidgetIdV1 } from '@happier-dev/protocol/widgets';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useWidgetFrameResourceActivity } from '@/components/widgets/frame/widgetFrameResourceActivity';
import { t } from '@/text';
import { UsageBodyReadFailed, UsageBodyReading, type UsageBodyProps, type UsageWidgetPresentationInputs } from './usageBodyKit';
import { UsageExactHistoryDemandContext } from './usageMountedControls';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import { useUsageWidgetModel } from './usageWidgetBatch';
import { useUsageQueryActions } from './useUsageQueryActions';
import { UsageDailyReading, UsageDailyWidget } from './UsageDailyWidget';
import type { UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { UsageWidgetBodyModel } from '../useUsageWidgetResource';
import { UsagePeriodSummaryWidget } from './UsagePeriodSummaryWidget';
import { UsageCostFactsReading, UsageCostFactsWidget } from './UsageCostFactsWidget';
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
import { readUsageQueryBodyReadState, UsageBodyReadingPlaceholderContext, UsageBodySettledReportContext, usageBodyOccurrence, useReportUsageBodySettled, useUsageBodyHeightMemory, type UsageBodyReadState } from './usageBodyHeightMemory';

const NOT_READ: UsageBodyReadState = Object.freeze({ facts: false, settled: false });

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


/**
 * Facts a host already holds and admitted (an Environment's own App calls read, priced by the viewer's Usage prices),
 * drawn through the same bodies and lifecycle states instead of the page's query Resource.
 */
export type UsageWidgetSuppliedFacts = Readonly<{
  /** The Account the facts were read for. */
  authority: ServerAccountScope;
  query: UsageQuery;
  slice: UsageQueryResultSlice | null;
  pending: boolean;
  error: UsageWidgetBodyModel['error'];
  refresh: () => Promise<void>;
}>;

export type UsageWidgetBodyInput = Readonly<{
  id: UsageBuiltinWidgetIdV1;
  /** The platform binder's resolved input (widget value → group → surface slot). */
  input: Readonly<Record<string, JsonValue>>;
  serverId: string;
  testID: string;
  /** The host supplies the facts; the body reads no Usage query Resource of its own. */
  facts?: UsageWidgetSuppliedFacts;
  coveragePresentation?: UsageBodyProps['coveragePresentation'];
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
  const [readState, setReadState] = React.useState<UsageBodyReadState>(NOT_READ);
  const report = React.useCallback((next: UsageBodyReadState) => setReadState(current =>
    current.facts === next.facts && current.settled === next.settled ? current : next), []);
  const [placeholders, setPlaceholders] = React.useState(0);
  const registerPlaceholder = React.useCallback(() => {
    setPlaceholders(count => count + 1);
    return () => setPlaceholders(count => count - 1);
  }, []);
  const shown = React.useMemo((): UsageBodyReadState => placeholders > 0 && readState.facts
    ? { facts: false, settled: readState.settled } : readState, [placeholders, readState]);
  const memory = useUsageBodyHeightMemory(usageBodyOccurrence(props.serverId, props.testID), shown);
  return <UsageChartInteractions>
    <UsageBodyReadingPlaceholderContext.Provider value={registerPlaceholder}>
    <UsageBodySettledReportContext.Provider value={report}>
      <View style={memory.style === undefined ? styles.body : [styles.body, memory.style]} onLayout={memory.onLayout}>
        {props.id === 'usage_sources'
          ? <UsageSourcesWidget input={props.input} serverId={props.serverId} testID={props.testID} />
          : props.facts ? <UsageSuppliedWidgetBody {...props} id={props.id} facts={props.facts} />
          : <UsageQueryWidgetBody {...props} id={props.id} />}
      </View>
    </UsageBodySettledReportContext.Provider>
    </UsageBodyReadingPlaceholderContext.Provider>
  </UsageChartInteractions>;
}

function UsageQueryWidgetBody(
  props: UsageWidgetBodyInput &
    Readonly<{ id: Exclude<UsageBuiltinWidgetIdV1, 'usage_sources'> }>,
) {
  const { model, query, acquireExactHistory } = useUsageWidgetModel(props.input, props.id);
  return <UsageExactHistoryDemandContext.Provider value={acquireExactHistory}>
    <UsageQueryWidgetActions {...props} query={model.slice?.shownQuery ?? query} slice={model.slice} />
    <UsageQueryWidgetContent {...props} model={model} query={query} />
  </UsageExactHistoryDemandContext.Provider>;
}

const NO_EXACT_HISTORY = () => () => {};

/** Host-supplied facts take the same content path; there is no query Resource, period change or frame command. */
function UsageSuppliedWidgetBody(
  props: UsageWidgetBodyInput &
    Readonly<{ id: Exclude<UsageBuiltinWidgetIdV1, 'usage_sources'>; facts: UsageWidgetSuppliedFacts }>,
) {
  const { authority, query, slice, pending, error, refresh } = props.facts;
  const model = React.useMemo((): UsageWidgetBodyModel => {
    const identity = { query, authority };
    return { requestedQuery: identity, shownQuery: identity, slice, pending, error, freshness: 'fresh',
      updatingPreviousPeriod: false, refreshing: false, refresh: async () => { await refresh(); } };
  }, [authority, query, slice, pending, error, refresh]);
  return <UsageExactHistoryDemandContext.Provider value={NO_EXACT_HISTORY}>
    <UsageQueryWidgetContent {...props} model={model} query={query} />
  </UsageExactHistoryDemandContext.Provider>;
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
  const agentColor = useUsageAgentColor(slice);
  // Dim only facts that are being replaced: a previous period held while the new one arrives. A
  // re-read of the shown facts keeps them at full strength and says "Refreshing" in the frame's meta
  // slot; a source that is still outstanding is said by the body's own coverage line.
  const replacing = slice !== null && model.updatingPreviousPeriod;
  useWidgetFrameResourceActivity(replacing || model.refreshing);
  const readState = readUsageQueryBodyReadState(query, model);
  useReportUsageBodySettled(readState.settled, readState.facts);
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
    coveragePresentation={props.coveragePresentation}
  /> : null, [Body, props.id, model.refresh, slice, props.serverId, props.testID, props.coveragePresentation, ownInputs]);
  // A first read holds the room of the shape that lands (Period summary's figures, the Coach's strip), so the
  // widgets below it do not move when the facts arrive; every other body holds three list rows.
  const presentation = useWidgetPresentation();
  const readingShape = props.id === 'usage_period_summary' ? { kind: 'summary' as const }
    : props.id === 'usage_capacity' ? { kind: 'capacity' as const }
    : props.id === 'usage_coach' && isUsageCoachStrip(presentation) ? { kind: 'strip' as const } : undefined;
  if (!query)
    return (
      <SurfaceStateCard
        testID={`${props.testID}.invalid`}
        kind="unavailable"
        replacesContent
        title={t('usage.board.page.queryInvalidTitle')}
        reason={t('usage.board.page.queryInvalidReason')}
      />
    );
  if (!slice) {
    if (model.error && !model.pending)
      return <UsageBodyReadFailed errorCode={model.error.code} testID={props.testID} onRetry={model.refresh} />;
    if (!model.requestedQuery && !model.pending)
      return (
        <SurfaceStateCard
          testID={`${props.testID}.unavailable`}
          kind="unavailable"
          replacesContent
          title={t('usage.board.page.signedOutTitle')}
        />
      );
    // Pending is never zero: the rows' space is held until the first facts arrive.
    // Daily holds its chart's room under the name its bars will have, so neither moves when the facts arrive.
    if (props.id === 'usage_daily') return <UsageDailyReading query={query} testID={`${props.testID}.loading`} />;
    if (readingShape) return <UsageBodyReading testID={`${props.testID}.loading`} shape={readingShape} />;
    // Cost facts lead with figures: its first read holds a figure-led block, never list rows (r223 #66).
    if (props.id === 'usage_cost_facts') return <UsageCostFactsReading testID={`${props.testID}.loading`} />;
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
      <UsageAgentColorProvider value={agentColor}>{factBody}</UsageAgentColorProvider>
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
