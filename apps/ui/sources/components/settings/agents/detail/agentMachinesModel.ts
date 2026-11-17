import { getMachineSentenceName, isMachineDisplayNamePending, resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { formatOSPlatform } from '@/utils/sessions/sessionUtils';
import type { MachineAdministrationTargetPickerRowV1 } from '@/sync/domains/machines/administration/useTargetSelection';
import type { MachineAgent } from '@/agents/machineAgents/machineAgentTypes';
import type { MachineAgentsSnapshot } from '@/agents/machineAgents/machineAgentInventoryStore';
import {
  resolveMachineAgentRowAction,
  resolveMachineAgentStatus,
  type MachineAgentRowAction,
  type MachineAgentStatus,
} from '@/components/machines/agents/machineAgentPresentation';

/** One of the Account's machines, as the agent page lists it (REACH decides `online`). */
export type AgentMachinesMachine = Readonly<{
  machineId: string;
  serverId: string;
  /** The machine's title; a placeholder while its name loads. */
  name: string;
  /** The machine inside a sentence ("Sign in on …"): never the title's placeholder. */
  sentenceName: string;
  /** The name is still loading: `name` is a placeholder title. */
  namePending: boolean;
  /** "macOS", "Linux": a quiet qualifier after the name. */
  os: string | null;
  online: boolean;
  /** When an offline machine was last seen, for its dated last-known line. */
  lastSeenAt: number | null;
}>;

/** The Account's live machines of one Home, named as the machine pickers name them. */
export function listAgentMachines(
  pickerRows: readonly MachineAdministrationTargetPickerRowV1[],
): AgentMachinesMachine[] {
  const names = resolveMachineDisplayNames(pickerRows.map((row) => row.machine));
  return pickerRows.map((row) => {
    const name = names.get(row.machine.id) ?? row.candidate.displayName;
    return {
      machineId: row.machine.id,
      serverId: row.serverId,
      name,
      sentenceName: getMachineSentenceName(row.machine, name),
      namePending: isMachineDisplayNamePending(row.machine),
      os: formatOSPlatform(row.machine.metadata?.platform ?? undefined) || null,
      online: row.candidate.availability === 'online',
      lastSeenAt: row.candidate.observedAt,
    };
  });
}

/** What a machine row offers: the one action the agent's presentation owner picks, and Remove. */
export type AgentMachineAction =
  | MachineAgentRowAction
  /** The machine is online but its agent check failed: ask that machine again (the inventory owner's forced refresh). */
  | Readonly<{ kind: 'checkAgain' }>;

export type AgentMachineRow = Readonly<{
  machine: AgentMachinesMachine;
  /** The inventory's Agent descriptor, or null when none has been supplied. */
  agent: MachineAgent | null;
  status: MachineAgentStatus;
  version: string | null;
  /** Primary first; empty when there is nothing to do there (healthy, offline, can't run). */
  actions: readonly AgentMachineAction[];
  /** Installed by the person, not Happier: Happier never removes it. */
  installedOutsideHappier: boolean;
  /** Expanding the row shows that machine's setup rows (CLI source, sign-in). */
  expandable: boolean;
}>;

function isJobRunning(agent: MachineAgent): boolean {
  return agent.job !== null && agent.job.outcome === null;
}

function canRun(agent: MachineAgent | null): boolean {
  if (!agent) return true;
  if (agent.fit?.kind === 'cant_run') return false;
  return agent.platform.supported && agent.state !== 'unsupported';
}

/** Where it is installed first, then where it could be; machines that can't run it, then offline ones (known before unknown), last. */
/** Both kinds read "Couldn't check this machine". */
function saysCouldNotCheck(row: AgentMachineRow): boolean {
  return row.status.kind === 'unknown' || row.status.kind === 'unavailable';
}

function sortRank(row: AgentMachineRow): number {
  if (!row.machine.online) return row.agent ? 3 : 5;
  if (saysCouldNotCheck(row)) return 4;
  if (!canRun(row.agent)) return 2;
  return row.agent?.installed ? 0 : 1;
}

/**
 * "On your machines" (P9 F9): every machine of the Account at once, each with the agent's version, one
 * status and its actions. Status words and the primary action come from the machine-agent presentation
 * owner; this adds only what the agent page knows: the pinned registry version (an install that differs
 * reads "Update to <pinned>") and Remove for Happier-managed installs.
 */
export function buildAgentMachineRows(
  input: Readonly<{
    machines: readonly AgentMachinesMachine[];
    /** The agent on each machine, keyed by machine id. */
    agentsByMachineId: ReadonlyMap<string, MachineAgent | null>;
    inventoryStatusByMachineId: ReadonlyMap<string, MachineAgentsSnapshot['status']>;
    /** A registry definition's chosen version; null for agents Happier ships. */
    pinnedVersion: string | null;
  }>,
): AgentMachineRow[] {
  const rows = input.machines.map((machine): AgentMachineRow => {
    const agent = input.agentsByMachineId.get(machine.machineId) ?? null;
    const inventoryStatus = input.inventoryStatusByMachineId.get(machine.machineId) ?? 'loading';
    if (!agent) {
      return {
        machine,
        agent: null,
        status: machine.online && inventoryStatus !== 'offline'
          ? resolveMachineAgentStatus(null, undefined, inventoryStatus)
          : { kind: 'offline', tone: 'quiet', lastKnown: 'unknown' },
        version: null,
        actions: machine.online && inventoryStatus === 'error' ? [{ kind: 'checkAgain' }] : [],
        installedOutsideHappier: false,
        expandable: false,
      };
    }
    const live = !agent.stale && machine.online;
    const running = isJobRunning(agent);
    const baseStatus = resolveMachineAgentStatus(agent, undefined, inventoryStatus);
    // A registry agent installed at another version than the one chosen updates to the chosen one.
    const pinnedUpdate =
      live &&
      !running &&
      agent.installed &&
      input.pinnedVersion !== null &&
      agent.version !== null &&
      agent.version !== input.pinnedVersion
        ? input.pinnedVersion
        : null;
    const status: MachineAgentStatus =
      pinnedUpdate && baseStatus.kind === 'ready'
        ? { ...baseStatus, updateTo: pinnedUpdate }
        : baseStatus;
    const primary = live ? resolveMachineAgentRowAction(agent) : null;
    const actions: AgentMachineAction[] = [];
    // Asking again waits for the answer already on its way: a machine being checked offers no retry.
    if (machine.online && inventoryStatus !== 'loading' && (inventoryStatus === 'error' || (agent.stale && agent.staleReason === 'error')))
      actions.push({ kind: 'checkAgain' });
    if (pinnedUpdate && (primary === null || primary.kind === 'update'))
      actions.push({ kind: 'update' });
    else if (primary) actions.push(primary);
    if (live && !running && agent.installed && agent.managed === true)
      actions.push({ kind: 'remove' });
    return {
      machine,
      agent,
      status,
      version: agent.installed ? agent.version : null,
      actions,
      installedOutsideHappier: agent.installed && agent.managed === false,
      expandable: live && canRun(agent),
    };
  });
  // While an online machine's check is still on its way, the order is the machines' own (online before offline):
  // ranking by answers that are still arriving would reshuffle the list under the person's eyes.
  const settled = input.machines.every((machine) => {
    if (!machine.online) return true;
    const status = input.inventoryStatusByMachineId.get(machine.machineId) ?? 'loading';
    return status !== 'loading' && status !== 'idle';
  });
  const rank = settled ? sortRank : (row: AgentMachineRow) => (row.machine.online ? 0 : 1);
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index)
    .map(({ row }) => row);
}

/**
 * How many reachable rows the list opens with (offline machines wait behind the section's own offline row). Machines
 * that did not answer wait behind "N more", since their words would only repeat down the list. At least one row shows.
 */
export function countAgentMachineRowsToShow(rows: readonly AgentMachineRow[]): number {
  const withNews = rows.filter((row) => row.machine.online && !saysCouldNotCheck(row)).length;
  return rows.length === 0 ? 0 : Math.max(1, withNews);
}
