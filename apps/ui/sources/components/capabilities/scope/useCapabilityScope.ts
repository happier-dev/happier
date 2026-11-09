import * as React from 'react';
import type { McpServerCatalogEntryV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import type { ReachRulesV1 } from '@happier-dev/protocol/reach/reachRuleV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import {
  presentCapabilityStatus,
  pickMostBlockingCapabilityStatus,
  type CapabilityStatus,
} from '@/components/capabilities/status/capabilityStatusPresentation';
import { useAnnouncedCheckoutMachine } from '@/components/workspaces/reachability/checkoutReachability';
import { useWhereItsOnNames } from '@/components/capabilities/where/useWhereItsOnNames';
import type { WhereItsOnNames } from '@/components/capabilities/where/whereItsOnPresentation';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { usePluginMcpServerItems } from '@/components/settings/mcpServers/collection/usePluginMcpServerItems';
import {
  mcpServerDisplayName,
  mcpServerRoute,
} from '@/components/settings/mcpServers/collection/mcpServerCollectionModel';
import {
  aggregateMcpMachineOnline,
  findMcpSignInGrant,
  mcpSignInFact,
  mcpSignInGrantView,
} from '@/components/settings/mcpServers/signIn/mcpSignInGrantView';
import { useMcpSignInGrantDiagnostics } from '@/components/settings/mcpServers/signIn/useMcpSignInGrantDiagnostics';
import { mcpServerAttentionStatus } from '@/components/settings/mcpServers/status/mcpServerStatus';
import { useMcpServersSettings } from '@/components/settings/mcpServers/useMcpServersSettings';
import {
  SKILLS_FOUND_ROUTE,
  maskedLibraryNames,
} from '@/components/settings/skills/found/foundSkillsModel';
import { skillStatus } from '@/components/settings/skills/status/skillStatus';
import {
  useReachMachines,
  useReachProjects,
} from '@/sync/domains/capabilities/reach/useReachProjection';
import { useFoundSkillsCache } from '@/sync/domains/skills/useFoundSkills';
import { useSkillsLibrary } from '@/sync/domains/skills/useSkillsLibrary';
import { capabilityDismissalState, usePersistentUiStateValue } from '@/sync/domains/state/persistentUiState';
import { getStorage } from '@/sync/domains/state/storageStore';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
  SCOPE_ROW_LIMIT,
  listsWaitOnMachine,
  machinesNeedingOfflineNote,
  migratedProjectRuleItems,
  orderScopeRows,
  type ScopeMachine,
  type ScopePlace,
} from './capabilityScopeModel';

export type ScopeRowData = Readonly<{
  id: string;
  kind: 'skill' | 'mcp_server';
  name: string;
  /** The rules the list holds; the row reads its own live copy through the rules owner. */
  rules: ReachRulesV1;
  hasRuleHere: boolean;
  /** The one status that needs the person (sign-in, key, error, masked), with its fix. */
  status: CapabilityStatus | null;
  /** A masked copy never takes the switch: this machine's own copy wins whatever the rules say. */
  masked: boolean;
  transport?: McpServerCatalogEntryV1['transport'];
  iconUrl?: string | null;
}>;

export type ScopeListData = Readonly<{
  state: 'loading' | 'ready' | 'unavailable';
  total: number;
  rows: readonly ScopeRowData[];
  retry: () => void;
}>;

export type CapabilityScopeData = Readonly<{
  machines: readonly ScopeMachine[];
  /** Covered machines that cannot be reached right now, by name. */
  offlineNames: readonly string[];
  /** The covered machine the lists wait for; `announced` when the page above already says it is not answering. */
  unreachableMachine: Readonly<{ name: string; announced: boolean }> | null;
  names: WhereItsOnNames;
  skills: ScopeListData;
  mcp: ScopeListData;
  /** Items still carrying a rule migrated for this Project, and the dismissal of their one-time note. */
  migrated: Readonly<{ names: readonly string[]; dismiss: () => void }>;
  open: (href: string) => void;
}>;

function isHere(rules: ReachRulesV1, place: ScopePlace): boolean {
  return rules.some((rule) =>
    place.t === 'machine'
      ? rule.target.t === 'machine' && rule.target.machineId === place.machineId
      : rule.target.t === 'project' &&
        rule.target.projectKey === place.projectKey,
  );
}

/** Needs the person (needs you or failed); healthy, quiet and neutral statuses stay out of a switch row. */
function needsPerson(status: CapabilityStatus | null): CapabilityStatus | null {
  if (!status) return null;
  const tone = presentCapabilityStatus(status, 'row').tone;
  return tone === 'needs_you' || tone === 'failed' ? status : null;
}

/**
 * Keeps the visible rows where they were while a switch is flipped: writing a rule here would otherwise lift its
 * row to the top the moment the write lands. The order is taken again only when the place or the set of items
 * changes.
 */
function useStableScopeOrder(
  placeKey: string,
  rows: readonly ScopeRowData[],
): readonly ScopeRowData[] {
  const order = React.useRef<Readonly<{
    key: string;
    ids: readonly string[];
  }> | null>(null);
  const key = `${placeKey}|${rows
    .map((row) => row.id)
    .sort()
    .join('|')}`;
  if (order.current?.key !== key) {
    order.current = {
      key,
      ids: orderScopeRows(
        rows.map((row) => ({
          id: row.id,
          name: row.name,
          hasRuleHere: row.hasRuleHere,
          problem: row.status !== null,
        })),
      ).map((row) => row.id),
    };
  }
  return React.useMemo(() => {
    const byId = new Map(rows.map((row) => [row.id, row]));
    return order.current!.ids.flatMap((id) => byId.get(id) ?? []);
  }, [rows]);
}

/**
 * Everything the "Skills and MCP servers" section needs for one place: the Account's skills and MCP servers read
 * through their own owners, the machines the place covers, and each row's status from the status owners. It owns
 * no rule logic; the switch reads and writes through `capabilityScopeModel` and the rules owner per row.
 */
export function useCapabilityScope(place: ScopePlace): CapabilityScopeData {
  const router = useRouter();
  const library = useSkillsLibrary();
  const { settings, snapshot, scope, reload } = useMcpServersSettings();
  const pluginItems = usePluginMcpServerItems();
  const reach = useReachMachines();
  const { workspaceRefs } = useReachProjects(reach.scope?.serverId);
  const placeKey =
    place.t === 'machine'
      ? `machine:${place.machineId}`
      : `project:${place.projectKey}`;

  const machines = React.useMemo<readonly ScopeMachine[]>(() => {
    const covered =
      place.t === 'machine'
        ? new Set([place.machineId])
        : new Set(
            workspaceRefs
              .filter((ref) => (ref.projectKey ?? ref.id) === place.projectKey)
              .map((ref) => ref.machineId),
          );
    return reach.machines
      .filter((machine) => covered.has(machine.machineId))
      .map((machine) => ({
        machineId: machine.machineId,
        platform: machine.platform,
        agentIds: machine.agentIds,
      }));
  }, [place, reach.machines, workspaceRefs]);
  const coveredMachines = React.useMemo(
    () =>
      reach.machines.filter((machine) =>
        machines.some((row) => row.machineId === machine.machineId),
      ),
    [machines, reach.machines],
  );
  const { names } = useWhereItsOnNames({ agentIds: reach.agentIds, machines: reach.placeMachines });
  const announcedMachineId = useAnnouncedCheckoutMachine()?.machineId ?? null;
  const offlineNames = React.useMemo(
    () =>
      machinesNeedingOfflineNote(coveredMachines, announcedMachineId).map(
        (machine) => names.machineName(machine.machineId),
      ),
    [announcedMachineId, coveredMachines, names],
  );

  const unreachableMachine = React.useMemo(() => {
    const waiting = listsWaitOnMachine(coveredMachines, announcedMachineId);
    return waiting ? { name: names.machineName(waiting.machine.machineId), announced: waiting.announced } : null;
  }, [announcedMachineId, coveredMachines, names]);

  const open = React.useCallback(
    (href: string) => {
      const result = runGuardedNavigation(() => router.push(href as never));
      if (result !== true)
        fireAndForget(result, { tag: 'CapabilityScope.open' });
    },
    [router],
  );

  // Skills: a library skill this machine's own same-name copy wins over is masked here and takes no switch.
  const foundCache = useFoundSkillsCache(
    React.useMemo(
      () => machines.map((machine) => machine.machineId),
      [machines],
    ),
  );
  const maskedHere = React.useMemo(
    () =>
      maskedLibraryNames(
        coveredMachines.map((machine) => ({
          machineId: machine.machineId,
          name: machine.name,
        })),
        foundCache,
      ),
    [coveredMachines, foundCache],
  );
  const skillRows = React.useMemo<readonly ScopeRowData[]>(
    () =>
      library.items.map((item) => {
        const maskedOn = maskedHere.get(item.name);
        const blocking = needsPerson(
          pickMostBlockingCapabilityStatus(
            skillStatus(item, {
              nowMs: Date.now(),
              usageObservedSince: library.usageObservedSince,
            }),
            'row',
          ),
        );
        const status: CapabilityStatus | null =
          maskedOn !== undefined
            ? {
                kind: 'masked',
                machineName: maskedOn,
                fix: {
                  kind: 'compare',
                  onPress: () => open(SKILLS_FOUND_ROUTE),
                },
              }
            : blocking;
        return {
          id: item.skillId,
          kind: 'skill',
          name: item.name,
          rules: item.rules,
          hasRuleHere: isHere(item.rules, place),
          status,
          masked: maskedOn !== undefined,
        };
      }),
    [library.items, library.usageObservedSince, maskedHere, open, place],
  );
  const orderedSkills = useStableScopeOrder(placeKey, skillRows);

  // MCP servers: the Account's catalog and the plugins' servers, each with the sign-in / key status its owner reads.
  const grants = getStorage()((state) => state.profile.connectedAccountsV4);
  const diagnostics = useMcpSignInGrantDiagnostics(
    grants,
    scope,
  );
  const savedSecretCatalog = useSavedSecretCatalog({ scope });
  const anyOnline = aggregateMcpMachineOnline(coveredMachines);
  const mcpRows = React.useMemo<readonly ScopeRowData[]>(() => {
    const bindingsOf = (serverId: string) =>
      settings.bindings.filter((binding) => binding.serverId === serverId);
    const catalog = settings.servers.map((server): ScopeRowData => {
      const rules = bindingsOf(server.id);
      const openServer = () => open(mcpServerRoute(server.id));
      const status = mcpServerAttentionStatus({
        entry: server,
        signIn: mcpSignInFact(
          mcpSignInGrantView(
            server,
            findMcpSignInGrant(grants, server.id),
            anyOnline,
            diagnostics[server.id],
          ),
        ),
        savedSecretCatalog,
        open: openServer,
      });
      return {
        id: server.id,
        kind: 'mcp_server',
        name: mcpServerDisplayName(server),
        rules,
        hasRuleHere: isHere(rules, place),
        status,
        masked: false,
        transport: server.transport,
        iconUrl: null,
      };
    });
    const plugins = pluginItems.map((item): ScopeRowData => {
      const rules = bindingsOf(item.id);
      return {
        id: item.id,
        kind: 'mcp_server',
        name: item.title ?? item.name,
        rules,
        hasRuleHere: isHere(rules, place),
        status: null,
        masked: false,
        transport: item.transport,
        iconUrl: null,
      };
    });
    return [...catalog, ...plugins];
  }, [
    settings.bindings,
    settings.servers,
    pluginItems,
    grants,
    anyOnline,
    diagnostics,
    savedSecretCatalog,
    open,
    place,
  ]);
  const orderedMcp = useStableScopeOrder(placeKey, mcpRows);

  const migrationSeenAt = usePersistentUiStateValue(capabilityDismissalState, 'projectSkillsMigrationNoteSeenAt') ?? null;
  const migratedNames = React.useMemo(() => {
    if (place.t !== 'project' || migrationSeenAt !== null)
      return [] as readonly string[];
    return [
      ...migratedProjectRuleItems(skillRows, place.projectKey),
      ...migratedProjectRuleItems(mcpRows, place.projectKey),
    ].map((row) => row.name);
  }, [mcpRows, migrationSeenAt, place, skillRows]);
  const dismiss = React.useCallback(
    () => capabilityDismissalState.set('projectSkillsMigrationNoteSeenAt', Date.now()),
    [],
  );

  const skills = React.useMemo<ScopeListData>(
    () => ({
      state:
        library.status === 'unavailable' && library.items.length === 0
          ? 'unavailable'
          : library.status === 'loading' && library.items.length === 0
            ? 'loading'
            : 'ready',
      total: skillRows.length,
      rows: orderedSkills.slice(0, SCOPE_ROW_LIMIT),
      retry: library.retry,
    }),
    [
      library.items.length,
      library.retry,
      library.status,
      orderedSkills,
      skillRows.length,
    ],
  );
  const mcp = React.useMemo<ScopeListData>(
    () => ({
      state:
        (snapshot.status === 'unavailable' || snapshot.status === 'partial') &&
        mcpRows.length === 0
          ? 'unavailable'
          : snapshot.status === 'loading' && mcpRows.length === 0
            ? 'loading'
            : 'ready',
      total: mcpRows.length,
      rows: orderedMcp.slice(0, SCOPE_ROW_LIMIT),
      retry: () => void reload(),
    }),
    [mcpRows.length, orderedMcp, reload, snapshot.status],
  );

  return React.useMemo(
    () => ({
      machines,
      offlineNames,
      unreachableMachine,
      names,
      skills,
      mcp,
      migrated: { names: migratedNames, dismiss },
      open,
    }),
    [dismiss, machines, mcp, migratedNames, names, offlineNames, open, skills, unreachableMachine],
  );
}

