import { getActionSpec as canonicalGetActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

import type { JsonValue, PluginContributionRef } from '../identity.js';
import type { QualifiedConnectedAccountRef } from '../connectedAccounts.js';
import type { PluginCancellationOptions } from '../lifecycle.js';
import {
  actionInputOptionValueKey,
  isSameActionInputOptionValue,
  normalizeActionInputByFieldHints,
  readActionInputOptionValue,
  resolveEffectiveActionInputFields,
} from './inputHints.js';
import { PluginMachineExecutionOriginV1Schema } from './executionOrigin.js';
import type {
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
  PluginActionContributionV2,
  PluginCommandContributionV2,
  PluginInvocableActionId,
  PluginMachineExecutionOriginV1,
  SessionTranscriptGetExternalShareableInputV1,
  SessionTranscriptGetExternalShareableResultV1,
  PluginToolContributionV2,
} from './actionTypeMap.generated.js';
import type { ActionContract, ActionHandler } from './contracts.js';
import type {
  AdmittedTargetedOperationExecutionHandle,
  AdmittedTargetedOperationIdentity,
} from './admittedTargetedOperation.js';

export {
  isPluginActionHandlerInvocationKnownNotStarted,
} from '../errors.js';
export type { PluginActionHandlerInvocation } from '../errors.js';

export type {
  ActionContract,
  ActionHandler,
  PluginActionInvocationSurfaceV2,
  PluginClientActionUi,
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

/** Looks up one canonical host ActionSpec without changing its runtime identity. */
export const getActionSpec: (
  id: ActionId,
) => ActionSpec = canonicalGetActionSpec;
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
export type ContributedActionExecutionWithOriginResult = Readonly<{
  result: JsonValue | null;
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
}>;

/**
 * One outer target Action's exact credential correspondence for a selected
 * admitted operation. The host validates it before the target contributor can
 * observe input; it is neither Action input nor a credential capability.
 * @realm daemon
 */
export type AdmittedTargetedOperationExecutionOptions = PluginCancellationOptions & Readonly<{
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
 * Canonical host and contributed-action invocation for one bound plugin caller.
 * @realm daemon
 */
export interface ActionsService {
  execute<K extends PluginInvocableActionId>(
    actionId: K,
    input: PluginActionInputById[K],
    options?: PluginCancellationOptions,
  ): Promise<PluginActionResultById[K]>;

  execute<TRef extends PluginContributionRef>(
    action: TRef,
    input: JsonValue,
    options?: PluginCancellationOptions,
  ): Promise<JsonValue | void>;

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
   * Invokes one contributed Action and returns its ordinary result with the
   * exact current target execution origin. Host Actions deliberately have no
   * overload for this method.
   */
  executeWithExecutionOrigin<TRef extends PluginContributionRef>(
    action: TRef,
    input: JsonValue,
    options?: ContributedActionExecutionWithOriginOptions,
  ): Promise<ContributedActionExecutionWithOriginResult>;

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
