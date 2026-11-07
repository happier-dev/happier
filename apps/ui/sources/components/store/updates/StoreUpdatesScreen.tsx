import { ManagedInventoryCoverage } from '@/components/store/inventory/ManagedInventoryCoverage';
import * as React from 'react';
import { StoreProjectScopeChip } from '../StoreProjectScopeChip';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { CapabilityRow } from '@/components/capabilities/row/CapabilityRow';
import { SKILLS_UPDATES_ROUTE } from '@/components/settings/skills/updates/skillsUpdatesModel';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import { resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { describeRegistrySourceStatus } from '@/registries/describeRegistrySourceStatus';
import { useRegistryUpdateCheck } from '@/registries/useRegistryUpdateCheck';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { t } from '@/text';
import { Modal } from '@/modal';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { useOptionalScreenIsFocused } from '@/utils/navigation/useOptionalScreenIsFocused';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { RowMark } from '../inventory/ManagedInventoryDirectory';
import { presentInventoryRow } from '../inventory/inventoryRows';
import { storeKinds } from '../catalog/storeKinds';
import { useInstalledScope } from '../catalog/storeAccountAdmission';
import {
  type StoreUpdateEntry,
  type StoreUpdateKind,
  STORE_UPDATE_KINDS,
  captureStoreUpdateBasis,
  describeUncheckedSources,
} from './storeUpdatesModel';
import { useStoreUpdates } from './useStoreUpdates';
import { submitBrowserExtensionMutation } from '../submitBrowserExtensionMutation';

const KIND_TITLE: Readonly<Record<StoreUpdateKind, () => string>> = {
  mcpServer: () => t('capabilities.store.kinds.mcpServer.title'),
  skill: () => t('capabilities.store.kinds.skill.title'),
  agent: () => t('capabilities.store.kinds.agent.title'),
  browserExtension: () => t('capabilities.store.kinds.browserExtension.title'),
};

function formatTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(ms);
}

/**
 * Store → Updates (`/plugins?view=updates`, S40-U6a): every newer version the owners recorded for what this
 * Account manages, grouped by kind, each leading to its owner's own review (Skills' per-file Updates, an MCP
 * server's or agent's page, or the browser's native permission review). Check now runs the one finite registry check.
 */
export function StoreUpdatesScreen(): React.ReactNode {
  const scope = useAccountSettingsScope();
  const focused = useOptionalScreenIsFocused() !== false;
  const layoutPresented = useLayoutPresentationActive();
  const presented = focused && layoutPresented;
  const query = React.useMemo(
    () => ({ scope, machine: null, projectKey: null }),
    [scope],
  );
  const demand = React.useMemo(() => ({ presented }), [presented]);
  const admitted = useInstalledScope(query);
  const mcpServer = storeKinds.mcpServer.useInstalled(query, demand, admitted);
  const skill = storeKinds.skill.useInstalled(query, demand, admitted);
  const agent = storeKinds.agent.useInstalled(query, demand, admitted);
  const browserExtension = storeKinds.browserExtension.useInstalled(query, demand, admitted);
  const families = { mcpServer, skill, agent, browserExtension };
  const rows = React.useMemo(() => [...mcpServer.rows, ...agent.rows, ...skill.rows, ...browserExtension.rows],
    [mcpServer.rows, agent.rows, skill.rows, browserExtension.rows]);
  const execution = useMountedActionExecution(scope);
  const refreshSkills = skill.continuation;
  const refreshBrowserExtensions = browserExtension.continuation;
  const retry = React.useCallback(() => {
    refreshSkills?.();
    refreshBrowserExtensions?.();
  }, [refreshSkills, refreshBrowserExtensions]);
  const captureBasis = React.useCallback(() => captureStoreUpdateBasis(rows), [rows]);
  const { check, checkNow } = useRegistryUpdateCheck({
    scopeKey: JSON.stringify(scope),
    execute: execution.execute,
    isCurrent: execution.isCurrent,
    retry,
    enabled: presented,
    captureBasis,
  });
  const view = useStoreUpdates(rows, check, scope, presented,
    [mcpServer, skill, agent, browserExtension]
      .every(family => family.coverage === 'available'));
  const router = useRouter();
  const go = React.useCallback(
    (href: string) => {
      const result = runGuardedNavigation(() => router.push(href as never));
      if (result !== true)
        fireAndForget(result, { tag: 'StoreUpdatesScreen.go' });
    },
    [router],
  );

  const loading =
    view.sections.length === 0 &&
    [mcpServer, skill, agent, browserExtension].some((family) => family.coverage === 'loading');
  const coverageFamilies = STORE_UPDATE_KINDS.map(kind => ({ kind, result: families[kind] }));
  const unresolved = STORE_UPDATE_KINDS.flatMap(kind => {
    const family = families[kind];
    return typeof family.coverage === 'object' ? [{ kind, family, coverage: family.coverage }] : [];
  });
  const reasons = describeUncheckedSources(check.results);
  const purpose =
    view.freshness.checkedAt !== null
      ? `${t('capabilities.store.updates.purpose')} ${t('capabilities.store.updates.coverage', { count: view.freshness.checked })} ${t('capabilities.store.updates.checkedAt', { time: formatTime(view.freshness.checkedAt) })}`
      : t('capabilities.store.updates.purpose');

  return (
    <ItemList
      pageColumn="wide"
      keyboardShouldPersistTaps="handled"
      testID="store.updates"
    >
      <PageContentColumn>
        <PageHeader
          testID="store.updates.header"
          title={t('capabilities.store.updates.title')}
          alwaysShowTitle
          description={purpose}
          actions={
            <><StoreProjectScopeChip />{scope ? (
              <SectionActionButton
                testID="store.updates.checkNow"
                title={
                  check.checking
                    ? t('capabilities.store.updates.checking')
                    : t('capabilities.store.updates.checkNow')
                }
                icon="arrow-clockwise"
                loading={check.checking}
                disabled={
                  check.checking ||
                  !execution.ready ||
                  (!loading && view.tracked === 0)
                }
                onPress={() => void checkNow()}
              />
            ) : null}</>
          }
          actionsPlacement="page"
        />
        {!scope ? (
          <View style={styles.inset}>
            <SurfaceStateCard
              testID="store.updates.unavailable"
              size="page"
              kind="unavailable"
              title={t('storeInstalled.unavailable')}
            />
          </View>
        ) : (
          <>
            {check.failed ? (
              <View style={styles.inset}>
                <SurfaceStateCard
                  testID="store.updates.checkFailed"
                  size="line"
                  kind="warning"
                  title={
                    view.unchecked > 0
                      ? `${t('capabilities.store.updates.someUnchecked', { count: view.unchecked })} ${reasons.join(' ')}`
                      : t('capabilities.store.updates.checkFailed')
                  }
                  // Each failing source reads on its own line under the count, never run into one paragraph.
                  titleContent={
                    view.unchecked > 0 && reasons.length > 0 ? (
                      <>
                        {t('capabilities.store.updates.someUnchecked', { count: view.unchecked })}
                        {reasons.map((reason, index) => (
                          <React.Fragment key={index}>{'\n'}{reason}</React.Fragment>
                        ))}
                      </>
                    ) : undefined
                  }
                  diagnosticCode={
                    view.unchecked > 0 ? undefined : (check.code ?? undefined)
                  }
                  action={{
                    label: t('capabilities.store.retry'),
                    onPress: () => void checkNow(),
                    testID: 'store.updates.checkFailed.retry',
                  }}
                />
              </View>
            ) : null}
            <ManagedInventoryCoverage testIDPrefix="store.updates" families={coverageFamilies} />
            {loading ? (
              <ItemGroup surface="none" testID="store.updates.loading">
                <SkeletonRows rows={3} testID="store.updates.loading.rows" />
              </ItemGroup>
            ) : view.sections.length === 0 ? (
              <View style={styles.inset}>
                <UpdatesEmpty
                  tracked={view.tracked}
                  current={view.count === 0}
                  partial={unresolved.length > 0}
                />
              </View>
            ) : (
              view.sections.map((section) => (
                <ItemGroup
                  key={section.kind}
                  testID={`store.updates.section.${section.kind}`}
                  title={KIND_TITLE[section.kind]()}
                  surface="none"
                >
                  {section.entries.map((entry) => (
                    <UpdateRow
                      key={entry.key}
                      entry={entry}
                      input={query}
                      go={go}
                      execute={execution.execute}
                      getSignal={execution.getSignal}
                      ready={execution.ready}
                      onApplied={refreshBrowserExtensions}
                      testID={`store.updates.row.${entry.key}`}
                    />
                  ))}
                </ItemGroup>
              ))
            )}
          </>
        )}
      </PageContentColumn>
    </ItemList>
  );
}

/** Nothing to review: claims "up to date" only after this page's check completed without a failed source. */
function UpdatesEmpty(
  props: Readonly<{ tracked: number; current: boolean; partial: boolean }>,
) {
  if (!props.partial && props.tracked === 0) {
    return (
      <SurfaceStateCard
        testID="store.updates.noSources"
        size="page"
        kind="empty"
        title={t('capabilities.store.updates.noSources')}
        reason={t('capabilities.store.updates.noSourcesBody')}
      />
    );
  }
  if (!props.partial && props.current) {
    return (
      <SurfaceStateCard
        testID="store.updates.upToDate"
        size="page"
        kind="empty"
        scene="checksPassed"
        title={t('capabilities.store.updates.upToDate')}
        reason={t('capabilities.store.updates.upToDateBody')}
      />
    );
  }
  return (
    <SurfaceStateCard
      testID="store.updates.notChecked"
      size="page"
      kind="empty"
      title={t('capabilities.store.updates.notChecked')}
      // A partial read is already said once by the coverage line above; the card doesn't repeat it.
      reason={props.partial ? undefined : t('capabilities.store.updates.notCheckedBody')}
    />
  );
}

/** One waiting change, reviewed through its native Action or its owner's detail page. */
function UpdateRow(
  props: Readonly<{
    entry: StoreUpdateEntry;
    input: Parameters<typeof presentInventoryRow>[1];
    go: (href: string) => void;
    execute: ReturnType<typeof useMountedActionExecution>['execute'];
    getSignal: () => AbortSignal;
    ready: boolean;
    onApplied?: () => void;
    testID: string;
  }>,
) {
  const { entry } = props;
  const presentation = presentInventoryRow(entry.row, props.input);
  const title = presentation.facts.title;
  const href =
    entry.row.kind === 'skill' &&
    (entry.state === 'available' || entry.state === 'needsChoice')
      ? SKILLS_UPDATES_ROUTE
      : typeof presentation.home.href === 'string'
        ? presentation.home.href
        : null;
  const version = entry.from && entry.to ? `${entry.from} → ${entry.to}` : null;
  const state =
    entry.state === 'available'
      ? t('capabilities.store.updates.ready')
      : entry.state === 'needsChoice'
        ? t('capabilities.store.updates.needsChoice')
        : entry.state === 'removed'
          ? t('capabilities.skills.home.removedFromSource')
          : [
              t('capabilities.store.updates.unchecked'),
              entry.reason ? describeRegistrySourceStatus(entry.reason) : null,
            ]
              .filter(Boolean)
              .join(' · ');
  const [applying, apply] = useHappyAction(async () => {
    if (!entry.apply) return;
    const result = await submitBrowserExtensionMutation({ ...entry.apply,
      machineId: entry.apply.input.machineId, execute: props.execute, signal: props.getSignal(),
      confirmText: t('capabilities.store.updates.review') });
    if (result.ok) props.onApplied?.();
    else if (result.code) Modal.alert(t('common.error'), result.code);
  });
  const open = () => {
    if (entry.apply) apply();
    else if (href) props.go(href);
  };
  const actionable = Boolean(entry.apply || href);
  const disabled = Boolean(entry.apply && (applying || !props.ready));
  const fix =
    entry.state === 'removed' || entry.state === 'needsChoice'
      ? t('capabilities.store.updates.choose')
      : entry.state === 'available'
        ? t('capabilities.store.updates.review')
        : null;
  return (
    <CapabilityRow
      testID={props.testID}
      title={title}
      description={[version, state].filter(Boolean).join(' · ')}
      status={entry.status}
      mark={<RowMark row={entry.row} title={title} input={props.input} />}
      divider={false}
      stackActionWhenNarrow
      action={
        fix && actionable ? (
          <RoundButton
            testID={`${props.testID}.review`}
            size="small"
            display="secondary"
            title={fix}
            loading={applying}
            disabled={disabled}
            onPress={open}
          />
        ) : undefined
      }
      onPress={actionable && !disabled ? open : undefined}
    />
  );
}

const styles = StyleSheet.create(() => ({
  inset: { paddingHorizontal: resolveItemGroupContentHorizontalInsetPx() },
}));
