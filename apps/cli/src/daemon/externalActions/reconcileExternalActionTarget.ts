import {
  getActionSpec,
  type ActionExecuteResult,
  type ActionExecutorContext,
  type ExternalActionTargetV1,
  type PublicActionId,
} from '@happier-dev/protocol/actions';

/**
 * The external ingress has one deliberately bounded selector vocabulary. It
 * reads canonical *parsed* Action input, never raw passthrough fields, so a
 * caller cannot steer placement through an incidental similarly named value.
 * New selector-shaped Action input must extend this owner and its architecture
 * test rather than gaining a route-local exception.
 */
const NESTED_SESSION_SELECTOR_ACTION_IDS = new Set<PublicActionId>([
  'session.continue_with_replay',
]);

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readSessionSelectorIds(
  actionId: PublicActionId,
  input: Readonly<Record<string, unknown>>,
): readonly string[] {
  const selectors = [
    readNonEmptyString(input.sessionId),
    readNonEmptyString(input.parentSessionId),
  ];
  if (NESTED_SESSION_SELECTOR_ACTION_IDS.has(actionId)) {
    selectors.push(readNonEmptyString(asRecord(input.replay)?.previousSessionId));
  }
  return selectors.filter((selector): selector is string => selector !== null);
}

function readMachineSelectorIds(input: Readonly<Record<string, unknown>>): readonly string[] {
  const selectors = [
    readNonEmptyString(input.machineId),
    readNonEmptyString(asRecord(input.executionTarget)?.machineId),
  ];
  return selectors.filter((selector): selector is string => selector !== null);
}

function isTitleOnlySessionOpen(
  actionId: PublicActionId,
  input: Readonly<Record<string, unknown>>,
  sessionSelectorIds: readonly string[],
): boolean {
  return actionId === 'session.open'
    && sessionSelectorIds.length === 0
    && readNonEmptyString(input.sessionTitle) !== null;
}

function targetNotLocal(): ActionExecuteResult {
  return { ok: false, errorCode: 'target_not_local', error: 'target_not_local' };
}

function targetRequired(): ActionExecuteResult {
  return { ok: false, errorCode: 'target_required', error: 'target_required' };
}

function placementUnavailable(): ActionExecuteResult {
  return {
    ok: false,
    errorCode: 'placement_unavailable',
    error: 'placement_unavailable',
  };
}

export type ExternalActionTargetReconciliation =
  | Readonly<{
      kind: 'ready';
      target: ExternalActionTargetV1 | undefined;
      context: Pick<
        ActionExecutorContext,
        'defaultSessionId' | 'executionRunTargetMachineId'
      >;
      executionRunRequiresMachineTarget: boolean;
    }>
  | Readonly<{ kind: 'rejected'; execution: ActionExecuteResult }>;

/**
 * Reconciles the public envelope route metadata with the canonical parsed
 * Action input before the daemon asks its target resolver for a final locality
 * proof. This is intentionally ingress-owned: Action owners keep their input
 * semantics, while the transport owns only whether that input may select a
 * different daemon or Session than the verified route target.
 */
export function reconcileExternalActionTarget(input: Readonly<{
  actionId: PublicActionId;
  rawInput: unknown;
  target: ExternalActionTargetV1 | undefined;
  currentMachineId: string;
}>): ExternalActionTargetReconciliation {
  const spec = getActionSpec(input.actionId);
  const parsed = spec.inputSchema.safeParse(input.rawInput);

  // The canonical executor owns malformed Action input errors. Do not create a
  // second parser/error vocabulary at ingress; only route validated input.
  if (!parsed.success) {
    return {
      kind: 'ready',
      target: input.target,
      context: {},
      executionRunRequiresMachineTarget: false,
    };
  }

  const parsedInput = asRecord(parsed.data);
  if (!parsedInput) {
    return {
      kind: 'ready',
      target: input.target,
      context: {},
      executionRunRequiresMachineTarget: false,
    };
  }

  if (spec.executionPlacement === 'client') {
    return { kind: 'rejected', execution: placementUnavailable() };
  }

  const sessionSelectorIds = readSessionSelectorIds(input.actionId, parsedInput);
  const distinctSessionSelectorIds = [...new Set(sessionSelectorIds)];
  if (distinctSessionSelectorIds.length > 1) {
    return { kind: 'rejected', execution: targetNotLocal() };
  }

  if (isTitleOnlySessionOpen(input.actionId, parsedInput, sessionSelectorIds)) {
    return { kind: 'rejected', execution: targetRequired() };
  }

  const isExecutionRun = input.actionId.startsWith('execution.run.');
  const canDeriveSessionTarget = spec.executionPlacement === 'session' || isExecutionRun;
  // `action.invoke` is machine-placed so account- and machine-scoped
  // contributions can run without a Session. Its nested plugin input is never
  // a routing selector, but an explicit envelope Session target is already
  // host-owned route metadata and may establish the invocation context.
  const isContributedActionInvocation = input.actionId === 'action.invoke';
  const sessionSelectorId = distinctSessionSelectorIds[0] ?? null;

  if (spec.executionPlacement === 'machine') {
    const machineSelectorIds = readMachineSelectorIds(parsedInput);
    if (machineSelectorIds.some((machineId) => machineId !== input.currentMachineId)) {
      return { kind: 'rejected', execution: targetNotLocal() };
    }
  }

  if (input.target?.kind === 'session') {
    if (!canDeriveSessionTarget && !isContributedActionInvocation) {
      return { kind: 'rejected', execution: targetRequired() };
    }
    if (!isContributedActionInvocation && !sessionSelectorId) {
      return { kind: 'rejected', execution: targetRequired() };
    }
    if (sessionSelectorId && sessionSelectorId !== input.target.sessionId) {
      return { kind: 'rejected', execution: targetNotLocal() };
    }
    return {
      kind: 'ready',
      target: input.target,
      context: { defaultSessionId: input.target.sessionId },
      executionRunRequiresMachineTarget: false,
    };
  }

  if (canDeriveSessionTarget && sessionSelectorId) {
    // A local-machine target is compatible only after the canonical Session
    // resolver proves this same daemon still owns the selected Session.
    return {
      kind: 'ready',
      target: { kind: 'session', sessionId: sessionSelectorId },
      context: { defaultSessionId: sessionSelectorId },
      executionRunRequiresMachineTarget: false,
    };
  }

  if (spec.executionPlacement === 'session') {
    return { kind: 'rejected', execution: targetRequired() };
  }

  return {
    kind: 'ready',
    target: input.target,
    context: {},
    executionRunRequiresMachineTarget: isExecutionRun,
  };
}
