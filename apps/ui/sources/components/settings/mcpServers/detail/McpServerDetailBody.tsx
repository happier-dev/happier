import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { McpServerCatalogEntryV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';

import { CapabilityBlockingBanner } from '@/components/capabilities/detail/CapabilityBlockingBanner';
import {
  CapabilityMachineTruth,
  type CapabilityMachineTruthRow,
} from '@/components/capabilities/detail/CapabilityMachineTruth';
import {
  pickMostBlockingCapabilityStatus,
  type CapabilityStatus,
} from '@/components/capabilities/status/capabilityStatusPresentation';
import { WhereItsOnControl } from '@/components/capabilities/where/WhereItsOnControl';
import { useWhereItsOnNames } from '@/components/capabilities/where/useWhereItsOnNames';
import { CodeBlockView } from '@/components/ui/code/blocks/CodeBlockView';
import {
  ExpandableItem,
  ExpandableItemCaret,
} from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { Text } from '@/components/ui/text/Text';
import {
  useReachMachines,
  useReachProjection,
} from '@/sync/domains/capabilities/reach/useReachProjection';
import { useReachRules } from '@/sync/domains/capabilities/reach/useReachRules';
import { t } from '@/text';

import {
  mcpServerMachineStatuses,
  mcpServerStatus,
  type McpSavedSecretAvailability,
  type McpServerMachineFact,
} from '../status/mcpServerStatus';
import { useMcpServerMachineTests } from '../status/useMcpServerMachineTests';
import { McpServerToolsSection } from '../tools/McpServerToolsSection';
import { useMcpServerTools } from '../tools/useMcpServerTools';
import { useMcpServerSignIn } from '../signIn/useMcpServerSignIn';
import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useMachineAdministrationTargetSelection } from '@/sync/domains/machines/administration/useTargetSelection';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { machinePageHref } from '@/components/machines/page/machinePageHref';
import type { McpServerRecovery } from './mcpServerRecovery';
import { useMcpServerUpdate } from './useMcpServerUpdate';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { refreshMcpServerCatalog } from '@/sync/engine/settings/mcpServerCatalogEngine';

function formatTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(ms);
}
function formatDay(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(ms);
}

/**
 * The server page between its header and its Configuration (md A order): the one blocking banner, Where
 * it's on, Tools; and after Configuration, the truth on each machine and the Details. Data comes from the
 * `mcp.servers` Actions, P2's reach owners and REACH's presence; nothing here stores per-machine state.
 */
export function useMcpServerDetail(
  server: McpServerCatalogEntryV1,
  catalogRevision: number | 'absent' | null,
  savedSecretCatalog: McpSavedSecretAvailability,
  recovery?: McpServerRecovery,
): {
  reach: ReturnType<typeof useReachRules>;
  projection: ReturnType<typeof useReachProjection>;
  placeMachines: { machineId: string; name: string; online: boolean | null }[];
  projects: ReturnType<typeof useWhereItsOnNames>['projects'];
  agentIds: string[];
  names: ReturnType<typeof useWhereItsOnNames>['names'];
  onMachines: readonly (McpServerMachineFact & Readonly<{ lastSeenAt: number | null }>)[];
  tests: ReturnType<typeof useMcpServerMachineTests>;
  tools: ReturnType<typeof useMcpServerTools>;
  update: ReturnType<typeof useMcpServerUpdate>;
  execution: ReturnType<typeof useMountedActionExecution>;
  signIn: ReturnType<typeof useMcpServerSignIn>;
  statuses: ReturnType<typeof mcpServerStatus>;
  machineStatuses: ReturnType<typeof mcpServerMachineStatuses>;
  testOnline: () => void;
} {
  const router = useRouter();
  const serverId = server.id;
  const reach = useReachRules('mcp_server', serverId);
  const projection = useReachProjection('mcp_server', serverId);
  const { machines, scope } = useReachMachines();
  const tests = useMcpServerMachineTests(serverId, server);
  const updateExecution = useMountedActionExecution(scope);
  const reloadCatalog = React.useCallback(() => scope ? refreshMcpServerCatalog(scope) : Promise.resolve(), [scope]);
  const update = useMcpServerUpdate({ server, catalogRevision, execution: updateExecution,
    scopeKey: JSON.stringify(scope), reload: reloadCatalog });

  const placeMachines = React.useMemo(
    () =>
      machines.map((machine) => ({
        machineId: machine.machineId,
        name: machine.name ?? machine.machineId,
        online: machine.online,
      })),
    [machines],
  );
  const agentIds = React.useMemo(
    () => [...new Set(machines.flatMap((machine) => machine.agentIds))],
    [machines],
  );
  const tools = useMcpServerTools(serverId, catalogRevision, agentIds);
  const { names, projects } = useWhereItsOnNames({
    agentIds,
    machines: placeMachines,
    machineId: tools.list?.perAgent.machineId ?? null,
    serverId: scope?.serverId ?? null,
  });

  // The machines where it is on (any Agent there takes it), with presence and last-seen.
  const onMachines = React.useMemo((): readonly (McpServerMachineFact &
    Readonly<{ lastSeenAt: number | null }>)[] => {
    const on = new Set(
      projection
        .filter((row) => row.agents.some((agent) => agent.enabled))
        .map((row) => row.machineId),
    );
    return machines
      .filter((machine) => on.has(machine.machineId))
      .map((machine) => ({
        machineId: machine.machineId,
        name: machine.name ?? machine.machineId,
        online: machine.online,
        lastSeenAt: machine.lastSeenAt,
        ...(machine.lastSeenAt
          ? { lastSeen: formatDay(machine.lastSeenAt) }
          : {}),
      }));
  }, [machines, projection]);

  const signIn = useMcpServerSignIn(server, placeMachines);
  const startSignIn = signIn.start;
  const runTest = tests.run;
  const { afterRegistryAdd } = useLocalSearchParams<{ afterRegistryAdd?: string }>();
  const administration = useMachineAdministrationTargetSelection(MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.mcpServers,
    { enabled: afterRegistryAdd === '1' });
  const registryAddHandled = React.useRef<string | null>(null);
  React.useEffect(() => {
    const targetKey = JSON.stringify([scope?.serverId, scope?.accountId, serverId]);
    if (afterRegistryAdd !== '1' || registryAddHandled.current === targetKey || server.origin?.kind !== 'registry' || !updateExecution.ready) return;
    const target = administration.resolveExecutionTarget({ accountScope: scope });
    if (!target) return;
    registryAddHandled.current = targetKey;
    router.setParams({ afterRegistryAdd: undefined });
    // This navigation follows the person's Registry Add. Ordinary opens, edits,
    // Paste, Custom and session selection never request an administrative Test.
    if (server.remote?.auth?.kind === 'oauth') void startSignIn();
    else runTest([target.machine.id]);
  }, [administration, afterRegistryAdd, router, runTest, scope, serverId, server.origin?.kind, server.remote?.auth?.kind, startSignIn, updateExecution.ready]);
  const fixes = React.useMemo(
    () => ({
      signIn: () => void startSignIn(),
      reconnect: () => void startSignIn(),
      grantAccess: () => void startSignIn({ stepUp: true }),
      addKey: recovery?.addKey,
      howToFix: recovery?.howToFix ?? ((machineId: string) => router.push(machinePageHref({ door: 'rail', target: { machineId, serverId: scope?.serverId }, tab: { id: 'setup', page: 'tools' } }) as never)),
      tryAgain: (machineId: string) => runTest([machineId]),
    }),
    [recovery, router, runTest, scope?.serverId, startSignIn],
  );
  const statusInput = React.useMemo(
    () => ({
      entry: server,
      signIn: signIn.fact,
      tests: tests.results,
      machines: onMachines,
      savedSecretCatalog,
      fixes,
    }),
    [fixes, onMachines, savedSecretCatalog, server, signIn.fact, tests.results],
  );
  const statuses = React.useMemo(
    () => mcpServerStatus(statusInput),
    [statusInput],
  );
  const machineStatuses = React.useMemo(
    () => mcpServerMachineStatuses(statusInput),
    [statusInput],
  );
  const testOnline = React.useCallback(
    () =>
      runTest(
        onMachines
          .filter((machine) => machine.online)
          .map((machine) => machine.machineId),
      ),
    [onMachines, runTest],
  );

  return {
    reach,
    projection,
    placeMachines,
    projects,
    agentIds,
    names,
    onMachines,
    tests,
    tools,
    update,
    execution: updateExecution,
    signIn,
    statuses,
    machineStatuses,
    testOnline,
  };
}

export type McpServerDetail = ReturnType<typeof useMcpServerDetail>;

function bannerCopy(
  status: CapabilityStatus,
  name: string,
  toolCount: number | undefined,
): Readonly<{ title: string; body: string }> | null {
  switch (status.kind) {
    case 'expired':
      return {
        title: t('capabilities.mcp.detail.banner.expiredTitle', { name }),
        body: t('capabilities.mcp.detail.banner.expiredBody', {
          name,
          date: status.detail,
          count: toolCount,
        }),
      };
    case 'signin':
      return {
        title: t('capabilities.mcp.detail.banner.signinTitle', { name }),
        body: t('capabilities.mcp.detail.banner.signinBody'),
      };
    case 'more_access':
      return {
        title: t('capabilities.mcp.detail.banner.moreAccessTitle', { name }),
        body: t('capabilities.mcp.detail.banner.moreAccessBody'),
      };
    case 'revoked':
      return {
        title: t('capabilities.mcp.detail.banner.revokedTitle', { name }),
        body: t('capabilities.mcp.detail.banner.revokedBody'),
      };
    case 'key':
      return {
        title: t('capabilities.mcp.detail.banner.keyTitle', { name }),
        body: t('capabilities.mcp.detail.banner.keyBody'),
      };
    case 'error':
      return {
        title: t('capabilities.mcp.detail.banner.errorTitle', {
          name,
          machine: status.machineName ?? '',
        }),
        body: t('capabilities.mcp.detail.banner.errorBody'),
      };
    case 'cantrun':
      return {
        title: t('capabilities.mcp.detail.banner.cantrunTitle', {
          name,
          machine: status.machineName ?? '',
        }),
        body: t('capabilities.mcp.detail.banner.cantrunBody', {
          runtime: status.detail ?? '',
        }),
      };
    default:
      return null;
  }
}

const SIGN_IN_KINDS: ReadonlySet<CapabilityStatus['kind']> = new Set(['signin', 'signing', 'connected', 'more_access', 'expired', 'revoked']);

/** The banner: the one most blocking status, said once with its fix. */
export function McpServerBanner(
  props: Readonly<{
    detail: McpServerDetail;
    name: string;
    toolCount?: number;
  }>,
) {
  // The Sign-in section, right under the header, already says any sign-in state with its one action.
  const statuses = props.detail.signIn.view
    ? props.detail.statuses.filter((status) => !SIGN_IN_KINDS.has(status.kind))
    : props.detail.statuses;
  const top = pickMostBlockingCapabilityStatus(statuses, 'header');
  const copy = top ? bannerCopy(top, props.name, props.toolCount) : null;
  if (!top || !copy) return null;
  return (
    <CapabilityBlockingBanner
      testID="mcp.server.banner"
      status={top}
      title={copy.title}
      body={copy.body}
    />
  );
}

export function McpServerWhereAndTools(
  props: Readonly<{ detail: McpServerDetail; readOnly?: boolean }>,
) {
  const { detail } = props;
  return (
    <>
      <WhereItsOnControl
        testID="mcp.server.where"
        kind="mcp_server"
        presentation="section"
        rules={detail.reach.rules}
        status={detail.reach.status}
        projection={detail.reach.status === 'ready' ? detail.projection : null}
        places={{
          agentIds: detail.agentIds,
          machines: detail.placeMachines,
          projects: detail.projects,
        }}
        onChange={detail.reach.change}
        onUndo={async () => {
          await detail.reach.undoLast();
        }}
      />
      <McpServerToolsSection
        testID="mcp.server.tools"
        status={detail.tools.status}
        list={detail.tools.list}
        agentNames={detail.names.agentNames}
        installedAgentIds={detail.agentIds}
        onChange={detail.tools.set}
        errorCode={detail.tools.errorCode}
        onRetry={detail.tools.reload}
        readOnly={props.readOnly}
      />
    </>
  );
}

/** A machine row already names its machine: its chip says only what happened ("Couldn't start"). */
function rowStatus(status: CapabilityStatus | undefined): CapabilityStatus | null {
  if (!status) return null;
  if (status.kind !== 'error' && status.kind !== 'cantrun') return status;
  const { machineName: _named, ...rest } = status;
  return rest;
}

export function McpServerMachinesAndDetails(
  props: Readonly<{ detail: McpServerDetail; server: McpServerCatalogEntryV1 }>,
) {
  const { detail, server } = props;
  const { theme } = useUnistyles();
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const snapshotCount =
    detail.tools.list?.snapshot?.tools.length ??
    server.toolsSnapshot?.tools.length;
  const rows = detail.onMachines.map((machine): CapabilityMachineTruthRow => {
    const test = detail.tests.results[machine.machineId];
    const count = test?.ok ? test.toolCount : snapshotCount;
    const who = [
      count !== undefined
        ? t('capabilities.mcp.detail.toolsOn', { count })
        : null,
      !machine.online
        ? null
        : test
          ? t('capabilities.mcp.detail.checked', {
              time: formatTime(test.checkedAt),
            })
          : t('capabilities.mcp.detail.notChecked'),
    ]
      .filter(Boolean)
      .join(' · ');
    return {
      machineId: machine.machineId,
      machineName: machine.name,
      deviceIcon: 'desktop',
      who,
      offline: machine.online === false,
      status: rowStatus(detail.machineStatuses.get(machine.machineId)),
      ...(machine.online === null ? { note: t('common.unknown') } : {}),
      ...(machine.online === false && machine.lastSeenAt
        ? {
            note: t('capabilities.mcp.detail.lastKnown', {
              time: formatDay(machine.lastSeenAt),
            }),
          }
        : {}),
    };
  });
  const counts = { ready: 0, problems: 0, offline: 0, unchecked: 0 };
  for (const machine of detail.onMachines) {
    const test = detail.tests.results[machine.machineId];
    if (machine.online === null) continue;
    if (machine.online === false) counts.offline += 1;
    else if (!test) counts.unchecked += 1;
    else if (test.ok) counts.ready += 1;
    else counts.problems += 1;
  }
  const lastOutput = Object.values(detail.tests.results)
    // The machine's own words: its stderr tail, else the error it answered with.
    .map((result) => result?.stderrTail ?? (result && !result.ok ? result.message : undefined))
    .find((tail): tail is string => Boolean(tail));
  const snapshot = detail.tools.list?.snapshot ?? server.toolsSnapshot;
  const version = snapshot?.serverInfo?.version;
  const running = detail.tests.running.size > 0;
  const hasDetails = Boolean(version || snapshot?.instructions || lastOutput);
  return (
    <>
      <CapabilityMachineTruth
        testID="mcp.server.machines"
        description={t('capabilities.mcp.detail.machinesDescription')}
        rows={rows}
        summary={t('capabilities.mcp.detail.summary', counts)}
        summaryNote={detail.onMachines.some(machine => machine.online === null) ? t('common.unknown') : undefined}
        emptyLabel={t('capabilities.mcp.detail.onNowhere')}
        defaultExpanded={rows.length > 0 && rows.length <= 6}
        sectionAction={{
          label: t('capabilities.mcp.detail.test'),
          icon: 'play',
          busy: running,
          onPress: detail.testOnline,
        }}
      />
      {hasDetails ? (
        <ItemGroup header="none">
          <ExpandableItem
            testID="mcp.server.details"
            expanded={detailsOpen}
            onExpandedChange={setDetailsOpen}
            showDivider={false}
            header={({ headerProps, expanded }) => (
              <Item
                {...(headerProps as Readonly<Record<string, unknown>>)}
                title={t('capabilities.mcp.detail.detailsTitle')}
                leftElement={<ExpandableItemCaret expanded={expanded} />}
                rightElement={
                  version ? (
                    <Text
                      variant="meta"
                      style={{ color: theme.colors.text.secondary }}
                    >
                      {t('capabilities.mcp.detail.versionLine', {
                        version,
                        protocol: snapshot?.protocolVersion,
                      })}
                    </Text>
                  ) : undefined
                }
                showChevron={false}
              />
            )}
          >
            {detailsOpen ? (
              <>
                {snapshot?.instructions ? (
                  <SectionContentRow>
                    <View style={styles.block}>
                      <Text variant="label">
                        {t('capabilities.mcp.detail.serverInstructions')}
                      </Text>
                      <Text
                        variant="body"
                        style={{ color: theme.colors.text.secondary }}
                      >
                        {snapshot.instructions}
                      </Text>
                    </View>
                  </SectionContentRow>
                ) : null}
                {lastOutput ? (
                  <SectionContentRow>
                    <View style={styles.block}>
                      <Text variant="label">
                        {t('capabilities.mcp.detail.lastError')}
                      </Text>
                      <CodeBlockView
                        code={lastOutput}
                        wrap
                        selectable
                        showCopyButton
                      />
                    </View>
                  </SectionContentRow>
                ) : null}
              </>
            ) : null}
          </ExpandableItem>
        </ItemGroup>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  block: { gap: theme.space.s6, minWidth: 0 },
}));
