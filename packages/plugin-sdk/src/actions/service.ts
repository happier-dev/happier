import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { getActionSpec as canonicalGetActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

import type { JsonValue, PluginContributionRef } from '../identity.js';
import type { QualifiedConnectedAccountRef } from '../connectedAccounts.js';
import type { PluginCancellationOptions } from '../lifecycle.js';
import type { Disposable } from '../lifecycle.js';
import {
  actionInputOptionValueKey,
  isSameActionInputOptionValue,
  normalizeActionInputByFieldHints,
  readActionInputOptionValue,
  resolveEffectiveActionInputFields,
} from './inputHints.js';
import { PluginMachineExecutionOriginV1Schema } from './executionOrigin.js';
import type { PluginMachineExecutionRoutingV1 } from './executionOrigin.js';
import type {
  ActionExecuteResult,
  ActionApprovalRequestCreatedResult,
  ActionInputFieldHint,
  ActionInputHints,
  ActionInputOption,
  ActionInputOptionValue,
  ActionInputPredicate,
  ActionSpec,
  EffectiveActionInputField,
  PluginActionInputById,
  PluginActionResultById,
  PluginActionContributionV2,
  PluginCommandContributionV2,
  PluginInvocableActionId,
  PluginMachineExecutionOriginV1,
  SessionTranscriptGetExternalShareableInputV1,
  SessionTranscriptGetExternalShareableResultV1,
  PluginToolContributionV2,
} from './actionTypeMap.generated.js';
import type { ActionContract, ActionHandler } from './contracts.js';
import { projectProtocolValue } from '../protocol/projectProtocolValue.js';
import type {
  AdmittedTargetedOperationExecutionHandle,
  AdmittedTargetedOperationIdentity,
} from './admittedTargetedOperation.js';

export {
  isPluginActionHandlerInvocationNotStartedAdvisory,
} from '../errors.js';
export type { PluginActionHandlerInvocation } from '../errors.js';

export type {
  ActionContract,
  PluginActionReadObserver,
  PluginActionReadInvalidation,
  ActionHandler,
  PluginActionInvocationSurfaceV2,
  PluginClientActionUi,
    PluginAccountActionContext,
    PluginAccountActionHandler,
} from './contracts.js';
/**
 * Client-targeted Action invocation types are only available in a client
 * runtime artifact.
 * @realm client
 */
export type {
  PluginClientActionContext,
  PluginClientActionHandler,
} from './contracts.js';
export type {
  AdmittedTargetedOperationExecutionHandle,
  AdmittedTargetedOperationIdentity,
} from './admittedTargetedOperation.js';

/** Exact Protocol execution-origin evidence returned by contributed Action execution. */
export { PluginMachineExecutionOriginV1Schema };
/** Exact Protocol execution-origin fact used for contributed Action currentness. */
export type {
  ActionApprovalRequestCreatedResult,
  ActionExecuteResult,
  ActionInputFieldHint,
  ActionInputHints,
  ActionInputOption,
  ActionInputOptionValue,
  ActionInputPredicate,
  ActionSpec,
  EffectiveActionInputField,
  PluginActionInputById,
  PluginActionResultById,
  PluginActionContributionV2 as ActionContribution,
  PluginCommandContributionV2 as CommandContribution,
  PluginInvocableActionId,
  PluginMachineExecutionOriginV1,
  SessionTranscriptGetExternalShareableInputV1,
  SessionTranscriptGetExternalShareableResultV1,
  PluginToolContributionV2 as ToolContribution,
};

/** Canonical host Action identifier accepted by {@link getActionSpec}. */
export type ActionId = ActionSpec['id'];

/** Canonical definition result projected by the host Workflow Action. */
export type PluginActionWorkflowDefinitionV1 = PluginActionResultById['workflow.definition.get']['definition'];

/** Looks up one canonical host ActionSpec without changing its runtime identity. */
export const getActionSpec: (
  id: ActionId,
) => ActionSpec = /* @__PURE__ */ projectProtocolValue(canonicalGetActionSpec);
export {
  actionInputOptionValueKey,
  isSameActionInputOptionValue,
  normalizeActionInputByFieldHints,
  readActionInputOptionValue,
  resolveEffectiveActionInputFields,
};

/**
 * Result of a contributed Action invocation whose exact target execution
 * origin was freshly stamped by the host after the Action completed.
 * @realm daemon
 */
export type ContributedActionExecutionWithOriginResult<
  TResult extends JsonValue | void = JsonValue | void,
> = Readonly<{
  result: TResult extends void ? null : TResult;
  executionOrigin: PluginMachineExecutionOriginV1;
}>;

/**
 * Equality-only currentness precondition for a contributed Action target.
 * The host validates this origin and never treats it as dispatch input or a
 * target selector.
 * @realm daemon
 */
export type ContributedActionExecutionWithOriginOptions = PluginCancellationOptions & Readonly<{
  expectedExecutionOrigin?: PluginMachineExecutionOriginV1;
  expectedExecutionRouting?: PluginMachineExecutionRoutingV1;
}>;

/** Equality-only target currentness pins for an admitted contributed read. @realm any */
export type ContributedActionReadObservationOptions = PluginCancellationOptions & Readonly<{
  expectedExecutionOrigin?: PluginMachineExecutionOriginV1;
  expectedExecutionRouting?: PluginMachineExecutionRoutingV1;
}>;

/**
 * One outer target Action's exact credential correspondence for a selected
 * admitted operation. The host validates it before the target contributor can
 * observe input; it is neither Action input nor a credential capability.
 * @realm daemon
 */
export type AdmittedTargetedOperationExecutionOptions = PluginCancellationOptions & Pick<ActionExecutionOptions, 'machineAvailability'> & Readonly<{
  expectedSelectedConnectedAccountRef?: QualifiedConnectedAccountRef | null;
}>;

/**
 * The admitted-operation credential correspondence plus the existing target
 * execution-origin currentness condition.
 * @realm daemon
 */
export type AdmittedTargetedOperationExecutionWithOriginOptions =
  AdmittedTargetedOperationExecutionOptions & ContributedActionExecutionWithOriginOptions;

/**
 * Narrows a host Action result to the canonical policy-deferral result.
 *
 * `execute` returns the deferral beside every domain arm, and a plugin has no
 * present-user host to satisfy it, so each caller must separate the two before
 * reading a domain field. A type predicate is required rather than an inline
 * `'kind' in value && value.kind === '…'` test: that compound condition does
 * not narrow the negative branch when the domain arms also carry `kind`, or
 * when they carry none at all. Classification stays with the canonical
 * Protocol schema so no second deferral shape is defined here.
 */
export function isPluginActionApprovalRequestCreated(
  value: unknown,
): value is ActionApprovalRequestCreatedResult {
  return ActionApprovalRequestCreatedResultSchema.safeParse(value).success;
}

/**
 * Canonical host and contributed-action invocation for one bound plugin caller.
 * @realm daemon
 */
/** Invocation routing and availability preferences; these never grant permission or resolve a selector. */
export type ActionExecutionOptions = PluginCancellationOptions & Readonly<{
  /** Read available sources now rather than awaiting an optional Machine connection.
   * Inherited by nested Actions. Omission retains ordinary connection settlement.
   * This is a latency hint, never authority or an execution target. */
  machineAvailability?: 'current';
}>;

export interface ActionsService {
  /**
   * Current routing of this invocation's own plugin, stamped by the same host
   * owner as contributed-Action callers. Null means unavailable or retired.
   * Older hosts omit this read; placement-sensitive work must then stay inert.
   * This is evidence only, never a selector or permission to invoke a target.
   */
  getCurrentExecutionRouting?(options?: PluginCancellationOptions): Promise<PluginMachineExecutionRoutingV1 | null>;

  execute<K extends PluginInvocableActionId>(
    actionId: K,
    input: PluginActionInputById[K],
    options?: ActionExecutionOptions,
  ): Promise<PluginActionResultById[K] | ActionApprovalRequestCreatedResult>;

  execute<TRef extends PluginContributionRef>(
    action: TRef,
    input: NoInfer<
      TRef extends ActionContract<infer TInput, JsonValue | void> ? TInput : JsonValue
    >,
    options?: ActionExecutionOptions,
  ): Promise<
    TRef extends ActionContract<JsonValue, infer TResult> ? TResult : JsonValue | void
  >;

  /**
   * Observes an admitted contributed read without running its handler. Session
   * operands must already be host-resolved exact Session ids; unresolved selectors
   * are refused by the read boundary. Cancellation retires the observer.
   */
  observe<TRef extends PluginContributionRef>(
    action: TRef,
    input: NoInfer<
      TRef extends ActionContract<infer TInput, JsonValue | void> ? TInput : JsonValue
    >,
    invalidate: () => void,
    options?: ContributedActionReadObservationOptions,
  ): Promise<Disposable>;

  /**
   * Executes one original host-created admitted target operation. A copied
   * descriptive handle has no execution authority and is refused before the
   * target contributor can run.
   */
  executeAdmittedTargetedOperation<TInput extends JsonValue, TResult extends JsonValue | void>(
    operation: AdmittedTargetedOperationExecutionHandle<TInput, TResult>,
    input: NoInfer<TInput>,
    options?: AdmittedTargetedOperationExecutionOptions,
  ): Promise<TResult>;

  /**
   * Installs the target's registered read observer without executing its Action.
   * The original handle, normalized input and readOnly declaration must still
   * be admitted. A target without an observer rejects with
   * plugin_action_read_observation_unavailable; other admission failures remain
   * failures rather than a snapshot-only observation.
   */
  observeAdmittedTargetedOperation<TInput extends JsonValue, TResult extends JsonValue | void>(
    operation: AdmittedTargetedOperationExecutionHandle<TInput, TResult>,
    input: NoInfer<TInput>,
    invalidate: () => void,
    options?: AdmittedTargetedOperationExecutionOptions,
  ): Promise<Disposable>;

  /**
   * Invokes one contributed Action and returns its ordinary result with the
   * exact current target execution origin. Host Actions deliberately have no
   * overload for this method.
   */
  executeWithExecutionOrigin<TRef extends PluginContributionRef>(
    action: TRef,
    input: NoInfer<
      TRef extends ActionContract<infer TInput, JsonValue | void> ? TInput : JsonValue
    >,
    options?: ContributedActionExecutionWithOriginOptions,
  ): Promise<ContributedActionExecutionWithOriginResult<
    TRef extends ActionContract<JsonValue, infer TResult> ? TResult : JsonValue | void
  >>;

  /**
   * Executes one original host-created admitted target operation and returns
   * its result with the exact current target execution origin.
   */
  executeAdmittedTargetedOperationWithExecutionOrigin<
    TInput extends JsonValue,
    TResult extends JsonValue | void,
  >(
    operation: AdmittedTargetedOperationExecutionHandle<TInput, TResult>,
    input: NoInfer<TInput>,
    options?: AdmittedTargetedOperationExecutionWithOriginOptions,
  ): Promise<Readonly<{
    result: TResult;
    executionOrigin: PluginMachineExecutionOriginV1;
  }>>;
}
