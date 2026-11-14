import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Heatmap } from '@happier-dev/plugin-ui/presentation';

import { MachineManagedInventorySection } from '@/components/machines/page/MachineManagedInventorySection';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import {
  ManagedInventoryDirectory,
  RowMark,
} from '@/components/store/inventory/ManagedInventoryDirectory';
import type { ManagedInventorySectionsState } from '@/components/store/inventory/ManagedInventorySections';
import type { ManagedConfiguredCheckRow } from '@/components/store/inventory/managedOperationalInventory';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

import {
  readServiceCheckFacts,
  serviceCheckHistoryStrip,
  type ServiceCheckDay,
  type ServiceCheckStatus,
} from './serviceCheckPresentation';

const NO_OPEN = () => {};
const CHECK_KINDS = ['configuredCheck'] as const;
const WATCHED_KINDS = ['watchedService'] as const;

function statusWord(status: ServiceCheckStatus): string {
  switch (status) {
    case 'up':
      return t('projects.deployments.healthUp');
    case 'down':
      return t('projects.deployments.healthDown');
    case 'degraded':
      return t('projects.deployments.healthDegraded');
    case 'notChecked':
      return t('projects.deployments.healthNotChecked');
    case 'loading':
      return t('common.loading');
    default:
      return t('projects.deployments.healthUnknown');
  }
}

function uptimeText(percent: number | null): string | null {
  return percent === null
    ? null
    : t('projects.deployments.services.uptime', {
        percent: `${Math.round(percent * 10) / 10}%`,
      });
}

/** The inventory's own coverage words: reading, or why a family could not be read. Never "none" for an unread list. */
function familyState(state: ManagedInventorySectionsState, kind: 'configuredCheck' | 'watchedService', testID: string): React.ReactNode | null {
  const family = state.families.find((candidate) => candidate.kind === kind);
  if (!family || family.result.coverage === 'available') return null;
  if (family.result.coverage === 'loading')
    return (
      <ItemGroup surface="none" testID={`${testID}.loading`}>
        <SkeletonRows rows={3} />
      </ItemGroup>
    );
  if ('unavailable' in family.result.coverage) {
    return (
      <ItemGroup surface="none">
        <SurfaceStateCard
          testID={`${testID}.unavailable`}
          kind="unavailable"
          size="line"
          title={t('projects.deployments.unavailableTitle')}
        />
      </ItemGroup>
    );
  }
  return null;
}

/**
 * Services → Checks (pfc-redesign svcChk): the Account's saved Checks from the managed inventory owner, each with the
 * state and 30-day uptime its health results report. A Check opens beside the page (DetailsPane) or as its page.
 */
export function ServicesChecksView(
  props: Readonly<{
    scope: ServerAccountScope | null;
    presented: boolean;
    selectedKey: string | null;
    onSelect: (row: ManagedConfiguredCheckRow) => void;
    /** The selected Check's current row (its results move on), for the details pane the page hosts. */
    onSelectedRow: (row: ManagedConfiguredCheckRow | null) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const query = React.useMemo(
    () => ({
      scope: props.scope,
      machine: null,
      projectKey: null,
      presented: props.presented,
      kinds: CHECK_KINDS,
    }),
    [props.presented, props.scope],
  );
  const input = React.useMemo(
    () => ({ scope: props.scope, machine: null, projectKey: null }),
    [props.scope],
  );
  return (
    <MachineManagedInventorySection
      query={query}
      groupBy="kind"
      openKey={null}
      onOpenChange={NO_OPEN}
    >
      {(state) => {
        const rows = state.rows.filter(
          (row): row is ManagedConfiguredCheckRow =>
            row.kind === 'configuredCheck',
        );
        const pending = familyState(state, 'configuredCheck', 'services.checks');
        if (rows.length === 0) {
          return (
            pending ?? (
              <EmptyState
                testID="services.checks.empty"
                layout="page"
                scene="noAutomations"
                title={t('projects.deployments.services.noChecks')}
                subtitle={t('projects.deployments.services.noChecksBody')}
              />
            )
          );
        }
        return (
          <>
            {pending}
            <ItemGroup testID="services.checks">
              <SelectedRowReport rows={rows} selectedKey={props.selectedKey} onSelectedRow={props.onSelectedRow} />
              {rows.map((row) => {
                const facts = readServiceCheckFacts(row.lastResults);
                return (
                  <Item
                    key={row.key}
                    testID={`services.checks.row.${row.automationId}.${row.triggerId}`}
                    title={row.native.name}
                    subtitle={[
                      row.native.enabled
                        ? statusWord(facts.status)
                        : t('projects.deployments.healthNotChecked'),
                      uptimeText(facts.uptimePercent),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    icon={
                      <RowMark
                        row={row}
                        title={row.native.name}
                        input={input}
                      />
                    }
                    selected={props.selectedKey === row.key}
                    onPress={() => props.onSelect(row)}
                    subtitleStyle={!row.native.enabled ? undefined : facts.status === 'down'
                        ? { color: theme.colors.state.danger.textForeground }
                        : facts.status === 'degraded'
                          ? { color: theme.colors.state.warning.textForeground }
                          : undefined
                    }
                  />
                );
              })}
            </ItemGroup>
          </>
        );
      }}
    </MachineManagedInventorySection>
  );
}

function dayColor(
  day: ServiceCheckDay,
  colors: Readonly<{
    up: string;
    down: string;
    degraded: string;
    empty: string;
  }>,
): string {
  return day.tone === 'down'
    ? colors.down
    : day.tone === 'degraded'
      ? colors.degraded
      : day.tone === 'up'
        ? colors.up
        : colors.empty;
}

/** One Check's detail, the same body in the details pane and as its page: each target's state and its 30 days. */
export function ServiceCheckDetail(
  props: Readonly<{ row: ManagedConfiguredCheckRow; nowMs?: number }>,
) {
  const { theme } = useUnistyles();
  const facts = readServiceCheckFacts(props.row.lastResults);
  const nowMs = props.nowMs ?? Date.now();
  const pluginTheme = React.useMemo(() => projectPluginUiTheme(theme), [theme]);
  const colors = {
    up: theme.colors.state.success.foreground,
    down: theme.colors.state.danger.foreground,
    degraded: theme.colors.state.warning.foreground,
    empty: theme.colors.surface.inset,
  };
  return (
    <View
      testID={`services.check.${props.row.automationId}.${props.row.triggerId}`}
    >
      <ItemGroup
        title={props.row.native.name}
        description={props.row.native.description ?? undefined}
      >
        <Item
          title={statusWord(facts.status)}
          subtitle={uptimeText(facts.uptimePercent) ?? undefined}
          mode="info"
        />
      </ItemGroup>
      {facts.checks.map((check) => {
        const strip = check.history
          ? serviceCheckHistoryStrip(check.history, nowMs)
          : null;
        return (
          <ItemGroup
            key={check.checkId}
            testID={`services.check.history.${check.checkId}`}
            title={t('projects.deployments.services.lastDays')}
            description={
              uptimeText(check.history?.uptimePercent ?? null) ??
              t('projects.deployments.healthNotChecked')
            }
            surface="none"
          >
            {strip ? (
              <View style={styles.strip}>
                <Heatmap
                  theme={pluginTheme}
                  label={t('projects.deployments.services.lastDays')}
                  layout="strip"
                  size="full"
                  rows={STRIP_ROWS}
                  columns={strip.map((day) => ({
                    id: String(day.dayStartAt),
                    label: '',
                  }))}
                  cells={strip.map((day) => ({
                    id: String(day.dayStartAt),
                    row: 'days',
                    column: String(day.dayStartAt),
                    label: new Date(day.dayStartAt).toLocaleDateString(
                      undefined,
                      { month: 'short', day: 'numeric', timeZone: 'UTC' },
                    ),
                    value: day.uptimePercent,
                    valueLabel:
                      day.uptimePercent === null
                        ? t('projects.deployments.healthNotChecked')
                        : `${day.uptimePercent}%`,
                    color: dayColor(day, colors),
                  }))}
                />
              </View>
            ) : null}
          </ItemGroup>
        );
      })}
    </View>
  );
}
const STRIP_ROWS = [{ id: 'days', label: '' }] as const;

/** Publishes the selected row whenever its identity changes (a new result), so the pane shows current facts. */
function SelectedRowReport(props: Readonly<{ rows: readonly ManagedConfiguredCheckRow[]; selectedKey: string | null;
  onSelectedRow: (row: ManagedConfiguredCheckRow | null) => void }>) {
  const row = props.selectedKey ? props.rows.find((candidate) => candidate.key === props.selectedKey) ?? null : null;
  const { onSelectedRow } = props;
  React.useEffect(() => { onSelectedRow(row); }, [onSelectedRow, row]);
  return null;
}

/** Services → Watched (svcWatch): services already running on a Machine that someone watches, the inventory's rows. */
export function ServicesWatchedView(
  props: Readonly<{ scope: ServerAccountScope | null; presented: boolean }>,
) {
  const query = React.useMemo(
    () => ({
      scope: props.scope,
      machine: null,
      projectKey: null,
      presented: props.presented,
      kinds: WATCHED_KINDS,
    }),
    [props.presented, props.scope],
  );
  return (
    <MachineManagedInventorySection
      query={query}
      groupBy="machine"
      openKey={null}
      onOpenChange={NO_OPEN}
    >
      {(state) =>
        state.rows.length === 0 ? (
          (familyState(state, 'watchedService', 'services.watched') ?? (
            <EmptyState
              testID="services.watched.empty"
              layout="page"
              scene="nothingListening"
              title={t('projects.deployments.services.noWatched')}
              subtitle={t('projects.deployments.services.noWatchedBody')}
            />
          ))
        ) : (
          <ManagedInventoryDirectory
            state={state}
            input={query}
            groupBy="machine"
            columns={1}
            preview={null}
            testIDPrefix="services.watched"
          />
        )
      }
    </MachineManagedInventorySection>
  );
}

const styles = StyleSheet.create((theme) => ({
  strip: { paddingHorizontal: theme.space.s16, paddingTop: theme.space.s4 },
}));
