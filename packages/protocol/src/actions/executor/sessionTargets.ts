import { ActionSessionAddressV1Schema, normalizeSessionTargetV1, type ActionSessionAddressV1, type ActionSessionTargetDeclarationV1, type SessionTargetV1, type SessionTargetSelectorV1, type ActionResolvedSessionTargetsV1, type SessionTargetPreviewV1 } from '../sessionTargetV1.js';
import { FollowRulePreviewResultV1Schema } from '../../sessions/follow/sessionFollowRulePreviewV1.js';
import { parseSessionFollowActionResponse } from '../../sessions/follow/actionTransport.js';
import { OpenedSessionFollowRuleV1Schema, type OpenedSessionFollowRuleV1 } from '../../sessions/follow/actions.js';
import { DiscussionParticipantsListResponseV1Schema } from '../../discussions/participants.js';
import type { ActionId } from '../actionIds.js';
import type { ActionExecuteFailure } from '../actionExecutionResult.js';
import type { ActionExecutorContext, ActionExecutorDeps, ActionSessionAddress, ActionSessionReferenceResolution } from './types.js';
import { readActionCallerLedSubtreeSessions } from './sessionLedSubtree.js';
import { readSessionManagerSessionIdV1 } from '../../sessions/follow/sessionManagerV1.js';

function id(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** The incumbent qualified-address owner; natural-reference adapters only supply authorized facts. */
export async function resolveActionSessionAddress(
  deps: ActionExecutorDeps,
  input: Readonly<{ sessionId?: unknown; sessionTitle?: unknown }>,
  context: ActionExecutorContext,
  actionId?: ActionId,
  resolveReference = false,
): Promise<ActionSessionReferenceResolution> {
  const sessionId = id(input.sessionId);
  const sessionTitle = id(input.sessionTitle);
  const serverId = id(context.serverId);
  if (sessionId && serverId && !resolveReference) return { kind: 'unique', address: { serverId, sessionId } };
  if (!sessionId && !sessionTitle) return { kind: 'none' };
  if (resolveReference && context.sessionListAccess === 'current_session' && sessionId
    && sessionId !== id(context.defaultSessionId)) {
    const root = await resolveActionSessionAddress(deps, { sessionId: context.defaultSessionId }, context, actionId, true);
    if (root.kind !== 'unique') return root;
    const sessions = await readActionCallerLedSubtreeSessions(deps, { ...context, serverId: root.address.serverId });
    if (!sessions) return { kind: 'incomplete' };
    return sessions.has(sessionId) ? { kind: 'unique', address: { serverId: root.address.serverId, sessionId } } : { kind: 'none' };
  }
  if (!deps.resolveSessionReference) return { kind: 'incomplete' };
  return deps.resolveSessionReference({ context, ...(sessionId ? { sessionId } : {}),
    ...(sessionTitle ? { sessionTitle } : {}), ...(actionId ? { actionId } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
  });
}

function unavailable(cause: string): ActionExecuteFailure {
  return { ok: false, errorCode: 'session_target_unavailable', error: 'session_target_unavailable', details: { cause } };
}

async function workers(
  deps: ActionExecutorDeps, base: ActionSessionAddress, target: Extract<SessionTargetSelectorV1, { selector: 'workers' }>, context: ActionExecutorContext,
): Promise<readonly ActionSessionAddress[] | ActionExecuteFailure> {
  const sessions = await readActionCallerLedSubtreeSessions(deps, { ...context, serverId: base.serverId }, base.sessionId);
  if (context.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
  if (!sessions) return unavailable('incomplete_session_corpus');
  const targets: ActionSessionAddress[] = [];
  for (const row of sessions.values()) {
    // Summary rows preserve the canonical manager projection. Awareness rows
    // cannot prove direct membership and are not a substitute for that read.
    if (!('id' in row) || typeof row.id !== 'string') return unavailable('manager_projection_unavailable');
    if (row.id === base.sessionId) continue;
    if (target.recursive !== true) {
      if (!('manager' in row)) return unavailable('manager_projection_unavailable');
      const manager = row.manager;
      if (!manager || typeof manager !== 'object' || !('sessionId' in manager) || manager.sessionId !== base.sessionId) continue;
    }
    targets.push({ serverId: base.serverId, sessionId: row.id });
  }
  return targets;
}

async function matching(
  deps: ActionExecutorDeps,
  target: Extract<SessionTargetSelectorV1, { selector: 'matching' }>,
  context: ActionExecutorContext,
  base: ActionSessionAddress | null,
  sourceSessionId?: string,
): Promise<readonly ActionSessionAddress[] | ActionExecuteFailure> {
  // Session operands never turn Runs into Session targets.
  if (target.filter.show === 'runs') return [];
  if (!deps.sessionFollowPreview) return unavailable('selector_backing_unavailable');
  // This host port reads the authorized corpus to completion and uses the
  // shared tri-state filter. Its visible preview page is never a target set.
  const preview = FollowRulePreviewResultV1Schema.safeParse(await deps.sessionFollowPreview({
    context, input: { receiver: base ? { kind: 'session', sessionId: base.sessionId } : { kind: 'account' },
      filter: { ...target.filter, show: 'sessions' } },
    ...(sourceSessionId ? { sourceSessionId } : {}),
    ...(base ? { serverId: base.serverId } : context.serverId ? { serverId: context.serverId } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
  }));
  if (!preview.success || preview.data.coverage !== 'complete' || preview.data.continuation
    || preview.data.unavailable.length || preview.data.matchCount !== preview.data.matches.length) {
    return unavailable('incomplete_session_corpus');
  }
  const selected: ActionSessionAddress[] = [];
  const seen = new Set<string>();
  for (const match of preview.data.matches) {
    if (match.source.kind !== 'session') return unavailable('non_session_filter_match');
    const address = { serverId: match.serverId, sessionId: match.source.sessionId };
    const key = JSON.stringify([address.serverId, address.sessionId]);
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(address);
  }
  return selected;
}

async function follows(
  deps: ActionExecutorDeps, base: ActionSessionAddress, direction: 'followers' | 'following', context: ActionExecutorContext, actionId: ActionId,
): Promise<readonly ActionSessionAddress[] | ActionExecuteFailure> {
  if (!deps.sessionFollowAction) return unavailable('selector_backing_unavailable');
  const scopedContext = { ...context, serverId: base.serverId };
  const input = direction === 'followers'
    ? { direction, source: { kind: 'session' as const, sessionId: base.sessionId } }
    : { direction, receiver: { kind: 'session' as const, sessionId: base.sessionId } };
  const selected: ActionSessionAddress[] = [];
  const listedRules = new Map<string, OpenedSessionFollowRuleV1>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    if (context.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    const pageInput = { ...input, ...(cursor ? { cursor } : {}) };
    const page = parseSessionFollowActionResponse('follow.list', pageInput, await deps.sessionFollowAction({
      actionId: 'follow.list', input: pageInput, serverId: base.serverId, context: scopedContext,
      ...(context.signal ? { signal: context.signal } : {}),
    }));
    if (page.coverage === 'unavailable') return unavailable('incomplete_follow_corpus');
    for (const row of page.sources) {
      // Discussion and Run follows keep their real identities; they are not
      // executable Session targets, even when they share this list owner.
      if ('sourceSessionId' in row) selected.push({ serverId: base.serverId,
        sessionId: direction === 'followers' ? row.destinationSessionId : row.sourceSessionId });
    }
    for (const rule of page.rules) listedRules.set(rule.ruleId, rule);
    if (!page.continuation) {
      if (page.coverage !== 'complete') return unavailable('incomplete_follow_corpus');
      break;
    }
    if (seenCursors.has(page.continuation)) return unavailable('incomplete_follow_corpus');
    seenCursors.add(page.continuation);
    cursor = page.continuation;
  }
  let rules = [...listedRules.values()];
  if (direction === 'followers') {
    // Private people are never operational recipients. Only this Account's
    // readable Session-receiver rules can add executable targets.
    if (!deps.readSessionFollowRules) return unavailable('follow_rule_reader_unavailable');
    const census = await deps.readSessionFollowRules({ serverId: base.serverId, context: scopedContext,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    if (census.kind !== 'complete') return unavailable('incomplete_follow_corpus');
    rules = census.rules.map(rule => OpenedSessionFollowRuleV1Schema.parse(rule));
  }
  for (const rule of rules) {
    if (!rule.definition.enabled || rule.receiver.kind !== 'session') continue;
    if (direction === 'followers' && rule.receiver.sessionId === base.sessionId) continue;
    const matches = await matching(deps, { selector: 'matching', filter: rule.definition.filter }, scopedContext,
      { serverId: base.serverId, sessionId: rule.receiver.sessionId }, direction === 'followers' ? base.sessionId : undefined);
    if ('ok' in matches) return matches;
    // Rule delivery excludes its receiver as a source, just as stored Follow
    // relations do. A raw filter preview can still match that same Session.
    const receiverSessionId = rule.receiver.sessionId;
    const sources = matches.filter(address => address.serverId !== base.serverId || address.sessionId !== receiverSessionId);
    if (direction === 'following') selected.push(...sources);
    else if (sources.some(address => address.serverId === base.serverId && address.sessionId === base.sessionId)) {
      const receiver = await resolveActionSessionAddress(deps, { sessionId: rule.receiver.sessionId }, scopedContext, actionId, true);
      if (receiver.kind !== 'unique' || receiver.address.serverId !== base.serverId
        || receiver.address.sessionId !== rule.receiver.sessionId) return unavailable('follow_receiver_unavailable');
      selected.push(receiver.address);
    }
  }
  return selected;
}

async function discussion(
  deps: ActionExecutorDeps, serverId: string, discussionId: string, context: ActionExecutorContext,
): Promise<readonly ActionSessionAddress[] | ActionExecuteFailure> {
  if (!deps.discussionAction) return unavailable('selector_backing_unavailable');
  const result = DiscussionParticipantsListResponseV1Schema.safeParse(await deps.discussionAction({
    actionId: 'discussion.participants.list', input: { discussionId }, context: { ...context, serverId },
    ...(context.signal ? { signal: context.signal } : {}),
  }));
  if (!result.success || result.data.discussionId !== discussionId) return unavailable('discussion_participants_unavailable');
  const selected: ActionSessionAddress[] = [];
  for (const row of result.data.participants) {
    if (row.participant.kind === 'session') selected.push({ serverId, sessionId: row.participant.sessionId });
    else if ('sessionId' in row && row.sessionId) {
      // An unbound model slot is a selection, not permission to create work.
      // The authorized roster's bound Session FK belongs to this read Home.
      // Saved launch placement carries the creator's local alias, not membership authority.
      selected.push({ serverId, sessionId: row.sessionId });
    }
  }
  return selected;
}

type SessionTargetsRequest = Readonly<{ actionId: ActionId; declaration: Readonly<{ field: string; cardinality: 'one' | 'many' }>; input: Readonly<Record<string, unknown>>; context: ActionExecutorContext }>;

/** The inspection Action and picker share this projection over the sole resolver. */
export async function previewActionSessionTargets(deps: ActionExecutorDeps, args: SessionTargetsRequest): Promise<SessionTargetPreviewV1> {
  const resolved = await resolveActionSessionTargets(deps, args);
  if (args.context.signal?.aborted) return { coverage: 'unavailable', addresses: [], error: 'cancelled' };
  if (resolved && 'ok' in resolved) {
    if (resolved.errorCode === 'session_target_empty') return { coverage: 'complete', addresses: [], error: null };
    const details = resolved.details;
    const cause = typeof details === 'object' && details !== null && 'cause' in details && typeof details.cause === 'string'
      ? details.cause : undefined;
    return { coverage: 'unavailable', addresses: [], error: resolved.errorCode, ...(cause ? { cause } : {}) };
  }
  if (resolved) return { coverage: 'complete', addresses: resolved.targets, error: null };
  // Exact IDs retain the final invocation's fast path, but inspection requires
  // the authorized reference reader before disclosing an address.
  const target = readActionSessionTargetField(args.input, args.declaration.field);
  if (typeof target === 'string') {
    try {
      const address = await resolveActionSessionAddress(deps, { sessionId: target }, args.context, args.actionId, true);
      if (args.context.signal?.aborted) return { coverage: 'unavailable', addresses: [], error: 'cancelled' };
      if (address.kind === 'unique') return { coverage: 'complete', addresses: [address.address], error: null };
      return { coverage: 'unavailable', addresses: [], error: 'session_target_unavailable',
        cause: address.kind === 'ambiguous' ? 'session_id_ambiguous' : 'session_context_unavailable' };
    } catch {
      return { coverage: 'unavailable', addresses: [], error: args.context.signal?.aborted ? 'cancelled' : 'session_target_unavailable',
        ...(args.context.signal?.aborted ? {} : { cause: 'target_read_failed' }) };
    }
  }
  return { coverage: 'unavailable', addresses: [], error: 'session_target_unavailable' };
}

/** Catalog-owned operand paths; values such as source and CAS identities never supply paths. */
export function readActionSessionTargetField(input: Readonly<Record<string, unknown>>, field: string): unknown {
  let value: unknown = input;
  for (const key of field.split('.')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = (value as Readonly<Record<string, unknown>>)[key];
  }
  return value;
}

/** Wildcards select only existing declared leaves; Account slots have no Session operand. */
export function readActionSessionTargetOperands(input: Readonly<Record<string, unknown>>, field: string): readonly Readonly<{ field: string; value: unknown }>[] {
  const visit = (value: unknown, keys: readonly string[], path: readonly string[]): Array<{ field: string; value: unknown }> => {
    if (!keys.length) return value === undefined ? [] : [{ field: path.join('.'), value }];
    const [key, ...rest] = keys;
    if (key === '*') return Array.isArray(value) ? value.flatMap((child, index) => visit(child, rest, [...path, String(index)])) : [];
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return [];
    return visit((value as Readonly<Record<string, unknown>>)[key], rest, [...path, key]);
  };
  return visit(input, field.split('.'), []);
}

/** An exact routing option can bind only the same one concrete declared operand. */
export function validateActionSessionAddressV1(input: Readonly<{
  sessionTarget: ActionSessionTargetDeclarationV1 | undefined;
  input: unknown;
  sessionAddress: unknown;
}>): Readonly<{ ok: true; sessionAddress: ActionSessionAddressV1 }> | ActionExecuteFailure {
  const address = ActionSessionAddressV1Schema.safeParse(input.sessionAddress);
  if (!address.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
  if (!input.sessionTarget) return { ok: false, errorCode: 'session_address_unsupported', error: 'session_address_unsupported' };
  const operands = input.input && typeof input.input === 'object' && !Array.isArray(input.input)
    ? readActionSessionTargetOperands(input.input as Readonly<Record<string, unknown>>, input.sessionTarget.field) : [];
  if (operands.length !== 1 || operands[0]!.value !== address.data.sessionId) {
    return { ok: false, errorCode: 'session_address_mismatch', error: 'session_address_mismatch' };
  }
  try {
    const normalized = normalizeSessionTargetV1(operands[0]!.value);
    if (typeof normalized !== 'string' || normalized !== address.data.sessionId) {
      return { ok: false, errorCode: 'session_address_mismatch', error: 'session_address_mismatch' };
    }
  } catch {
    return { ok: false, errorCode: 'session_address_mismatch', error: 'session_address_mismatch' };
  }
  return { ok: true, sessionAddress: address.data };
}

/** Replace only the declared target leaf, preserving its surrounding intent. */
export function replaceActionSessionTargetField(
  input: Readonly<Record<string, unknown>>, field: string, target: SessionTargetV1,
): Readonly<Record<string, unknown>> {
  const separator = field.indexOf('.');
  if (separator < 0) return { ...input, [field]: target };
  const key = field.slice(0, separator);
  const child = input[key];
  if (Array.isArray(child)) {
    const tail = field.slice(separator + 1);
    const split = tail.indexOf('.');
    const index = Number(split < 0 ? tail : tail.slice(0, split));
    if (!Number.isInteger(index) || index < 0 || index >= child.length || split < 0) throw new Error('Session target slot is unavailable');
    return { ...input, [key]: child.map((item, slot) => slot === index
      ? replaceActionSessionTargetField(item, tail.slice(split + 1), target) : item) };
  }
  if (!child || typeof child !== 'object') throw new Error('Session target path is unavailable');
  return { ...input, [key]: replaceActionSessionTargetField(
    child as Readonly<Record<string, unknown>>, field.slice(separator + 1), target,
  ) };
}

/** Bind only reviewed, declared slots. This same proof fences approval replay. */
export function bindActionSessionTargetOperands(input: Readonly<Record<string, unknown>>, snapshot: ActionResolvedSessionTargetsV1,
  requireConcrete = false): Readonly<Record<string, unknown>> | null {
  const fields = readActionSessionTargetOperands(input, snapshot.field);
  if (!snapshot.operands || fields.length !== snapshot.operands.length) return null;
  const addresses = new Map<string, ActionSessionAddress>();
  let bound = input;
  for (const [index, operand] of snapshot.operands.entries()) {
    const field = fields[index];
    if (field?.field !== operand.field || (requireConcrete && field.value !== operand.target.sessionId)) return null;
    addresses.set(JSON.stringify([operand.target.serverId, operand.target.sessionId]), operand.target);
    bound = replaceActionSessionTargetField(bound, operand.field, operand.target.sessionId);
  }
  const targets = [...addresses.values()];
  if (targets.length !== snapshot.targets.length || targets.some((target, index) => target.serverId !== snapshot.targets[index].serverId
    || target.sessionId !== snapshot.targets[index].sessionId)) return null;
  return bound;
}

async function readActionSessionTargets(
  deps: ActionExecutorDeps,
  args: SessionTargetsRequest,
): Promise<ActionResolvedSessionTargetsV1 | ActionExecuteFailure | null> {
  const { context, declaration, actionId } = args;
  const raw = readActionSessionTargetField(args.input, declaration.field);
  if (raw === undefined) return null; // Existing omitted/current-Session semantics stay with each Action.
  let target;
  try { target = normalizeSessionTargetV1(raw); }
  catch { return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' }; }
  if (typeof target === 'string') return null; // Existing exact-ID result and transport fast path.
  const baseId = target.of ?? id(context.defaultSessionId);
  if (!baseId && target.selector !== 'discussion' && (target.selector !== 'matching' || !target.filter.homeServerIds.length)) return unavailable('session_context_unavailable');
  const base = baseId ? await resolveActionSessionAddress(deps, { sessionId: baseId }, context, actionId,
    Boolean(deps.resolveSessionReference) || target.of !== undefined) : null;
  if (base && base.kind !== 'unique') return unavailable(base.kind === 'ambiguous' ? 'session_id_ambiguous' : 'session_context_unavailable');
  let targets: readonly ActionSessionAddress[];
  if (target.selector === 'matching') {
    const selected = await matching(deps, target, context, base?.address ?? null);
    if ('ok' in selected) return selected;
    targets = selected;
  } else if (target.selector === 'discussion') {
    const serverId = base?.address.serverId ?? id(context.serverId);
    if (!serverId) return unavailable('session_context_unavailable');
    const selected = await discussion(deps, serverId, target.discussionId, context);
    if ('ok' in selected) return selected;
    targets = selected;
  } else if (!base) return unavailable('session_context_unavailable');
  else if (target.selector === 'self') targets = [base.address];
  else if (target.selector === 'manager' || target.selector === 'siblings') {
    const relation = await (async () => {
      if (context.sessionListAccess === 'current_session') {
        const sessions = await readActionCallerLedSubtreeSessions(deps, { ...context, serverId: base.address.serverId });
        const row = sessions?.get(base.address.sessionId);
        if (!row || !('manager' in row)) return { kind: 'unavailable' } as const;
        const managerId = readSessionManagerSessionIdV1(row);
        if (managerId && !sessions?.has(managerId)) return { kind: 'unavailable' } as const;
        return { kind: 'manager', address: managerId ? { serverId: base.address.serverId, sessionId: managerId } : null } as const;
      }
      return await deps.readSessionManager?.({ address: base.address, context, actionId,
        ...(context.signal ? { signal: context.signal } : {}),
      }) ?? { kind: 'unavailable' } as const;
    })();
    if (relation.kind === 'unavailable') return unavailable('manager_reader_unavailable');
    if (!relation.address) targets = [];
    else if (target.selector === 'manager') targets = [relation.address];
    else {
      const siblings = await workers(deps, relation.address, { selector: 'workers' }, context);
      if ('ok' in siblings) return siblings;
      targets = siblings.filter(address => address.serverId !== base.address.serverId || address.sessionId !== base.address.sessionId);
    }
  } else if (target.selector === 'workers') {
    const selected = await workers(deps, base.address, target, context);
    if ('ok' in selected) return selected;
    targets = selected;
  } else if (target.selector === 'followers' || target.selector === 'following') {
    const selected = await follows(deps, base.address, target.selector, context, actionId);
    if ('ok' in selected) return selected;
    targets = selected;
  } else return unavailable('selector_backing_unavailable');
  if (context.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
  const seen = new Set<string>();
  targets = targets.filter(address => {
    const key = JSON.stringify([address.serverId, address.sessionId]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (declaration.cardinality === 'one' && targets.length !== 1) return {
    ok: false, errorCode: 'session_target_cardinality_mismatch', error: 'session_target_cardinality_mismatch',
    details: { expected: 'one', actualCount: targets.length },
  };
  if (!targets.length) return { ok: false, errorCode: 'session_target_empty', error: 'session_target_empty' };
  return { actionId, field: declaration.field, targets: [...targets],
    selector: declaration.cardinality === 'many' && target.selector !== 'self' && target.selector !== 'manager',
  };
}

/** Resolve once at Action admission. Replay consumes the sealed concrete list, never this enumeration. */
export async function resolveActionSessionTargets(
  deps: ActionExecutorDeps,
  args: SessionTargetsRequest,
): Promise<ActionResolvedSessionTargetsV1 | ActionExecuteFailure | null> {
  try {
    if (args.declaration.field.includes('*')) {
      const operands: NonNullable<ActionResolvedSessionTargetsV1['operands']> = [];
      const targets = new Map<string, ActionSessionAddress>();
      for (const operand of readActionSessionTargetOperands(args.input, args.declaration.field)) {
        const resolved = await readActionSessionTargets(deps, { ...args, declaration: { ...args.declaration, field: operand.field } });
        if (resolved && 'ok' in resolved) return resolved;
        const normalized = normalizeSessionTargetV1(operand.value);
        const exact = resolved ? resolved.targets : typeof normalized === 'string' && id(args.context.serverId)
          ? [{ serverId: id(args.context.serverId), sessionId: normalized }] : [];
        if (exact.length !== 1) return unavailable('session_context_unavailable');
        const target = exact[0];
        operands.push({ field: operand.field, target });
        targets.set(JSON.stringify([target.serverId, target.sessionId]), target);
      }
      return operands.length ? { actionId: args.actionId, field: args.declaration.field, targets: [...targets.values()], selector: false, operands } : null;
    }
    return await readActionSessionTargets(deps, args);
  } catch {
    return args.context.signal?.aborted
      ? { ok: false, errorCode: 'cancelled', error: 'cancelled' }
      : unavailable('target_read_failed');
  }
}
