import * as React from 'react';
import {
  projectReachForMachinesV1,
  type ReachProjectionV1,
} from '@happier-dev/protocol/reach/projectReachV1';
import type { ReachRulesV1 } from '@happier-dev/protocol/reach/reachRuleV1';
import { isPersistentMachine } from '@happier-dev/protocol/machines/machineKind';
import { useActiveServerAccountScope, useMachineDisplayById } from '@/sync/store/hooks';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useMachinePresenceSummaries } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { formatMachineDisplayNameParts, resolveMachineDisplayNameParts } from '@/utils/sessions/machineDisplayNames';
import { useMachineAgentsByMachine } from '@/agents/machineAgents/useMachineAgents';
import { areServerProfileIdentifiersEquivalent, captureServerProfileScopeResolver } from '@/sync/domains/server/serverProfiles';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { useReachRulesCatalog } from '@/sync/store/useReachRulesCatalog';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { useProjectAccountRows } from '@/sync/domains/workspaces/projectAccountRows';
import { projectProjectListV1 } from '@happier-dev/protocol/workspaces';
import { resolveWorkspacePathBasenameV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { resolveWorkspaceDisplayLabel } from '@/sync/domains/workspaces/workspaceLabel';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { readInstalledMachineAgentInventory } from './installedMachineAgents';
import { getAcpCatalogSnapshot, subscribeAcpCatalogSnapshots } from '@/sync/store/settings/acpCatalogSnapshot';
import type { PluginProjectionV2 } from '@happier-dev/protocol';
import {
  captureDaemonMergedProjectionReader,
  type DaemonMergedProjectionSummary,
} from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { useSkillFeatureEnabled } from '@/sync/domains/skills/useSkillFeatureEnabled';

export type ReachMachineProjection = Readonly<
  ReachProjectionV1[number] & { online: boolean | null; offline: boolean; projectKey?: string; agentInventoryComplete?: boolean }
>;
const empty: readonly ReachMachineProjection[] = Object.freeze([]);
const emptyProjects: readonly Readonly<{ projectKey: string; name: string; machineCount: number }>[] = Object.freeze([]);
const emptyWorkspaceRefs: readonly WorkspaceRefV1[] = Object.freeze([]);

/** Accepted Account Projects, from the same scoped rows and grouping owner as Projects and reach. */
export function useReachProjects(serverId?: string | null) {
  const scope = useAccountSettingsScope();
  const rows = useProjectAccountRows();
  return React.useMemo(() => {
    if (!scope || !rows || !areServerAccountScopesEqual(scope, rows.scope)
      || (serverId && !areServerProfileIdentifiersEquivalent(serverId, scope.serverId))) {
      return { projects: emptyProjects, workspaceRefs: emptyWorkspaceRefs };
    }
    const workspaceRefs = rows.workspaceRefs.filter(ref => areServerProfileIdentifiersEquivalent(ref.serverId, scope.serverId));
    const grouped = projectProjectListV1({ serverId: scope.serverId, workspaceRefs,
      organizations: rows.organizations, normalizeServerId: resolveServerProfileScopeIdForIdentifier });
    // Hidden Projects remain valid rule targets and must keep their names in existing rules.
    const projects = [...grouped.projectGroups, ...grouped.hiddenProjectGroups].map(group => {
      const ref = group.items[0]!;
      const organization = rows.organizations.find(row => row.key.projectKey === group.projectKey.projectKey
        && areServerProfileIdentifiersEquivalent(row.key.serverId, scope.serverId));
      return { projectKey: group.projectKey.projectKey,
        name: organization?.value.label ?? resolveWorkspaceDisplayLabel({ scope: ref, workspaceRef: ref,
          fallbackPathLabel: resolveWorkspacePathBasenameV1(ref.rootPath) ?? ref.rootPath }),
        machineCount: new Set(group.items.map(item => item.machineId)).size };
    });
    return { projects, workspaceRefs };
  }, [scope, rows, serverId]);
}

/** One Account machine as reach sees it: published install facts and REACH's presence predicate. */
export type ReachMachine = Readonly<{
  machineId: string;
  platform: 'win32' | 'posix' | null;
  /** The machine's own published OS and CPU (`darwin`/`linux`/`win32`, `arm64`/`x64`): platform-fit facts, null while unknown. */
  os?: string | null;
  arch?: string | null;
  agentIds: readonly string[];
  /** Configured instance inventory may still be unknown even while its factory is published. */
  agentInventoryComplete?: boolean;
  /** Per-Machine declarations from the existing inert catalog cache; absent while cold. */
  agentDeclarationsById?: PluginProjectionV2['agentsById'] | null;
  /** Display name from the presence owner; null while unknown. */
  name: string | null;
  /** null while this Home/Account has no current presence observation. */
  online: boolean | null;
  offline: boolean;
  /** When an offline machine was last seen; null when online or unknown. */
  lastSeenAt: number | null;
}>;

/**
 * Published install facts work on a fresh device and remain available offline. Retained
 * metadata without that projection can use device-cache facts without starting RPCs.
 */
export function useReachMachines(): Readonly<{
  scope: Readonly<{ serverId: string; accountId: string }> | null;
  machines: readonly ReachMachine[];
}> {
  const activeScope = useAccountSettingsScope();
  const serverId = activeScope?.serverId;
  const accountId = activeScope?.accountId;
  const scope = React.useMemo(
    () => (serverId && accountId ? { serverId, accountId } : null),
    [serverId, accountId],
  );
  const profileScope = useActiveServerAccountScope();
  const { binding } = useServerCredentialAccountScopeBinding(serverId);
  const displays = useMachineDisplayById();
  const machines = React.useMemo(
    () => scope && profileScope && binding?.isCurrent()
      && scope.accountId === binding.scope.accountId && scope.accountId === profileScope.accountId
      && areServerProfileIdentifiersEquivalent(scope.serverId, binding.scope.serverId)
      && areServerProfileIdentifiersEquivalent(scope.serverId, profileScope.serverId)
      ? Object.values(displays).filter(isPersistentMachine).sort((left, right) => left.id.localeCompare(right.id))
      : [],
    [displays, profileScope, scope, binding],
  );
  const machineIds = React.useMemo(
    () => machines.map((machine) => machine.id),
    [machines],
  );
  const profilesGeneration = useServerProfilesGeneration();
  const projectionReaders = React.useMemo(() => {
    const resolveScopeId = captureServerProfileScopeResolver();
    return machineIds.map(machineId => captureDaemonMergedProjectionReader({ machineId, serverId }, resolveScopeId));
  }, [machineIds, profilesGeneration, serverId]);
  const installed = useMachineAgentsByMachine({
    serverId: scope?.serverId ?? '',
    machineIds,
    load: false,
  });
  const presence = useMachinePresenceSummaries(scope?.serverId, machineIds);
  // Reach shows the Account's machines together (map, legend, Where it's on), so same-name machines
  // carry the suffix every machine list uses to tell them apart.
  const nameHints = React.useMemo(() => resolveMachineDisplayNameParts(machines), [machines]);
  const declarationsRef = React.useRef<readonly DaemonMergedProjectionSummary[]>([]);
  const readDeclarations = React.useCallback(() => {
    const next = projectionReaders.map(reader => reader.readSummary());
    const previous = declarationsRef.current;
    if (previous.length === next.length && next.every((row, index) => row === previous[index])) return previous;
    declarationsRef.current = next;
    return next;
  }, [projectionReaders]);
  const subscribeDeclarations = React.useCallback((listener: () => void) => {
    const disposers = projectionReaders.map(reader => reader.subscribeSummary(listener));
    return () => { for (const dispose of disposers) dispose(); };
  }, [projectionReaders]);
  const declarations = React.useSyncExternalStore(subscribeDeclarations, readDeclarations, readDeclarations);
  const readAcp = React.useCallback(() => getAcpCatalogSnapshot(scope), [scope]);
  const acp = React.useSyncExternalStore(subscribeAcpCatalogSnapshots, readAcp, readAcp);
  const definitionIds = React.useMemo(() => acp?.data?.definitions.map(definition => definition.id), [acp?.data]);
  const reach = React.useMemo(
    () =>
      machines.map((machine, index): ReachMachine => {
        const inventory = readInstalledMachineAgentInventory(machine.metadata?.agentInventory, installed.get(machine.id), definitionIds);
        return {
          machineId: machine.id,
          platform:
            machine.metadata?.platform === 'win32'
              ? 'win32'
              : machine.metadata?.platform
                ? 'posix'
                : null,
          os: machine.metadata?.platform ?? null,
          arch: machine.metadata?.arch ?? null,
          agentIds: inventory.agentIds,
          agentInventoryComplete: inventory.complete,
          agentDeclarationsById: declarations[index]?.inputs?.agentDeclarationsById ?? null,
          name: withMachineNameHint(presence[index]?.name ?? null, nameHints.get(machine.id)?.hint ?? null),
          online: presence[index]?.reachability === 'reachable' ? true
            : presence[index]?.reachability === 'unreachable' ? false : null,
          offline: presence[index]?.reachability === 'unreachable',
          lastSeenAt: presence[index]?.lastSeenAt ?? null,
        };
      }),
    [machines, installed, presence, declarations, definitionIds, nameHints],
  );
  return React.useMemo(() => ({ scope, machines: reach }), [scope, reach]);
}

function withMachineNameHint(name: string | null, hint: string | null): string | null {
  return name && hint ? formatMachineDisplayNameParts({ name, hint }) : name;
}

/** One item's reach on each Account machine, through P2's projection. */
export function projectReachOnMachines(
  rules: ReachRulesV1,
  machines: readonly ReachMachine[],
  projectKey?: string,
  workspaceRefs: readonly WorkspaceRefV1[] = [],
  skill?: Parameters<typeof projectReachForMachinesV1>[1]['skill'],
): readonly ReachMachineProjection[] {
  const projected: ReachMachineProjection[] = projectReachForMachinesV1(rules, { projectKey, machines, skill }).map(
    (row, index) => ({ ...row, online: machines[index]?.online ?? null, offline: machines[index]?.offline ?? false,
      agentInventoryComplete: machines[index]?.agentInventoryComplete }),
  );
  if (projectKey) return projected;
  const projectKeys = new Set(rules.flatMap(rule => rule.target.t === 'project' ? [rule.target.projectKey] : []));
  for (const key of projectKeys) {
    const machineIds = new Set(workspaceRefs.filter(ref => (ref.projectKey ?? ref.id) === key).map(ref => ref.machineId));
    const members = machines.filter(machine => machineIds.has(machine.machineId));
    projected.push(...projectReachForMachinesV1(rules, { projectKey: key, machines: members, skill })
      .map((row, index) => ({ ...row, projectKey: key, online: members[index]?.online ?? null, offline: members[index]?.offline ?? false,
        agentInventoryComplete: members[index]?.agentInventoryComplete })));
  }
  return projected;
}

/** Passive Machine facts: offline machines retain their installed-Agent observations. */
export function useReachProjection(
  kind: 'skill' | 'mcp_server',
  itemId: string,
  opts?: Readonly<{ projectKey?: string }>,
): readonly ReachMachineProjection[] {
  const catalog = useReachRulesCatalog(kind, itemId);
  const { scope, machines } = useReachMachines();
  const isFeatureEnabled = useSkillFeatureEnabled(kind === 'skill' ? scope?.serverId : null);
  const { workspaceRefs } = useReachProjects(scope?.serverId);
  return React.useMemo(
    () =>
      !scope || !catalog.valueAvailable
        ? empty
        : projectReachOnMachines(catalog.rules, machines, opts?.projectKey, workspaceRefs,
          kind === 'skill' ? { skillId: itemId, isFeatureEnabled } : undefined),
    [scope, catalog.valueAvailable, catalog.rules, opts?.projectKey, machines, workspaceRefs, kind, itemId, isFeatureEnabled],
  );
}
