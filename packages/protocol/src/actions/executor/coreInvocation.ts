import { type ActionId } from '../actionIds.js';
import type { ActionExecutorContext, ActionPreparedInvocation, ActionPrepareResult } from './types.js';
import type { ActionApprovalScopeV1 } from '../actionSettings.js';
import { type MemoryWriteAdmissionV1 } from './memoryDocumentActions.js';
import { type DiscussionModelParticipantLaunchV1 } from '../../discussions/modelParticipantLaunch.js';
import type { ActionExecutorDeps } from './types.js';
import type { ActionSpec } from '../actionSpecs.js';

export type PreparedCoreAdmission = Readonly<{
    actionId: ActionId;
    input: unknown;
    context: ActionExecutorContext;
    safety?: ActionSpec['safety'];
    reviewAdmitted?: true;
    /** Private parent-child admission survives preparation; never caller-authored or persisted. */
    hostInternal?: true;
    approvalScope?: ActionApprovalScopeV1;
    previewTemplateEnvironmentId?: string;
    memoryAdmission?: MemoryWriteAdmissionV1;
    /** Exact host preparation retained across the person's review and dispatch. */
    deploymentReview?: import('../../json/strictJsonValue.js').JsonValue;
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
