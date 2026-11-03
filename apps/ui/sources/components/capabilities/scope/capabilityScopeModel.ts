import type { ReachPlaceV1 } from '@happier-dev/protocol/reach/reachPlaceV1';
import type {
  ReachRuleV1,
  ReachRulesV1,
} from '@happier-dev/protocol/reach/reachRuleV1';
import {
  MIGRATED_STACK_RULE_ID_PREFIX_V1,
  type ReachRulesChangeV1,
} from '@happier-dev/protocol/reach/reachRulesChangeV1';
import {
  resolveReachV1,
  type ReachContextV1,
  type ReachDecisionV1,
} from '@happier-dev/protocol/reach/resolveReachV1';

import { t } from '@/text';
import { joinList } from '@/utils/text/joinList';
import type { WhereItsOnNames } from '@/components/capabilities/where/whereItsOnPresentation';

/**
 * The model behind the "Skills and MCP servers" section a machine page and a project page share: what one
 * switch reads, what it writes, and the words under it. Rule precedence stays P2's `resolveReachV1`; this file
 * only asks it the question for the page's place and turns the answer into one switch.
 */

/** The place a section sets rules for: the machine page's machine, or the Project's Account place. */
export type ScopePlace =
  | Readonly<{ t: 'machine'; machineId: string }>
  | Readonly<{ t: 'project'; projectKey: string }>;

/** A machine the place covers: itself on a machine page, each checkout's machine on a project page. */
export type ScopeMachine = Readonly<{
  machineId: string;
  platform: 'win32' | 'posix' | null;
  agentIds: readonly string[];
}>;

/**
 * The covered machines that need their own "not answering" note. A page that already announces its
 * checkout's machine (Project pages) says that cause once, so the section only names the others.
 */
export function machinesNeedingOfflineNote<T extends Readonly<{ machineId: string; offline?: boolean }>>(
  covered: readonly T[],
  announcedMachineId: string | null,
): T[] {
  return covered.filter((machine) => machine.offline && machine.machineId !== announcedMachineId);
}

type Cell = Readonly<
  { machineId: string; agentId: string | null } & ReachDecisionV1
>;

export type ScopeRead = Readonly<{
  /** The agent-general state at every machine the place covers; one machine off reads Off. */
  on: boolean;
  /** Agent-general decisions, one per covered machine (a project with no checkout has one without a machine). */
  general: readonly Cell[];
  /** Per installed Agent and machine, so the words can name the ones that differ. */
  agents: readonly Cell[];
  /** A rule here (agent-general or Agent-qualified) already exists at the place itself. */
  hasRuleHere: boolean;
}>;

const NO_MACHINE: ScopeMachine = {
  machineId: '',
  platform: null,
  agentIds: [],
};

function contexts(
  place: ScopePlace,
  machines: readonly ScopeMachine[],
): readonly ScopeMachine[] {
  if (place.t === 'machine')
    return machines.filter((machine) => machine.machineId === place.machineId);
  return machines.length > 0 ? machines : [NO_MACHINE];
}

function contextFor(
  place: ScopePlace,
  machine: ScopeMachine,
  agentId: string | null,
): ReachContextV1 {
  return {
    machineId: machine.machineId,
    machinePlatform: machine.platform,
    directory: null,
    projectKey: place.t === 'project' ? place.projectKey : null,
    agentId,
  };
}

function isHere(target: ReachPlaceV1, place: ScopePlace): boolean {
  return place.t === 'machine'
    ? target.t === 'machine' && target.machineId === place.machineId
    : target.t === 'project' && target.projectKey === place.projectKey;
}

export function readScope(
  rules: ReachRulesV1,
  place: ScopePlace,
  machines: readonly ScopeMachine[],
  resolve: typeof resolveReachV1 = resolveReachV1,
): ScopeRead {
  const covered = contexts(place, machines);
  const general = covered.map((machine): Cell => ({
    machineId: machine.machineId,
    agentId: null,
    ...resolve(rules, contextFor(place, machine, null)),
  }));
  const agents = covered.flatMap((machine) =>
    machine.agentIds.map((agentId): Cell => ({
      machineId: machine.machineId,
      agentId,
      ...resolve(rules, contextFor(place, machine, agentId)),
    })),
  );
  return {
    on: general.length > 0 && general.every((cell) => cell.enabled),
    general,
    agents,
    hasRuleHere: rules.some((rule) => isHere(rule.target, place)),
  };
}

/**
 * The write a flip requests: only the agent-general rule at the place, so an Agent exception keeps holding.
 * The place's rule is dropped (`inherit`) only when the broader rules already give the requested state on every
 * machine the place covers; otherwise it stays explicit, so a project switch never leans on one machine's answer.
 */
export function scopeWrite(
  rules: ReachRulesV1,
  place: ScopePlace,
  machines: readonly ScopeMachine[],
  requestedOn: boolean,
  resolve: typeof resolveReachV1 = resolveReachV1,
): ReachRulesChangeV1 {
  const broader = rules.filter(
    (rule) => !(rule.agentId === undefined && isHere(rule.target, place)),
  );
  const inherit = contexts(place, machines).every(
    (machine) =>
      resolve(broader, contextFor(place, machine, null)).enabled ===
      requestedOn,
  );
  return {
    kind: 'write',
    write: { place, state: inherit ? 'inherit' : requestedOn ? 'on' : 'off' },
  };
}

/** The words under the switch: where a uniform decision comes from, else who gets it and who does not. */
export function describeScope(read: ScopeRead, place: ScopePlace, names: WhereItsOnNames): string {
  const machineIds = [...new Set(read.general.map((cell) => cell.machineId))];
  const machinesDiffer =
    new Set(read.general.map((cell) => cell.enabled)).size > 1;
  if (machinesDiffer) {
    const named = (enabled: boolean) =>
      joinList(
        machineIds
          .filter(
            (id) =>
              read.general.find((cell) => cell.machineId === id)?.enabled ===
              enabled,
          )
          .map(names.machineName),
      );
    return `${t('capabilities.scopeSection.onOn', { machines: named(true) })} · ${t('capabilities.scopeSection.notOn', { machines: named(false) })}`;
  }
  const agentIds = [
    ...new Set(read.agents.map((cell) => cell.agentId ?? '')),
  ].filter(Boolean);
  const gets = (agentId: string) =>
    read.agents
      .filter((cell) => cell.agentId === agentId)
      .every((cell) => cell.enabled);
  const getting = agentIds.filter(gets);
  const missing = agentIds.filter((agentId) => !gets(agentId));
  if (getting.length > 0 && missing.length > 0) {
    return `${t('capabilities.scopeSection.onFor', { agents: joinList(names.agentNames(getting)) })} · ${t('capabilities.scopeSection.notFor', { agents: joinList(names.agentNames(missing)) })}`;
  }
  const decided = read.general[0]?.decidedBy ?? null;
  if (decided === null) return t('capabilities.where.off');
  const enabled = read.general[0]!.enabled;
  if (decided.target === 'allMachines')
    return enabled
      ? t('capabilities.where.everywhere')
      : t('capabilities.where.off');
  if (decided.target === 'project' && place.t === 'project') {
    return t(enabled ? 'capabilities.scopeSection.onIn' : 'capabilities.scopeSection.offIn', { place: names.projectName(place.projectKey) });
  }
  return t(
    enabled
      ? 'capabilities.scopeSection.onForPlace'
      : 'capabilities.scopeSection.offForPlace',
    { place: names.machineName(read.general[0]!.machineId) },
  );
}

/** At most this many rows a sheet shows; "All n" opens the rest. */
export const SCOPE_ROW_LIMIT = 4;

export type ScopeRowKey = Readonly<{
  id: string;
  name: string;
  hasRuleHere: boolean;
  problem: boolean;
}>;

/** Rules set here first, then problems and masks, then by name. */
export function orderScopeRows<T extends ScopeRowKey>(rows: readonly T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      Number(b.hasRuleHere) - Number(a.hasRuleHere) ||
      Number(b.problem) - Number(a.problem) ||
      a.name.localeCompare(b.name),
  );
}

/** Items that still carry a rule migrated for this Project (P2's id prefix; no stored flag). */
export function migratedProjectRuleItems<
  T extends Readonly<{ rules: readonly Pick<ReachRuleV1, 'id'>[] }>,
>(items: readonly T[], projectKey: string): T[] {
  const prefix = `${MIGRATED_STACK_RULE_ID_PREFIX_V1}project:${projectKey}:`;
  return items.filter((item) =>
    item.rules.some((rule) => rule.id.startsWith(prefix)),
  );
}
