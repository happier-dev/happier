import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { UsageBuiltinWidgetIdV1 } from '@happier-dev/protocol/widgets';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useWidgetFrameResourceActivity } from '@/components/widgets/frame/widgetFrameResourceActivity';
import { t } from '@/text';
import type { UsageBodyProps } from './usageBodyKit';
import { useUsageWidgetModel } from './usageWidgetBatch';
import { useUsageQueryActions } from './useUsageQueryActions';
import { UsageDailyWidget } from './UsageDailyWidget';
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
import { UsageCoachWidget } from './UsageCoachWidget';
import { UsageRhythmWidget } from './UsageRhythmWidget';
import { UsageParallelWidget } from './UsageParallelWidget';
import { UsageHumanLoopWidget } from './UsageHumanLoopWidget';
import { UsageNightShiftWidget } from './UsageNightShiftWidget';
import { UsageRecapWidget } from './UsageRecapWidget';
import { UsageFootprintWidget } from './UsageFootprintWidget';
import { UsageSourcesWidget } from './UsageSourcesWidget';

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
};

export function isUsageBuiltinWidgetId(
  id: string,
): id is UsageBuiltinWidgetIdV1 {
  return id === 'usage_sources' || Object.hasOwn(USAGE_QUERY_BODIES, id);
}

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
  if (props.id === 'usage_sources')
    return (
      <UsageSourcesWidget input={props.input} serverId={props.serverId} testID={props.testID} />
    );
  return <UsageQueryWidgetBody {...props} id={props.id} />;
}

function UsageQueryWidgetBody(
  props: UsageWidgetBodyInput &
    Readonly<{ id: Exclude<UsageBuiltinWidgetIdV1, 'usage_sources'> }>,
) {
  const { model, query } = useUsageWidgetModel(props.input);
  const slice = model.slice;
  // Dim only facts that are being replaced: a previous period held while the new one arrives. A
  // re-read of the shown facts keeps them at full strength and says "Refreshing" in the frame's meta
  // slot; a source that is still outstanding is said by the body's own coverage line.
  const replacing = slice !== null && model.updatingPreviousPeriod;
  useWidgetFrameResourceActivity(replacing || model.refreshing);
  // Ask and Copy act on the query the body is showing (the held one while a new period arrives).
  useUsageQueryActions(props.id, slice?.shownQuery ?? query);
  const Body = USAGE_QUERY_BODIES[props.id];
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
          action={{ label: t('common.retry'), onPress: model.refresh }}
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
      <Body
        id={props.id}
        model={model}
        slice={slice}
        query={slice.shownQuery}
        serverId={props.serverId}
        testID={props.testID}
      />
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  body: {
    minWidth: 0,
  },
  replacing: {
    opacity: 0.55,
  },
}));
