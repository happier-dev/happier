import { useInstalledUpdates } from '@/updates/useInstalledUpdates';
import { ManagedInventoryCoverage } from '@/components/store/inventory/ManagedInventoryCoverage';
import * as React from 'react';
import { StoreProjectScopeChip } from '../StoreProjectScopeChip';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { PageHeader } from '@/components/ui/layout/PageHeader';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import { resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { useStoreActionTarget, useStoreMachineScope } from '@/components/settings/plugins/model/useStoreMachineScope';
import { t } from '@/text';
import { useOptionalScreenIsFocused } from '@/utils/navigation/useOptionalScreenIsFocused';

import type { StoreInstalledInput } from '../catalog/storeKinds';
import {
  type StoreUpdateKind,
  STORE_UPDATE_KINDS,
  describeUncheckedSources,
} from './storeUpdatesModel';
import { StoreUpdateRow, useStoreUpdateRowHost } from './StoreUpdateRow';

const KIND_TITLE: Readonly<Record<StoreUpdateKind, () => string>> = {
  app: () => t('capabilities.store.kinds.app.title'),
  mcpServer: () => t('capabilities.store.kinds.mcpServer.title'),
  skill: () => t('capabilities.store.kinds.skill.title'),
  agent: () => t('capabilities.store.kinds.agent.title'),
  browserExtension: () => t('capabilities.store.kinds.browserExtension.title'),
  plugin: () => t('capabilities.store.kinds.plugin.title'),
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
 * server's, agent's or plugin's page, or the browser's native permission review). Check now runs the one finite registry check.
 */
export function StoreUpdatesScreen(): React.ReactNode {
  const scope = useAccountSettingsScope();
  const focused = useOptionalScreenIsFocused() !== false;
  const layoutPresented = useLayoutPresentationActive();
  const presented = focused && layoutPresented;
  const selectedMachine = useStoreMachineScope();
  const externalActionTarget = useStoreActionTarget(undefined, true, scope ?? undefined);
  const query = React.useMemo<StoreInstalledInput>(
    () => ({ scope, machine: selectedMachine ? { serverIdentityId: selectedMachine.serverId, machineId: selectedMachine.machineId } : null, projectKey: null }),
    [scope, selectedMachine],
  );
  const { view, check, checkNow, execution, app, mcpServer, skill, agent, browserExtension, plugin } =
    useInstalledUpdates(query, presented, externalActionTarget, true);
  const refreshBrowserExtensions = browserExtension.continuation;
  const families = { app, mcpServer, skill, agent, browserExtension, plugin };
  const rowHost = useStoreUpdateRowHost(React.useMemo(() => ({ input: query, execute: execution.execute,
    getSignal: execution.getSignal, ready: execution.ready, onApplied: refreshBrowserExtensions }),
    [execution.execute, execution.getSignal, execution.ready, query, refreshBrowserExtensions]));

  const loading =
    view.sections.length === 0 &&
    [app, mcpServer, skill, agent, browserExtension, plugin].some((family) => family.coverage === 'loading');
  const coverageKinds = STORE_UPDATE_KINDS.filter((kind): kind is keyof typeof families => kind in families);
  const coverageFamilies = coverageKinds.map(kind => ({ kind, result: families[kind] }));
  const unresolved = coverageKinds.flatMap(kind => {
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
              // While a kind is still loading or failed, its line above is the whole answer: no claim about what's waiting.
              unresolved.length > 0 || check.failed ? null : <View style={styles.inset}>
                <UpdatesEmpty
                  tracked={view.tracked}
                  awaiting={view.awaiting}
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
                    <StoreUpdateRow
                      key={entry.key}
                      entry={entry}
                      host={rowHost}
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

/** Nothing to review: shown only when every kind loaded and the check didn't fail; "up to date" only after a check. */
function UpdatesEmpty(
  props: Readonly<{ tracked: number; awaiting: number; current: boolean; partial: boolean }>,
) {
  // Apps still awaiting their first check are not "nothing to keep up to date": they read as not checked yet.
  if (!props.partial && props.tracked === 0 && props.awaiting === 0) {
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

const styles = StyleSheet.create(() => ({
  inset: { paddingHorizontal: resolveItemGroupContentHorizontalInsetPx() },
}));
