import * as React from 'react';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { View } from 'react-native';

import { AgentsAcpBackendsDeleteOutputV1Schema } from '@happier-dev/protocol/acp/catalog/catalogMutationsV1';
import type { AcpBackendDefinitionV1 } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { BUILT_IN_REGISTRY_SOURCES_V1 } from '@happier-dev/protocol/registries';

import { resolveConfiguredAcpAgentCatalogProjection } from '@/agents/backendCatalog/agentCatalogProjection';
import { createCustomAcpAgentSettingsRoute } from '@/agents/catalog/agentSettingsRoutes';
import { useMachineAgentsByMachine } from '@/agents/machineAgents/useMachineAgents';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { HappierBrandMark } from '@/components/ui/media/HappierBrandMark';
import { useAcpCatalogActionExecution } from '@/components/settings/acpCatalog/useAcpCatalogActionExecution';
import { useAgentsAdministrationTargetSelection } from '@/components/settings/agents/collection/useAgentAdministrationCatalog';
import { confirmAgentInstallChange } from '@/components/settings/agents/install/agentInstallChangeConfirm';
import { useAgentPreferenceWriter } from '@/components/settings/agents/useAgentPreferenceWriter';
import {
  ExpandableItem,
} from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageLeaveActions } from '@/components/ui/layout/PageLeaveActions';
import { Modal } from '@/modal';
import { useRegistryUpdateCheck } from '@/registries/useRegistryUpdateCheck';
import { useSetting } from '@/sync/domains/state/storage';
import { useAcpCatalog } from '@/sync/store/useAcpCatalog';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { t } from '@/text';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';

import { AgentDetailHeader } from './AgentDetailHeader';
import { AgentMachinesSection } from './AgentMachinesSection';
import { listAgentMachines } from './agentMachinesModel';
import { AgentSourceAndUpdatesSection } from './AgentSourceAndUpdatesSection';

const TEST_ID = 'settings.agents.registryDetail';
const AGENTS_ROUTE = '/(app)/settings/agents';

/** How a registry definition launches, in one line ("goose 1.54.0 · npm package"). */
function describeLaunch(definition: AcpBackendDefinitionV1): string {
  const launch = definition.launch;
  switch (launch.kind) {
    case 'npm':
      return [`${launch.package}@${launch.version}`, ...launch.args].join(' ');
    case 'uv':
      return [`${launch.package}==${launch.version}`, ...launch.args].join(' ');
    case 'archive': {
      // The executable the download unpacks ("goose acp"), the same on every platform's asset.
      const asset = Object.values(launch.assetsByPlatform).find((entry) => entry !== undefined);
      const executable = asset?.executableSubpath.split(/[\\/]/).pop()?.replace(/\.exe$/i, '') ?? launch.version;
      return [executable, ...launch.args].join(' ');
    }
    case 'command':
      return [launch.command, ...launch.args].join(' ');
  }
}

/** Whether a definition came from a registry (its detail is this page; a command agent keeps its editor). */
export function isRegistryAgentDefinition(
  definition: AcpBackendDefinitionV1 | null | undefined,
): definition is AcpBackendDefinitionV1 {
  return Boolean(
    definition &&
    definition.launch.kind !== 'command' &&
    definition.origin?.kind === 'registry',
  );
}

/**
 * A registry agent's page (lab `ad D/Dp`, P9 row 24–26): where it is installed (every machine at
 * once), the Account's session defaults, where it comes from and its updates, how it launches, and
 * Remove agent. The same sections as a built-in agent's page, read from the definition.
 */
export function RegistryAgentDetailScreen(
  props: Readonly<{ definition: AcpBackendDefinitionV1 }>,
) {
  const { definition } = props;
  const router = useRouter();
  const scope = useAccountSettingsScope();
  const { snapshot } = useAcpCatalog(scope);
  const action = useAcpCatalogActionExecution(scope);
  const mounted = useMountedActionExecution(scope);
  const backendEnabledByTargetKey = useSetting('backendEnabledByTargetKey');
  const projection = React.useMemo(
    () =>
      resolveConfiguredAcpAgentCatalogProjection(definition, {
        enabledAgentIds: [],
        backendEnabledByTargetKey,
      }),
    [backendEnabledByTargetKey, definition],
  );
  const writePreference = useAgentPreferenceWriter();
  const targetSelection = useAgentsAdministrationTargetSelection();
  const activeServer = useActiveServerSnapshot();
  const serverId = activeServer.serverId || null;
  const origin = definition.origin;
  const pinnedVersion =
    definition.launch.kind === 'command' ? null : definition.launch.version;
  const registryTitle =
    BUILT_IN_REGISTRY_SOURCES_V1.find(
      (source) => source.id === origin?.provenance.sourceId,
    )?.title ?? null;

  // Machines where it is installed now: Update installs there, Remove agent uninstalls there.
  const accountMachines = React.useMemo(
    () => targetSelection.pickerRows.filter(
        // Revoked and replaced machines are no longer the Account's; only live members are listed.
        (row) => serverId !== null && areServerProfileIdentifiersEquivalent(row.serverId, serverId)
          && (row.candidate.availability === 'online' || row.candidate.availability === 'offline'),
      ),
    [serverId, targetSelection.pickerRows],
  );
  const machineIds = React.useMemo(
    () => accountMachines.map((row) => row.machine.id),
    [accountMachines],
  );
  const snapshots = useMachineAgentsByMachine({
    serverId: serverId ?? '',
    machineIds,
    load: false,
  });
  const installedOnline = React.useMemo(
    () =>
      listAgentMachines(accountMachines).filter(
        (machine) =>
          machine.online &&
          snapshots
            .get(machine.machineId)
            ?.agents.some(
              (agent) =>
                agent.definitionId === definition.id && agent.installed,
            ),
      ),
    [accountMachines, definition.id, snapshots],
  );

  const { check, checkNow } = useRegistryUpdateCheck({
    scopeKey: JSON.stringify([serverId, definition.id]),
    execute: mounted.execute,
    isCurrent: mounted.isCurrent,
    kind: 'agent',
    keys: [definition.id],
    retry: () => {},
  });
  const [updating, setUpdating] = React.useState(false);
  const update = React.useCallback(
    async (version: string) => {
      if (!origin) return;
      const confirmed = await confirmAgentInstallChange({
        name: projection.title,
        version,
        nowMachines: installedOnline.map((machine) => machine.sentenceName),
        firstUseMachines: [],
      });
      if (!confirmed || !mounted.isCurrent()) return;
      setUpdating(true);
      try {
        const result = await mounted.execute(
          'agents.acp.backends.installFromRegistry',
          {
            fromRegistry: {
              sourceId: origin.provenance.sourceId,
              itemId: origin.provenance.itemId,
              version,
            },
            ...(installedOnline.length > 0
              ? {
                  installOn: installedOnline.map(
                    (machine) => machine.machineId,
                  ),
                }
              : {}),
          },
          {
            confirmed: true,
          },
        );
        if (!result.ok)
          Modal.alert(
            t('common.error'),
            result.error ?? t('common.unavailable'),
          );
      } finally {
        setUpdating(false);
      }
    },
    [mounted, installedOnline, origin, projection.title],
  );

  const [removing, setRemoving] = React.useState(false);
  const removeAgent = React.useCallback(async () => {
    const catalog = snapshot?.catalog;
    if (
      !catalog ||
      catalog.status !== 'ready' ||
      snapshot?.stale ||
      catalog.revision === 'absent'
    )
      return;
    if (!action.isCurrent()) return;
    setRemoving(true);
    try {
      const execution = await action.execute(
        'agents.acp.backends.delete',
        { backendId: definition.id, expectedRevision: catalog.revision },
      );
      if (!execution.ok && isActionApprovalDeclinedErrorCode(execution.errorCode)) return;
      if (!execution.ok) throw new Error(execution.errorCode);
      AgentsAcpBackendsDeleteOutputV1Schema.parse(execution.result);
      router.replace(AGENTS_ROUTE as never);
    } catch {
      if (action.isCurrent())
        Modal.alert(t('common.error'), t('common.unavailable'));
    } finally {
      setRemoving(false);
    }
  }, [action, definition.id, projection.title, router, snapshot]);

  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const envCount = Object.keys(definition.env ?? {}).length;
  const removeFootnote =
    installedOnline.length > 0
      ? t('settingsAgents.detailPage.removeAgentFootnoteMachines', {
          machines: installedOnline.map((machine) => machine.sentenceName).join(', '),
        })
      : t('settingsAgents.detailPage.removeAgentFootnote');

  return (
    <ItemList>
      <AgentDetailHeader
        projection={projection}
        description={
          registryTitle
            ? t('settingsAgents.detailPage.kindRegistryAgent', {
                registry: registryTitle,
              })
            : t('settingsAgents.detailPage.kindCodingAgent')
        }
        machineId={null}
        serverId={serverId}
        identityCurrent
        mark={<HappierBrandMark brand={snapshot?.brandMarks?.[definition.id] ?? { displayName: definition.title || definition.name }} pixelSize={24} externallyLabelled />}
        enabled={
          projection.backendTargetKey
            ? {
                value: projection.enabled,
                disabled: false,
                onChange: (next) => {
                  if (projection.backendTargetKey)
                    void writePreference(
                      'enabled',
                      projection.backendTargetKey,
                      next,
                    );
                },
              }
            : null
        }
      />
      {serverId ? (
        <AgentMachinesSection
          testID={`${TEST_ID}.machines`}
          agentTitle={projection.title}
          agentId="custom-acp"
          definitionId={definition.id}
          pinnedVersion={pinnedVersion}
          serverId={serverId}
          targetSelection={targetSelection}
        />
      ) : null}
      {/* A registry agent's defaults are its definition's own mode and model (applied natively on new Sessions), edited where the definition is. */}
      <ItemGroup
        testID={`${TEST_ID}.sessionDefaults`}
        title={t('settingsAgents.detailPage.sessionDefaultsTitle')}
        description={t('settingsAgents.detailPage.sessionDefaultsSavedDescription', { agent: projection.title })}
      >
        {(['defaultMode', 'defaultModel'] as const).map((field) => (
          <Item
            key={field}
            testID={`${TEST_ID}.sessionDefaults.${field}`}
            title={t(field === 'defaultMode' ? 'settingsAgents.customAcp.defaultModeTitle' : 'settingsAgents.customAcp.defaultModelTitle')}
            detail={definition[field] ?? t('settingsAgents.customAcp.agentDefaultPlaceholder')}
            onPress={() => router.push(`${createCustomAcpAgentSettingsRoute(definition.id)}?edit=1` as never)}
          />
        ))}
      </ItemGroup>
      <AgentSourceAndUpdatesSection
        testID={`${TEST_ID}.source`}
        definition={definition}
        check={check}
        onCheckNow={() => {
          void checkNow();
        }}
        onUpdate={(version) => {
          void update(version);
        }}
        updating={updating}
      />
      <ItemGroup header="none">
        <ExpandableItem
          testID={`${TEST_ID}.details`}
          expanded={detailsOpen}
          onExpandedChange={setDetailsOpen}
          showDivider={false}
          header={(state) => (
            <Item
              {...state.headerProps}
              title={t('settingsAgents.detailPage.detailsTitle')}
              detail={
                state.expanded
                  ? undefined
                  : [
                      describeLaunch(definition),
                      envCount === 0
                        ? t('settingsAgents.detailPage.noVariables')
                        : t('settingsAgents.detailPage.variables', {
                            count: envCount,
                          }),
                    ].join(' · ')
              }
            />
          )}
        >
          <View>
            <Item
              testID={`${TEST_ID}.details.launch`}
              title={t('settingsAgents.detailPage.launchTitle')}
              subtitle={describeLaunch(definition)}
              subtitleLines={0}
              showChevron={false}
            />
            <Item
              testID={`${TEST_ID}.details.environment`}
              title={t('settingsAgents.detailPage.environmentTitle')}
              detail={
                envCount === 0
                  ? t('settingsAgents.detailPage.noVariables')
                  : t('settingsAgents.detailPage.variables', {
                      count: envCount,
                    })
              }
              onPress={() =>
                router.push(
                  `${createCustomAcpAgentSettingsRoute(definition.id)}?edit=1` as never,
                )
              }
            />
          </View>
        </ExpandableItem>
      </ItemGroup>
      <PageLeaveActions
        testID={`${TEST_ID}.leave`}
        footnote={removeFootnote}
        actions={[
          {
            testID: `${TEST_ID}.remove`,
            label: t('settingsAgents.detailPage.removeAgent'),
            icon: 'trash',
            display: 'bordered',
            busy: removing,
            onPress: () => {
              void removeAgent();
            },
          },
        ]}
      />
    </ItemList>
  );
}
