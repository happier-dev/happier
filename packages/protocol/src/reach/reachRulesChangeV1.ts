import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import type { ActionExecutorContext } from '../actions/actionExecutor.js';
import { isAgentOrUnresolvedSurface } from '../actions/actionApprovalSurface.js';
import { isWorkspacePathWithinRootV1 } from '../workspaces/workspaceRefResolutionV1.js';
import { ReachPlaceV1Schema, reachPlaceKeyV1 } from './reachPlaceV1.js';
import { ReachRuleDraftV1Schema, type ReachRuleV1, type ReachRulesV1, type ReachRuleDraftV1 } from './reachRuleV1.js';
import { compareReachRulesV1, resolveReachV1, type ReachContextV1 } from './resolveReachV1.js';

export const ReachRuleWriteV1Schema = lazyZodSchema(() => z.strictObject({ place: ReachPlaceV1Schema, agentId: z.optional(z.string().check(z.minLength(1))), state: z.enum(['on', 'off', 'inherit']) }));
export type ReachRuleWriteV1 = Readonly<z.infer<typeof ReachRuleWriteV1Schema>>;
export const ReachRulesChangeV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('write'), write: ReachRuleWriteV1Schema }),
  z.strictObject({ kind: z.literal('replace'), rules: z.array(ReachRuleDraftV1Schema) }),
]));
export type ReachRulesChangeV1 = Readonly<{ kind: 'write'; write: ReachRuleWriteV1 }> | Readonly<{ kind: 'replace'; rules: readonly ReachRuleDraftV1[] }>;
/** New MCP servers and present-user Skills start Everywhere through this one default. */
export const DEFAULT_CREATE_REACH_CHANGE_V1 = { kind: 'write', write: { place: { t: 'allMachines' }, state: 'on' } } as const satisfies ReachRulesChangeV1;
export type ReachRulesWriteContextV1 = Readonly<{ nowMs: number; newId: () => string }>;
export const MIGRATED_STACK_RULE_ID_PREFIX_V1 = 'migrated-stack:';
export function isMigratedReachRuleIdV1(id: string): boolean { return id.startsWith(MIGRATED_STACK_RULE_ID_PREFIX_V1); }
export function reachRuleKeyV1(rule: Readonly<{ target: ReachRuleV1['target']; agentId?: string }>): string {
  return JSON.stringify([reachPlaceKeyV1(rule.target), rule.agentId ?? null]);
}

/** Returned rule metadata is a read projection; authored replacement carries only intent. */
export function reachRulesToDraftsV1(rules: ReachRulesV1): ReachRuleDraftV1[] {
  return rules.map(rule => ({ target: rule.target, enabled: rule.enabled, ...(rule.agentId !== undefined ? { agentId: rule.agentId } : {}) }));
}

/** Old stored duplicates retain the same winner as the precedence owner. */
export function normalizeReachRulesV1<T extends ReachRuleV1>(rules: readonly T[]): T[] {
  const winners = new Map<string, T>();
  for (const rule of rules) {
    const key = reachRuleKeyV1(rule);
    const previous = winners.get(key);
    if (!previous || compareReachRulesV1(rule, previous) > 0) winners.set(key, rule);
  }
  return [...winners.values()];
}

export function applyReachRulesChangeV1(rules: ReachRulesV1, change: ReachRulesChangeV1, ctx: ReachRulesWriteContextV1): ReachRuleV1[] {
  rules = normalizeReachRulesV1(rules);
  const drafts = change.kind === 'replace' ? change.rules : [
    ...rules.filter(rule => reachRuleKeyV1(rule) !== reachRuleKeyV1({ target: change.write.place, agentId: change.write.agentId })),
    ...(change.write.state === 'inherit' ? [] : [{ target: change.write.place, ...(change.write.agentId !== undefined ? { agentId: change.write.agentId } : {}), enabled: change.write.state === 'on' }]),
  ];
  const seen = new Set<string>();
  return drafts.map(draft => {
    const key = reachRuleKeyV1(draft);
    if (seen.has(key)) throw new Error('Duplicate reach rule');
    seen.add(key);
    const previous = rules.find(rule => reachRuleKeyV1(rule) === key);
    if (previous?.enabled === draft.enabled) return previous;
    // Native evidence uses this edit stamp; same-clock edits must not reuse it.
    return { ...draft, id: previous?.id ?? ctx.newId(), createdAt: previous?.createdAt ?? ctx.nowMs,
      updatedAt: Math.max(ctx.nowMs, (previous?.updatedAt ?? -1) + 1) };
  });
}

export function resolveCreateReachV1(input: Readonly<{ kind: 'skill' | 'mcp_server';
  caller: Readonly<{ surface: ActionExecutorContext['surface'] | null; sessionId?: string;
    approvedActionReplay?: ActionExecutorContext['approvedActionReplay'] }>;
  requested?: ReachRulesChangeV1; ctx: ReachRulesWriteContextV1 }>):
  Readonly<{ ok: true; rules: ReachRuleV1[]; includeInSessionId: string | null }> | Readonly<{ ok: false; code: 'where_needs_rules_action' }> {
  if (input.kind === 'skill') {
    // Approval changes who may execute, not who originated an omitted default.
    // An explicit human-approved where remains the deciding intent.
    const origin = input.caller.approvedActionReplay?.origin;
    if (input.requested) {
      if (isAgentOrUnresolvedSurface(input.caller)) return { ok: false, code: 'where_needs_rules_action' };
    } else if (origin ? origin.caller.kind === 'session' || isAgentOrUnresolvedSurface(origin) : isAgentOrUnresolvedSurface(input.caller)) {
      return { ok: true, rules: [], includeInSessionId: origin
        ? origin.caller.kind === 'session' ? origin.caller.sessionId : origin.sessionId ?? null
        : input.caller.sessionId ?? null };
    }
  }
  return { ok: true, rules: applyReachRulesChangeV1([], input.requested ?? DEFAULT_CREATE_REACH_CHANGE_V1, input.ctx), includeInSessionId: null };
}

function intersectionContext(left: ReachRuleV1, right: ReachRuleV1, platform: ReachContextV1['machinePlatform']): ReachContextV1 | null {
  const machine = (rule: ReachRuleV1) => rule.target.t === 'machine' || rule.target.t === 'workspace' ? rule.target.machineId : null;
  const project = (rule: ReachRuleV1) => rule.target.t === 'project' ? rule.target.projectKey : null;
  const leftMachine = machine(left), rightMachine = machine(right);
  const leftProject = project(left), rightProject = project(right);
  if (leftMachine && rightMachine && leftMachine !== rightMachine || leftProject && rightProject && leftProject !== rightProject) return null;
  let directory: string | null = null;
  if (left.target.t === 'workspace') directory = left.target.workspaceRoot;
  if (right.target.t === 'workspace') {
    const rightRoot = right.target.workspaceRoot;
    if (directory && !isWorkspacePathWithinRootV1(directory, rightRoot, platform)) {
      if (!isWorkspacePathWithinRootV1(rightRoot, directory, platform)) return null;
      directory = rightRoot;
    } else directory ??= rightRoot;
  }
  return { machineId: leftMachine ?? rightMachine ?? '', projectKey: leftProject ?? rightProject,
    directory, machinePlatform: platform, agentId: left.agentId ?? null };
}

export function groupReachRulesV1(rules: ReachRulesV1): Readonly<{ base: 'on' | 'off' | 'none'; turnedOnIn: ReachRuleV1[]; except: ReachRuleV1[];
  agents: readonly Readonly<{ agentId: string; everywhere: 'on' | 'off' | null; turnedOnIn: ReachRuleV1[]; except: ReachRuleV1[] }>[] }> {
  const normalized = normalizeReachRulesV1(rules);
  const base = normalized.find(rule => rule.target.t === 'allMachines' && rule.agentId === undefined);
  // Reach predicates contain only a machine, a project, or a machine/root pair.
  // Pairwise place intersections witness every possible broader decision at a
  // rule's place, including restoring project/workspace rules and Agent exceptions.
  let effective = [...normalized];
  for (const rule of normalized) {
    if (rule === base) continue;
    const without = effective.filter(candidate => candidate !== rule);
    const changesDecision = effective.some(candidate => {
      if (candidate.agentId !== undefined && candidate.agentId !== rule.agentId) return false;
      return ([null, 'win32', 'posix'] as const).some(platform => {
        const context = intersectionContext(rule, candidate, platform);
        return context !== null && resolveReachV1(effective, context).enabled !== resolveReachV1(without, context).enabled;
      });
    });
    // Two rules may each restore the same decision. Test removal against the
    // remaining chain so their individual redundancy cannot discard both.
    if (!changesDecision) effective = without;
  }
  const group = (items: readonly ReachRuleV1[]) => ({ turnedOnIn: items.filter(rule => rule.target.t !== 'allMachines' && rule.enabled),
    except: items.filter(rule => rule.target.t !== 'allMachines' && !rule.enabled) });
  const general = group(effective.filter(rule => rule.agentId === undefined));
  const agents = [...new Set(effective.flatMap(rule => rule.agentId === undefined ? [] : [rule.agentId]))].sort().map(agentId => {
    const items = effective.filter(rule => rule.agentId === agentId);
    const everywhere = items.find(rule => rule.target.t === 'allMachines');
    return { agentId, everywhere: everywhere ? everywhere.enabled ? 'on' as const : 'off' as const : null, ...group(items) };
  });
  return { base: base ? base.enabled ? 'on' : 'off' : 'none', ...general, agents };
}
