import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_COLLECTION_LIST_METRICS } from '@happier-dev/plugin-ui/presentation';

import { createAgentSettingsRoute } from '@/agents/catalog/agentSettingsRoutes';
import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import {
  RegistryShelf,
  RegistryShelfAddControl,
  type RegistryShelfProjection,
} from '@/components/capabilities/add/RegistryShelf';
import { CapabilityRow } from '@/components/capabilities/row/CapabilityRow';
import { presentCapabilityStatus } from '@/components/capabilities/status/capabilityStatusPresentation';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { Text } from '@/components/ui/text/Text';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { readAccountAgentProviderDeclarations, readAccountProviderDeclarations, providerDeclarationContext } from '@/providers/catalog/accountProviderDeclarations';
import { projectAgentProviderRows, type AgentProviderRow } from '@/providers/catalog/providerDeclarationDetail';
import { ProviderIcon } from '@/providers/connection/ProviderIcon';
import { newProviderRoute } from '@/components/settings/providers/collection/providerCollectionModel';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
  AddAgentMenu,
  openCustomAcpEditor,
  useAgentCollection,
  useOpenAgentBrowse,
} from './AgentCollectionList';
import type { AgentCollectionRow } from './agentCollectionModel';
import {
  resolveAgentsMachineCandidateAvailability,
  type AgentAdministrationCatalog,
} from './useAgentAdministrationCatalog';

const PROVIDERS_ROUTE = '/(app)/settings/providers';

const shelfProjection: RegistryShelfProjection<AgentCollectionRow> = {
  keyOf: (row) => row.key,
  title: (row) => row.entry.title,
  description: (row) => row.entry.subtitle,
  testID: (row) => row.key,
};

/** The card's quiet line: where the agent comes from, from facts the collection already holds. */
function shelfWhere(row: AgentCollectionRow): string | null {
  if (row.status === 'installsOnFirstUse')
    return t('capabilities.agentAdd.adding.firstUse');
  return row.entry.isBuiltIn ? t('capabilities.agentAdd.status.builtIn') : null;
}

/**
 * `/settings/agents` beside its column (lab t:agents, S30 §6.2): what agents are for with the Machine it reads and the
 * page's one Add; the agents that need the person, each with its fix; a few agents the selected Machine does not have
 * yet; and where models come from. Every agent stays listed in the column; a choice opens its own page, where install
 * and sign-in live. Nothing here probes a Machine beyond the collection's own detection.
 */
export const AgentSettingsHome = React.memo(function AgentSettingsHome(
  props: Readonly<{
    catalog: AgentAdministrationCatalog;
  }>,
) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const { catalog } = props;
  const { collection, detecting } = useAgentCollection(catalog, '');
  const providersEnabled = useFeatureEnabled('providers');
  const declarationMachineId = catalog.targetSelection.selectedTarget?.machineId ?? catalog.projectionScope?.machineId;
  const providerRows = React.useMemo(() => {
    if (!providersEnabled) return [];
    const context = providerDeclarationContext(declarationMachineId, catalog.declarationProjection);
    const targets = new Set(catalog.agentEntries.filter(entry => entry.enabled !== false).map(entry => entry.backendTargetKey));
    const agents = readAccountAgentProviderDeclarations(context).filter(agent => targets.has(agent.agentTargetKey));
    return projectAgentProviderRows(readAccountProviderDeclarations(context), agents);
  }, [providersEnabled, declarationMachineId, catalog.declarationProjection, catalog.agentEntries]);
  const openBrowse = useOpenAgentBrowse();
  const machine = catalog.executionTarget?.machine ?? null;
  const serverId = catalog.executionTarget?.serverId ?? null;

  const openRow = React.useCallback(
    (row: AgentCollectionRow) => {
      if (row.definition) {
        openCustomAcpEditor(router, row.definition.id, false);
        return;
      }
      const href = createAgentSettingsRoute(row.entry) as never;
      const result = runGuardedNavigation(() => router.push(href));
      if (result !== true)
        fireAndForget(result, { tag: 'AgentSettingsHome.open' });
    },
    [router],
  );
  const openProviders = React.useCallback(() => {
    const result = runGuardedNavigation(() =>
      router.push(PROVIDERS_ROUTE as never),
    );
    if (result !== true)
      fireAndForget(result, { tag: 'AgentSettingsHome.providers' });
  }, [router]);
  const openProvider = React.useCallback((row: AgentProviderRow) => {
    const result = runGuardedNavigation(() => router.push(newProviderRoute(row.declaration.contributionKey) as never));
    if (result !== true) fireAndForget(result, { tag: 'AgentSettingsHome.provider' });
  }, [router]);

  const needs = React.useMemo(
    () => collection.onMachine.filter((row) => row.trouble),
    [collection.onMachine],
  );
  // A sign-in the Machine last reported but has not re-verified yet is not asserted (the projection withholds it), yet its
  // place is known: Needs you holds it with its loading row so the rest of the page does not move when it is confirmed.
  const pendingNeeds = React.useMemo(() => {
    const unverified = collection.onMachine.filter((row) => row.status === 'needsSignIn' && !row.trouble).length;
    return unverified > 0 ? unverified : detecting && needs.length === 0 ? 1 : 0;
  }, [collection.onMachine, detecting, needs.length]);
  // Only agents this Machine reported it does not have: an unknown installation is never offered as new.
  const others = React.useMemo(
    () =>
      collection.available.filter(
        (row) =>
          row.status === 'notInstalled' || row.status === 'installsOnFirstUse',
      ),
    [collection.available],
  );

  const mark = React.useCallback(
    (row: AgentCollectionRow, size: number) => (
      <AgentCatalogIdentityIcon
        entry={row.entry}
        machineId={machine?.id ?? null}
        serverId={serverId}
        current={catalog.projectionCurrent}
        color={theme.colors.text.secondary}
        size={size}
      />
    ),
    [
      catalog.projectionCurrent,
      machine?.id,
      serverId,
      theme.colors.text.secondary,
    ],
  );
  const shelfGlyph = React.useCallback(
    (row: AgentCollectionRow) => mark(row, 26),
    [mark],
  );
  const shelfAction = React.useCallback(
    (row: AgentCollectionRow) => (
      <RegistryShelfAddControl
        testID={`settings-agents-home.try.${row.key}.open`}
        state="available"
        title={row.entry.title}
        addLabel={t('capabilities.agentAdd.openAgent', {
          name: row.entry.title,
        })}
        addedLabel={t('capabilities.agentAdd.openAgent', {
          name: row.entry.title,
        })}
        failedLabel={t('capabilities.agentAdd.openAgent', {
          name: row.entry.title,
        })}
        onAdd={() => openRow(row)}
      />
    ),
    [openRow],
  );

  return (
    <ItemList pageColumn="wide" testID="settings-agents-home">
      <PageContentColumn>
        <PageHeader
          testID="settings.agents.index.header"
          title={t('settingsAgents.title')}
          alwaysShowTitle
          description={t('capabilities.agentsHome.purpose')}
          actionsPlacement="page"
          actions={
            <View style={styles.actions}>
              <MachineAdministrationTargetSelector
                selection={catalog.targetSelection}
                presentation="chip"
                resolveCandidateAvailability={
                  resolveAgentsMachineCandidateAvailability
                }
                testIDPrefix="settings.agents.administration.target"
              />
              <AddAgentMenu catalog={catalog} trigger="primary" />
            </View>
          }
        />
        {needs.length > 0 || pendingNeeds > 0 ? (
          <ItemGroup
            testID="settings-agents-home.needs"
            title={t('capabilities.agentsHome.needsTitle')}
            titleAccessory={
              needs.length > 0 ? (
                <Text variant="meta" style={styles.count}>
                  {String(needs.length)}
                </Text>
              ) : undefined
            }
          >
            {needs.map((row) => (
              <NeedsYouRow
                key={row.key}
                row={row}
                machineLabel={catalog.machineLabel}
                mark={mark(row, 20)}
                onOpen={openRow}
              />
            ))}
            {pendingNeeds > 0 ? (
              // The Needs row is a catalog row, so its placeholder is that row's own height: the rows that land do not move the page.
              <SkeletonRows
                rows={pendingNeeds}
                rowHeight={HAPPIER_COLLECTION_LIST_METRICS.catalogRow.minHeight}
                testID="settings-agents-home.needs.loading"
              />
            ) : null}
          </ItemGroup>
        ) : null}
        <RegistryShelf
          testID="settings-agents-home.try"
          title={t('capabilities.agentsHome.tryTitle')}
          description={t('capabilities.agentsHome.tryBody')}
          items={others}
          projection={shelfProjection}
          loading={detecting}
          where={shelfWhere}
          glyph={shelfGlyph}
          action={shelfAction}
          onOpen={openRow}
          columnTitle={t('settingsAgents.title')}
          browseAll={{
            label: t('capabilities.skillsUpdates.shelf.browseAll'),
            onPress: () => openBrowse(),
          }}
        />
        {providersEnabled ? (
          <ItemGroup
            testID="settings-agents-home.models"
            title={t('capabilities.agentsHome.modelsTitle')}
            description={t('capabilities.agentsHome.modelsBody')}
          >
            {providerRows.map(row => (
              <AgentModelsProviderRow key={row.declaration.contributionKey} row={row} onOpen={openProvider} />
            ))}
            <Item
              testID="settings-agents-home.models.providers"
              title={t('settingsProviders.title')}
              subtitle={t('settingsProviders.entrySubtitle')}
              icon={
                <Icon
                  name="cube"
                  size={20}
                  color={theme.colors.text.secondary}
                />
              }
              onPress={openProviders}
            />
          </ItemGroup>
        ) : null}
      </PageContentColumn>
    </ItemList>
  );
});

/** Data binding for S30-UI's Models composition; setup stays with the existing Provider authoring route. */
const AgentModelsProviderRow = React.memo(function AgentModelsProviderRow(props: Readonly<{
  row: AgentProviderRow;
  onOpen: (row: AgentProviderRow) => void;
}>) {
  const { theme } = useUnistyles();
  const { declaration } = props.row;
  return <Item
    testID={`settings-agents-home.models.provider.${declaration.contributionKey}`}
    title={declaration.definition.name}
    icon={<ProviderIcon contributionKey={declaration.contributionKey} icon={declaration.definition.icon} size={20} color={theme.colors.text.secondary} />}
    onPress={() => props.onOpen(props.row)}
  />;
});

/** An agent signed out on the selected Machine: the status word, what it costs, and its one fix (its page's sign-in). */
const NeedsYouRow = React.memo(function NeedsYouRow(
  props: Readonly<{
    row: AgentCollectionRow;
    machineLabel: string | null;
    mark: React.ReactNode;
    onOpen: (row: AgentCollectionRow) => void;
  }>,
) {
  const { row, onOpen } = props;
  const open = React.useCallback(() => onOpen(row), [onOpen, row]);
  const status = React.useMemo(() => ({ kind: 'signin' as const }), []);
  const fixLabel = presentCapabilityStatus(status, 'row').fixLabel;
  return (
    <CapabilityRow
      testID={`settings-agents-home.needs.${row.key}`}
      title={row.entry.title}
      description={
        props.machineLabel
          ? t('capabilities.agentsHome.needsSignIn', {
              machine: props.machineLabel,
            })
          : null
      }
      mark={props.mark}
      status={status}
      {...(fixLabel
        ? {
            action: (
              <RoundButton
                testID={`settings-agents-home.needs.${row.key}.fix`}
                size="small"
                display="secondary"
                title={fixLabel}
                onPress={open}
              />
            ),
          }
        : {})}
      onPress={open}
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  actions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  count: { color: theme.colors.text.secondary, fontVariant: ['tabular-nums'] },
}));
