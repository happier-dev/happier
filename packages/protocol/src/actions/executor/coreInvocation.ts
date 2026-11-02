import type { WorkflowSessionScopeV1 } from '../../workflows/workflowSessionScopeV1.js';
import type { SessionVisualAdmissionV1 } from './sessionVisualAdmission.js';
import type { WidgetSurfaceReadV1 } from '../../widgets/actionsV1.js';
import type { DiscussionAnswerPolicyV1 } from '../../discussions/participants.js';
import type { ActionExecuteFailure } from '../actionExecutionResult.js';
import { type ActionId } from '../actionIds.js';
import type { ActionExecutorContext, ActionPreparedInvocation, ActionPrepareResult } from './types.js';
import type { ActionApprovalScopeV1 } from '../actionSettings.js';
import { type MemoryWriteAdmissionV1 } from './memoryDocumentActions.js';
import { type DiscussionModelParticipantLaunchV1 } from '../../discussions/modelParticipantLaunch.js';
import type { ActionExecutorDeps } from './types.js';
import type { ActionSpec } from '../actionSpecs.js';

export type PreparedCoreAdmission = Readonly<{
previewTemplateEnvironmentId?: string;

    actionId: ActionId;
    input: unknown;
    /** Post-hook semantic operands before domain preparation creates effect refs. */
    semanticInput?: unknown;
    context: ActionExecutorContext;
    /** Core-resolved review classification, including contextual overrides; never caller input. */
    safety?: ActionSpec['safety'];
    /** Exact host-derived scope for this admitted Action; never caller context or persisted. */
    workflowSessionScope?: WorkflowSessionScopeV1 | null;
    /** Private parent-child admission survives preparation; never caller-authored or persisted. */
    hostInternal?: true;
    approvalScope?: ActionApprovalScopeV1;
    memoryAdmission?: MemoryWriteAdmissionV1;
    /** Keep the original creation consequence after effective policy narrows the input. */
    visualAdmission?: SessionVisualAdmissionV1;
    /** Placement already read by this invocation; approval replay admits afresh. */
    widgetSurfaceRead?: WidgetSurfaceReadV1;
    /** Public prepare is deferred; immediate execute and its operation dispatch retain admission. */
    memoryAdmissionAtExecution?: true;
    /** Exact host preparation retained across the person's review and dispatch. */
    deploymentReview?: import('../../json/strictJsonValue.js').JsonValue;
    hostReviewedChildren?: import('./types.js').HostReviewedChildrenPlanV1;
    hostReviewedChildPolicies?: readonly import('./deploymentRoleChild.js').HostReviewedChildPolicyV1[];
    /** The producer's closure retains its exact prepared facts without persisting domain state. */
    executeAdmittedAction?: import('./types.js').HostReviewedChildrenPreparationV1['executeAdmittedAction'];
    /** The host continuation already invoked this private admitted dispatch callback. */
    admittedExecutionContinued?: true;
    /** The admitted client request has reached its local effect or presenting realm. */
    clientExecutionContinued?: true;
    /** The same parent review already answered this invocation's Ask, including demanded children. */
    reviewAdmitted?: true;
    /** In-process only; durable approval replay must prepare this afresh. */
    observePendingOperation?: (context: ActionExecutorContext) => Promise<import('../actionExecutionResult.js').ActionExecuteResult>;
    legacyMetadataLabel?: string;
    /** Selected intent, before ordinary Role/Profile/permission resolution. Not authority. */
    discussionParticipantLaunch?: DiscussionModelParticipantLaunchV1;
    /** The host runner has already admitted this exact effect, including a scope refusal. */
    operationObserved?: true;
  }>;

export type PrivatePrepareResult =
    | Extract<ActionPrepareResult, { kind: 'settled' }>
    | Readonly<{ kind: 'ready'; invocation: ActionPreparedInvocation; admission: PreparedCoreAdmission }>;

export type ActionHomeEquivalence = (left: string | null | undefined, right: string | null | undefined) => boolean;

export type CoreOptions = Readonly<{
      prepareOnly?: boolean;
      /** Host-local review projection, not approval or permission to dispatch. */
      reviewOnly?: true;
      /** Only public execute offers the host's transient UI default confirmation. */
      confirmUiDefault?: boolean;
      prepared?: PreparedCoreAdmission;
      hostInternal?: boolean;
      approvalReplay?: boolean;
      /** This private dispatch already holds a concrete address, even if its ID resembles shorthand. */
      sessionTargetLeaf?: boolean;
      approvedApiTokenExecution?: import('../blockingApprovalCoordinator.js').BlockingApprovalTokenExecution;
      /** Private Home binding from the already-verified approval replay owner. */
      sameHome?: ActionHomeEquivalence;
    }>;

export type DispatchFacts = {
  executionRunStartDispatched: boolean;
  dispatchedPluginSessionInputLocalId: string | null;
};

export type CoreInvocation = Readonly<{
  actionId: ActionId;
  spec: ActionSpec;
  ctx: ActionExecutorContext;
  admittedInput: unknown;
  parsed: { data: unknown };
  data: Record<string, unknown>;
  deps: ActionExecutorDeps;
  options: CoreOptions | undefined;
}>;

export type DiscussionPublicationPolicy = Readonly<{
  ok: true; answerPolicy: DiscussionAnswerPolicyV1; informationalReturn: boolean;
}> | ActionExecuteFailure | null;
