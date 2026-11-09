import * as React from 'react';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useDeploymentPlatformTargetTitles } from './DeploymentPlatformTargetSheet';
import { keepNamesWhole } from '@/utils/text/keepNamesWhole';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierCollectionListMark } from '@happier-dev/plugin-ui/presentation';
import type { DeploymentEnvironmentCollectionV1 } from '@happier-dev/deployment-protocol/v1';

import { Icon } from '@/components/ui/icons/Icon';
import { IconButton } from '@/components/ui/buttons/IconButton';
import {
  CollectionDraftRow,
  CollectionList,
  CollectionNavigationRow,
} from '@/components/ui/lists/collection/CollectionList';
import { useCollectionDraftTitle } from '@/components/ui/lists/collection/CollectionDraftTitle';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { useMachineDisplayNamesById } from '@/sync/store/hooks';
import { retainKeyedRows, retainShallow } from '@/sync/domains/state/structuralSharing';
import { t } from '@/text';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';
import { WorkStatusGlyph } from '@/components/work/status/WorkStatusGlyph';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { DeploymentReadControllerV1 } from '@happier-dev/deployments';

import { deploymentActionRefusalRemedy, deploymentRailState, deploymentStepWorkStatus } from './deploymentPresentation';
import { useDeploymentCollection } from './useDeploymentReads';
import { currentStep, deploymentStepCaption } from './DeploymentStepStrip';

type EnvironmentItem = DeploymentEnvironmentCollectionV1['items'][number];

/** Selection belongs to the keyed row producer: unchanged rows keep their handler, changed rows select current data. */
export function useDeploymentEnvironmentRowSelection<T extends object>(items: readonly T[],
  keyOf: (item: T) => string, onSelect: (item: T) => void): Array<T & { onPress: () => void }> {
  type Entry = { source: T; value: T & { onPress: () => void } };
  const previous = React.useRef<{ entries: Map<string, Entry>; onSelect: typeof onSelect; rows: Entry['value'][] } | null>(null);
  const entries = new Map<string, Entry>();
  const rows = items.map(item => {
    const key = keyOf(item);
    const old = previous.current?.entries.get(key);
    const entry = old?.source === item && previous.current?.onSelect === onSelect
      ? old : { source: item, value: { ...item, onPress: () => onSelect(item) } };
    entries.set(key, entry);
    return entry.value;
  });
  const retained = retainShallow(previous.current?.rows, rows);
  previous.current = { entries, onSelect, rows: retained };
  return retained;
}

/**
 * The Environments rail (lab d1 `rail`): one row per Environment with its name, where it runs and how long ago
 * it last changed. The latest attempt's trouble (or the work in progress) leads the second line; a settled
 * success says nothing more.
 */
export const DeploymentEnvironmentCollection = React.memo(
  function DeploymentEnvironmentCollection(
    props: Readonly<{
      items: readonly EnvironmentItem[];
      selectedId: string | null;
      /** Retained rows while the Home is not answering: the reason and Retry. */
      stale: Readonly<{ reason: string; onRetry: () => void }> | null;
      onSelect: (environmentId: string) => void;
      /** A new Environment's editor is open: its draft row leads the rail, selected. */
      drafting: boolean;
      /** Opens that editor; absent while the Action owner is not reachable. */
      onAdd: (() => void) | null;
      onSettings?: () => void;
      /** The read's finite pages: one page at a time, moved only by the person. */
      paging?: Readonly<{ hasPrevious: boolean; hasNext: boolean; previous: () => void; next: () => void }> | null;
      /** The Home/Account whose plugins name a platform Environment's target. */
      lifetime?: ServerAccountScopeLifetime | null;
    }>,
  ) {
    const { theme } = useUnistyles();
    const draftTitle = useCollectionDraftTitle();
    const mark = React.useMemo(() => (
      <HappierCollectionListMark>
        <Icon name="hard-drives" size={18} color={theme.colors.text.secondary} />
      </HappierCollectionListMark>
    ), [theme.colors.text.secondary]);
    const parts = useDeploymentEnvironmentRowParts(props.items, 'project-deployments.rail.row', props.lifetime ?? null, 'rail');
    const onSelect = props.onSelect;
    const selectRow = React.useCallback((row: typeof parts[number]) => onSelect(row.environmentId), [onSelect]);
    const rows = useDeploymentEnvironmentRowSelection(parts, row => row.environmentId, selectRow);
    return (
      <CollectionList
        testID="project-deployments.rail"
        title={t('projects.deployments.environments')}
        count={props.items.length}
        headerAction={props.onAdd || props.onSettings ? <View style={{ flexDirection: 'row' }}>
          {props.onSettings ? <IconButton testID="project-deployments.rail.settings" iconName="sliders-horizontal" variant="plain"
            accessibilityLabel={t('projects.deployments.defaultsEditor.projectTitle')}
            tooltip={t('projects.deployments.defaultsEditor.projectTitle')} onPress={props.onSettings} /> : null}
          {props.onAdd ? (
          <IconButton
            testID="project-deployments.rail.add"
            iconName="plus"
            variant="plain"
            accessibilityLabel={t('projects.deployments.add')}
            tooltip={t('projects.deployments.add')}
            disabled={props.drafting}
            onPress={props.onAdd}
          />
        ) : null}</View> : undefined}
      >
        {props.stale ? (
          <SurfaceFreshnessLine
            testID="project-deployments.rail.stale"
            reason={props.stale.reason}
            action={{ label: t('common.retry'), onPress: props.stale.onRetry }}
          />
        ) : null}
        {props.drafting ? (
          <CollectionDraftRow
            testID="project-deployments.rail.draft"
            titles={draftTitle}
            placeholder={t('projects.deployments.newEnvironment')}
            mark={
              <HappierCollectionListMark>
                <Icon name="plus" size={18} color={theme.colors.text.secondary} />
              </HappierCollectionListMark>
            }
          />
        ) : null}
        {rows.map((row) => (
          <CollectionNavigationRow
            surface="page"
            key={row.environmentId}
            testID={`project-deployments.rail.row.${row.environmentId}`}
            title={row.title}
            titleQualifier={row.titleQualifier}
            subtitle={row.subtitle}
            subtitleLeading={row.subtitleLeading}
            detail={row.detail}
            icon={mark}
            selected={!props.drafting && props.selectedId === row.environmentId}
            onPress={row.onPress}
          />
        ))}
        {props.paging && (props.paging.hasPrevious || props.paging.hasNext) ? (
          <View style={styles.paging}>
            {props.paging.hasPrevious ? (
              <SectionActionButton testID="project-deployments.rail.newer" title={t('projects.deployments.pageNewer')}
                icon="caret-left" onPress={props.paging.previous} />
            ) : null}
            {props.paging.hasNext ? (
              <SectionActionButton testID="project-deployments.rail.older" title={t('projects.deployments.pageOlder')} icon="caret-right"
                onPress={props.paging.next} />
            ) : null}
          </View>
        ) : null}
      </CollectionList>
    );
  },
);

/**
 * Which Environment the page opens once one is deleted: the nearest sibling of the same Project in the rail's
 * order (the next one, else the previous one), or none for the empty state. Never another Project's Environment.
 */
export function environmentAfterDelete(items: readonly Pick<EnvironmentItem, 'environment'>[], deletedId: string,
  projectSourceId: string): string | null {
  const siblings = items.filter((item) => item.environment.projectSourceId === projectSourceId || item.environment.id === deletedId);
  const index = siblings.findIndex((item) => item.environment.id === deletedId);
  if (index === -1) return null;
  return siblings[index + 1]?.environment.id ?? siblings[index - 1]?.environment.id ?? null;
}

/** Production is said once: a name that already says it ("Production API") needs no qualifier repeating it. */
function productionQualifier(protection: EnvironmentItem['environment']['protection'], title: string): string | null {
  if (protection !== 'production') return null;
  const word = t('projects.deployments.production');
  return title.toLocaleLowerCase().includes(word.toLocaleLowerCase()) ? null : word;
}

/**
 * What one Environment row says (lab d1 `rail`), for the Project's rail and Projects → All deployments alike:
 * its name and Production, then the latest attempt's trouble or its running steps, else where it runs; and
 * how long ago it last changed.
 */
export function useDeploymentEnvironmentRowParts(items: readonly EnvironmentItem[], testIDPrefix: string,
  lifetime: ServerAccountScopeLifetime | null = null,
  /** `rail` stands beside the selected Environment, which names its Machine and live version: two short lines. */
  presentation: 'row' | 'rail' = 'row') {
  const { theme } = useUnistyles();
  const machineIds = React.useMemo(() => items.map((item) => item.environment.controllerMachineId), [items]);
  const machineNames = useMachineDisplayNamesById(machineIds);
  // A platform Environment says which platform it runs on (lab d4), read once for every row.
  const anyPlatform = items.some((item) => item.runtimeTargetLink?.source.kind === 'plugin');
  const platformTitle = useDeploymentPlatformTargetTitles(lifetime, anyPlatform);
  const nowMs = Date.now();
  const incoming = items.map(({ environment, title, currentDeployment, projectSourceName, liveVersionTitle, runtimeTargetLink }) => {
    // An unknown Machine drops out of the line rather than reading "a machine".
    const name = machineNames[environment.controllerMachineId] ?? null;
    // Machine names wrap between words, never at their own hyphens (lab K12-5).
    const machine = name ? keepNamesWhole(name) : null;
    const latest = currentDeployment ? deploymentRailState(currentDeployment.state) : null;
    // Compose is a fact of a Machine target; an unlinked or platform Environment names only its Machine.
    const compose = runtimeTargetLink?.targetKind === 'ownServer' ? t('projects.deployments.compose') : null;
    const platform = runtimeTargetLink?.source.kind === 'plugin' ? platformTitle(runtimeTargetLink.source) : null;
    const where = (platform ?? [machine, compose].filter(Boolean).join(' · ')) || undefined;
    // While a deploy works, the step it waits on speaks: that step's own glyph, then "Deploying · Build · 48s".
    // A glyph for every step is too fine to read at row size (lab d1 keeps the full strip for wider boxes).
    const working = currentDeployment && (currentDeployment.state === 'queued' || currentDeployment.state === 'running')
      && currentDeployment.steps && currentDeployment.steps.length > 0 ? currentDeployment.steps : null;
    const caption = working ? deploymentStepCaption(working) : null;
    const step = working ? currentStep(working) : null;
    return {
      environmentId: environment.id,
      projectSourceId: environment.projectSourceId,
      /** The admitted Source name the read carries; null when unavailable or withdrawn. */
      projectName: projectSourceName ?? null,
      title,
      titleQualifier: productionQualifier(environment.protection, title),
      // A running deploy's line names the step it waits on; the Machine returns when it settles.
      subtitle: working
        ? [latest?.text, caption].filter(Boolean).join(' · ')
        : latest ? (machine && presentation === 'row' ? `${latest.text} · ${machine}` : latest.text)
        // Healthy says where it runs and, with room, what is live there (lab d1 `d1r`: the rail leaves that to the detail).
        : liveVersionTitle && presentation === 'row' ? [machine, liveVersionTitle].filter(Boolean).join(' · ') : where,
      leading: step ? { kind: 'step' as const, status: deploymentStepWorkStatus(step), testID: `${testIDPrefix}.${environment.id}.step` }
        : latest?.tone ? { kind: 'dot' as const, color: latest.tone === 'danger'
            ? theme.colors.state.danger.foreground
            : theme.colors.state.warning.foreground } : null,
      detail: formatRelativeTimeShort(environment.updatedAtMs, nowMs),
    };
  });
  type Fact = typeof incoming[number];
  type Row = Omit<Fact, 'leading'> & { subtitleLeading: React.ReactNode };
  const previous = React.useRef<{ facts: readonly Fact[]; rows: Row[] } | null>(null);
  // Reconcile display facts before creating React elements, whose renderer-owned fields are not JSON data.
  const facts = retainKeyedRows(previous.current?.facts, incoming, row => row.environmentId);
  if (facts === previous.current?.facts) return previous.current.rows;
  const byId = new Map(previous.current?.facts.map((fact, index) => [fact.environmentId, { fact, row: previous.current!.rows[index] }]));
  const rows = facts.map(fact => {
    const old = byId.get(fact.environmentId);
    if (old?.fact === fact) return old.row;
    const { leading, ...parts } = fact;
    const subtitleLeading = old?.fact.leading === leading ? old.row.subtitleLeading
      : leading?.kind === 'step' ? <WorkStatusGlyph status={leading.status} testIDSuffix={leading.testID} />
      : leading?.kind === 'dot' ? <StatusDot size={6} color={leading.color} /> : undefined;
    return { ...parts, subtitleLeading };
  });
  previous.current = { facts, rows };
  return rows;
}

/**
 * Choose one destination Environment (Promote to, Connect to an app): the Account's collection read, demanded only
 * while this chooser is open, one radio row per eligible Environment, its finite pages and its load states.
 */
export function DeploymentEnvironmentChooser(props: Readonly<{
  controller: DeploymentReadControllerV1;
  testID: string;
  title: string;
  /** Which Environments can be the destination: the caller's capability rule (and never the source itself). */
  eligible: (item: EnvironmentItem) => boolean;
  selectedId: string | null;
  onSelect: (item: EnvironmentItem) => void;
  disabled: boolean;
  loadFailedTitle: string;
  emptyTitle: string;
  emptyBody: string;
}>) {
  const collection = useDeploymentCollection(props.controller, { mounted: true, visible: true, focused: true });
  const items = (collection.snapshot.value?.items ?? []).filter(props.eligible);
  const rows = useDeploymentEnvironmentRowSelection(items, row => row.environment.id, props.onSelect);
  const failure = collection.snapshot.failure;
  return (
    <ItemGroup title={props.title}>
      {rows.map(row => <Item key={row.environment.id} testID={`${props.testID}:${row.environment.id}`}
        title={row.title} accessibilityRole="radio" selected={props.selectedId === row.environment.id} disabled={props.disabled}
        showChevron={false} onPress={row.onPress} />)}
      {collection.hasPreviousPage ? <SectionActionButton testID={`${props.testID}.previous`}
        icon="caret-left" title={t('common.previous')} disabled={props.disabled} onPress={collection.previousPage} /> : null}
      {collection.hasNextPage ? <SectionActionButton testID={`${props.testID}.next`}
        icon="caret-right" title={t('common.next')} disabled={props.disabled} onPress={collection.nextPage} /> : null}
      {collection.snapshot.status === 'unavailable' ? <SurfaceStateCard testID={`${props.testID}.loadFailed`}
        size="line" kind="error" title={props.loadFailedTitle}
        reason={deploymentActionRefusalRemedy(failure?.code ?? 'deployment_unavailable')}
        diagnosticCode={failure?.code ?? null}
        {...(failure?.retryable ? { action: { label: t('common.retry'), onPress: () => { void collection.refresh(); } } } : {})} />
        : collection.snapshot.status !== 'ready' && rows.length === 0 ? <SurfaceStateCard size="line" kind="loading"
            testID={`${props.testID}.loading`} title={t('projects.deployments.loading')} />
        : rows.length === 0 ? <SurfaceStateCard size="line" kind="empty" testID={`${props.testID}.empty`}
            title={props.emptyTitle} reason={props.emptyBody} /> : null}
    </ItemGroup>
  );
}

const styles = StyleSheet.create((theme) => ({
  paging: { flexDirection: 'row', justifyContent: 'center', gap: theme.space.s8, paddingVertical: theme.space.s8 },
}));
