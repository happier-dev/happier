import { getActionSpec, resolveActionExecutionPlacementForInput } from '@happier-dev/protocol/actions/actionSpecs';
import { actionInputValidationFailure } from '@happier-dev/protocol/actions/executor/actionInputValidation';
import { readLocalServiceControlActionRequest } from '@happier-dev/protocol/actions/specs/localServices';
import { MANAGED_MACHINE_ACTION_IDS_V1, ManagedAcquireInputV1Schema, ManagedMachineActionInputSchemasV1, isManagedRetainedControlInvocation, resolveManagedAcquireReviewV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { SessionSpawnNewActionAgentAuthoringInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import type { ActionExecuteResult, ActionExecutorContext, ExternalActionTargetV1, ActionId, ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions';
import { readActionSessionTargetField } from '@happier-dev/protocol/actions/executor/sessionTargets';
import { normalizeSessionTargetV1 } from '@happier-dev/protocol/actions/sessionTargetV1';
import { PluginSettingsAdministrationActionIdV1Schema, resolvePluginSettingsAdministrationTargetV1 } from '@happier-dev/protocol/plugins/settingsAdministration';
import { withExecutionRunStartFailureDetails } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { isManagedAccountNativeControlInvocationV1, readManagedProvisionerCredentialRootRoleV1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { readManagedMachine } from '@/machines/managed/readManagedMachine';
import type { StoredCredentials } from '@/persistence';

/**
 * The external ingress has one deliberately bounded selector vocabulary. It
 * reads canonical *parsed* Action input, never raw passthrough fields, so a
 * caller cannot steer placement through an incidental similarly named value.
 * New selector-shaped Action input must extend this owner and its architecture
 * test rather than gaining a route-local exception.
 */
const NESTED_SESSION_SELECTOR_ACTION_IDS = new Set<ActionId>([
  'session.continue_with_replay',
]);

/** Retained controls use the row's controller; controllerless provisioners stay Account-owned. */
export async function resolveManagedControlControllerTarget(input: Readonly<{
  actionId: string;
  rawInput: unknown;
  credentials: StoredCredentials;
  serverHttpBaseUrl: string;
  authorization?: ExternalActionExecutionAuthorizationV1;
  signal?: AbortSignal;
}>): Promise<Readonly<{ kind: 'machine'; machineId: string }> | null> {
  if (!isManagedRetainedControlInvocation(input.actionId, input.rawInput)) return null;
  const parsed = ManagedMachineActionInputSchemasV1[input.actionId].safeParse(input.rawInput);
  if (!parsed.success) return null;
  const machine = await readManagedMachine({ credentials: input.credentials, serverHttpBaseUrl: input.serverHttpBaseUrl,
    homeId: parsed.data.homeId,
    managedId: 'managedMachineId' in parsed.data ? parsed.data.managedMachineId : parsed.data.managedId,
    ...(input.authorization ? { authorization: input.authorization } : {}),
    ...(input.signal ? { signal: input.signal } : {}) });
  return machine.controller ? { kind: 'machine', machineId: machine.controller.machineId } : null;
}

/** The installed provisioner registry and native managed lifecycle belong to the daemon. */
export function requiresManagedMachineDaemonIngress(actionId: ActionId,
  placement: ReturnType<typeof resolveActionExecutionPlacementForInput> | null,
  controlControllerTarget?: Readonly<{ kind: 'machine'; machineId: string }> | null,
  originalCliInput?: unknown): boolean {
  return placement === 'machine' && MANAGED_MACHINE_ACTION_IDS_V1.some(id => id === actionId)
    || controlControllerTarget != null
    || originalCliInput !== undefined && placement === 'account'
      && (isManagedAccountNativeControlInvocationV1(actionId, originalCliInput)
        || readManagedProvisionerCredentialRootRoleV1(actionId) !== null);
}

// Only declared execution targets participate. Other nested Machine ids can
// describe SOURCE data, reviewed evidence, or a resource on another Machine.
const NESTED_MACHINE_SELECTOR_FIELDS: Readonly<Partial<Record<ActionId, string>>> = {
  'projects.worker.status': 'destination',
  'daemon.filesystem.copy': 'destination',
  'projects.inspect': 'workspace',
  'projects.manifest.update': 'workspace',
  'projects.prepare': 'workspace',
  'artifact.publish_from_file': 'workspace',
  'peerMediation.observability.subscribe': 'scope',
  'peerMediation.observability.unsubscribe': 'scope',
};

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

function parseActionTargetInput(actionId: ActionId, input: unknown) {
  // Target selection precedes Session inheritance and creation admission. Read
  // the same strict authoring shape without resolving either launch choice here.
  const schema = actionId === 'session.spawn_new'
    ? SessionSpawnNewActionAgentAuthoringInputV2Schema : getActionSpec(actionId).inputSchema;
  return schema.safeParse(input);
}

function readSessionSelectorIds(
  actionId: ActionId,
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

/** Reads semantic routing selectors from schema-admitted Action input only. */
export function readMachineSelectorIds(actionId: ActionId, input: Readonly<Record<string, unknown>>): readonly string[] {
  // The Action declaration owns runtime destinations, including nested input.
  // Empty context reads authored selection without introducing ambient routing.
  const runtimeDemand = getActionSpec(actionId).machineRuntimeDemandForInput?.(input, {});
  const acquire = actionId === 'machines.managed.acquire' ? ManagedAcquireInputV1Schema.safeParse(input) : null;
  const controllerMachineId = acquire?.success ? resolveManagedAcquireReviewV1(acquire.data).controller?.machineId ?? null
    : actionId === 'machines.provisioners.list' || actionId === 'machines.provisioners.check' || actionId === 'machines.provisioners.options'
      ? readNonEmptyString(asRecord(input.controller)?.machineId) : null;
  const nestedField = NESTED_MACHINE_SELECTOR_FIELDS[actionId];
  const settingsActionId = PluginSettingsAdministrationActionIdV1Schema.safeParse(actionId);
  const settingsTarget = settingsActionId.success
    ? resolvePluginSettingsAdministrationTargetV1(settingsActionId.data, input) : null;
  const selectors = [
    runtimeDemand?.target.kind === 'machine' ? runtimeDemand.target.machineId : null,
    controllerMachineId,
    // Key preparation executes on the explicitly selected trusted key holder.
    // Its qualified machineId addresses the managed Resource, not that holder.
    // Template roots execute on their Environment controller; machineId names
    // the runtime resource admitted through the normal own-server path.
    actionId === 'machines.access.prepareKeys' || actionId === DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1
      ? null : readNonEmptyString(input.machineId),
    nestedField ? readNonEmptyString(asRecord(input[nestedField])?.machineId) : null,
    settingsTarget?.kind === 'daemon' ? settingsTarget.machineId : null,
    readLocalServiceControlActionRequest(actionId, input)?.target.machineId ?? null,
  ];
  return selectors.filter((selector): selector is string => selector !== null);
}

/** Preserve an explicit semantic Machine before a caller considers automatic placement. */
export function resolveSelectedExternalActionMachineTarget(input: Readonly<{
  actionId: ActionId;
  rawInput: unknown;
  target: ExternalActionTargetV1 | undefined;
  fallbackMachineId?: string;
  context?: Pick<ActionExecutorContext, 'actionCaller' | 'surface'>;
}>): ReturnType<typeof resolveExternalActionMachineTarget> | null {
  const parsed = parseActionTargetInput(input.actionId, input.rawInput);
  if (!parsed.success) return null;
  if (readMachineSelectorIds(input.actionId, asRecord(parsed.data) ?? {}).length === 0
    && !input.fallbackMachineId && !input.target) return null;
  return resolveExternalActionMachineTarget({ ...input, rawInput: parsed.data });
}

function isTitleOnlySessionOpen(
  actionId: ActionId,
  input: Readonly<Record<string, unknown>>,
  sessionSelectorIds: readonly string[],
): boolean {
  return actionId === 'session.open'
    && sessionSelectorIds.length === 0
    && readNonEmptyString(input.sessionTitle) !== null;
}

function targetNotLocal(phase: 'target_machine_selection' | 'target_machine_locality' | 'target_session_selection'): ActionExecuteResult {
  return { ok: false, errorCode: 'target_not_local', error: 'target_not_local', details: { phase } };
}

function targetRequired(): ActionExecuteResult {
  return { ok: false, errorCode: 'target_required', error: 'target_required' };
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
      /** Present only after schema-admitted input has reached placement classification. */
      executionPlacement?: ReturnType<typeof resolveActionExecutionPlacementForInput>;
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
  actionId: ActionId;
  rawInput: unknown;
  target: ExternalActionTargetV1 | undefined;
  currentMachineId: string;
  context?: Pick<ActionExecutorContext, 'actionCaller' | 'surface'>;
}>): ExternalActionTargetReconciliation {
  const spec = getActionSpec(input.actionId);
  const parsed = parseActionTargetInput(input.actionId, input.rawInput);

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

  if (spec.sessionTarget) {
    const target = readActionSessionTargetField(parsedInput, spec.sessionTarget.field);
    // The strict Action schema has admitted the operand. A selector is intent
    // for the shared resolver, not an exact Session transport destination.
    let selectorIntent = false;
    try { selectorIntent = target !== undefined && target !== null && typeof normalizeSessionTargetV1(target) !== 'string'; }
    catch { /* The canonical Action executor owns malformed shorthand. */ }
    if (selectorIntent) {
      if (input.target?.kind === 'session') return { kind: 'rejected', execution: targetRequired() };
      return { kind: 'ready', target: input.target, context: {}, executionRunRequiresMachineTarget: false };
    }
  }

  const sessionSelectorIds = readSessionSelectorIds(input.actionId, parsedInput);
  const distinctSessionSelectorIds = [...new Set(sessionSelectorIds)];
  if (distinctSessionSelectorIds.length > 1) {
    return { kind: 'rejected', execution: targetNotLocal('target_session_selection') };
  }

  if (isTitleOnlySessionOpen(input.actionId, parsedInput, sessionSelectorIds)) {
    return { kind: 'rejected', execution: targetRequired() };
  }

  const isExecutionRun = input.actionId.startsWith('execution.run.');
  const executionPlacement = resolveActionExecutionPlacementForInput(spec, parsed.data, input.context?.actionCaller, input.context?.surface ?? 'api');
  const canDeriveSessionTarget = executionPlacement === 'session' || executionPlacement === 'client' || isExecutionRun;
  // `action.invoke` is machine-placed so account- and machine-scoped
  // contributions can run without a Session. Its nested plugin input is never
  // a routing selector, but an explicit envelope Session target is already
  // host-owned route metadata and may establish the invocation context.
  const isContributedActionInvocation = input.actionId === 'action.invoke';
  // Approval reads and decisions address an Artifact, while the envelope Session
  // constrains its visibility/subject at the canonical approval executor.
  const isSessionBoundApproval = input.actionId === 'approval.request.list'
    || input.actionId === 'approval.request.get' || input.actionId === 'approval.request.decide';
  const bindsEnvelopeSession = isContributedActionInvocation || isSessionBoundApproval
    || executionPlacement === 'client' || input.actionId.startsWith('computer.');
  const sessionSelectorId = distinctSessionSelectorIds[0] ?? null;

  if (executionPlacement === 'machine') {
    const machineSelectorIds = readMachineSelectorIds(input.actionId, parsedInput);
    if (machineSelectorIds.some((machineId) => machineId !== input.currentMachineId)) {
      return { kind: 'rejected', execution: targetNotLocal('target_machine_locality') };
    }
  }

  if (input.target?.kind === 'session') {
    if (!canDeriveSessionTarget && !bindsEnvelopeSession) {
      return { kind: 'rejected', execution: targetRequired() };
    }
    if (!bindsEnvelopeSession && !sessionSelectorId) {
      return { kind: 'rejected', execution: targetRequired() };
    }
    if (sessionSelectorId && sessionSelectorId !== input.target.sessionId) {
      return { kind: 'rejected', execution: targetNotLocal('target_session_selection') };
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

  if (executionPlacement === 'session') {
    return { kind: 'rejected', execution: targetRequired() };
  }

  return {
    kind: 'ready',
    target: input.target,
    context: {},
    executionRunRequiresMachineTarget: isExecutionRun,
    executionPlacement,
  };
}

/** Caller-side Machine selection uses the same parsed selector/locality owner as daemon ingress. */
export function resolveExternalActionMachineTarget(input: Readonly<{
  actionId: ActionId;
  rawInput: unknown;
  target?: ExternalActionTargetV1;
  fallbackMachineId?: string | null;
  /** Authenticated receiving-Machine or linked-Session ownership; input cannot retarget it. */
  ownerMachineId?: string | null;
  context?: Pick<ActionExecutorContext, 'actionCaller' | 'surface'>;
}>): Readonly<{ kind: 'ready'; machineId: string }> | Readonly<{ kind: 'rejected'; execution: ActionExecuteResult }> {
  // Selection has not dispatched Start, so a refusal proves no Run was created.
  const reject = (execution: ActionExecuteResult): Readonly<{ kind: 'rejected'; execution: ActionExecuteResult }> => ({
    kind: 'rejected',
    execution: input.actionId === 'execution.run.start' && !execution.ok
      ? { ...execution, details: withExecutionRunStartFailureDetails(execution.details, 'noRunCreated') }
      : execution,
  });
  const parsed = parseActionTargetInput(input.actionId, input.rawInput);
  if (!parsed.success) return reject(actionInputValidationFailure(parsed.error));
  const machineIds = readMachineSelectorIds(input.actionId, asRecord(parsed.data) ?? {});
  const explicitMachineId = input.target?.kind === 'machine' ? input.target.machineId : null;
  const distinctMachineIds = new Set([...machineIds, ...(explicitMachineId ? [explicitMachineId] : [])]);
  if (distinctMachineIds.size > 1) return reject(targetNotLocal('target_machine_selection'));
  const machineId = input.ownerMachineId ?? machineIds[0] ?? explicitMachineId ?? readNonEmptyString(input.fallbackMachineId);
  if (!machineId) return reject(targetRequired());
  if (explicitMachineId && explicitMachineId !== machineId) return reject(targetNotLocal('target_machine_selection'));
  const reconciliation = reconcileExternalActionTarget({
    actionId: input.actionId, rawInput: parsed.data, target: input.target, currentMachineId: machineId,
    ...(input.context ? { context: input.context } : {}),
  });
  return reconciliation.kind === 'rejected' ? reject(reconciliation.execution) : { kind: 'ready', machineId };
}
