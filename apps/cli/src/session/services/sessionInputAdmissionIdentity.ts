import { buildTrustedHostSessionInputAdmissionV1, PluginSessionInputSourceV1Schema, SessionInputCausalPermissionAuthorityV1Schema, SessionInputRequestV1Schema, SessionInputRequestV2Schema, SessionInputWorkflowV2Schema, SessionInputSourceSessionV1Schema, SessionMessageProvenanceV2Schema, requiresAuthenticatedMachineAdmissionForSessionInput } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { PluginContributionLocalIdSchema } from '@happier-dev/protocol/plugins/contribution-identity';
import { PluginIdSchema } from '@happier-dev/protocol/plugins/plugin-id';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { SessionMessageProvenanceV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { readPendingLocalId } from '@happier-dev/protocol/sessions/pending/pendingLocalId';
import { materializeActionRequestAttributionV1, type ActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import { SessionCreationCorrespondenceV1ReadSchema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import type { ActionPluginCaller, ActionCaller, ActionSurfaces, ExternalActionExecutionAuthorizationV1, PluginInvocationSurfaceV1, PluginSessionInputSourceV1, SessionInputCausalPermissionAuthorityV1, SessionInputRequestV1, SessionInputRequestV2, SessionInputRequest, SessionInputSourceAuthorityV1, SessionInputWorkflowV2, SessionMessageProvenanceV1, SessionMessageProvenanceV2 } from '@happier-dev/protocol';

export { deriveWorkflowSessionInputLocalIdV2 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';

/** Protected input keeps live Session custody; an inactive Session resumes through its Machine. */
export function resolveProtectedSessionInputActionTarget(input: Readonly<{
  sessionId: string;
  machineId: string;
  active: boolean;
}>): import('@happier-dev/protocol').ExternalActionTargetV1 {
  return input.active
    ? { kind: 'session', sessionId: input.sessionId }
    : { kind: 'machine', machineId: input.machineId };
}

/** One exact target for input authoring and the CLI's authenticated Machine route. */
export function resolveSessionInputTargetMachineId(params: Readonly<{
  decryptedMetadata: Record<string, unknown> | null;
  rawSession: Readonly<Record<string, unknown>>;
  targetMachineId?: string;
}>): string | null {
  const correspondence = SessionCreationCorrespondenceV1ReadSchema.safeParse(
    params.decryptedMetadata?.sessionCreationCorrespondenceV1,
  );
  // Creation correspondence describes birth, not the Machine serving a resumed Session.
  const observedMachineId = typeof params.rawSession.machineId === 'string'
    ? params.rawSession.machineId.trim()
    : typeof params.decryptedMetadata?.machineId === 'string'
      ? params.decryptedMetadata.machineId.trim()
      : correspondence.success
        ? correspondence.data.recipe.execution.machineId
        : '';
  const suppliedMachineId = params.targetMachineId?.trim() ?? '';
  if (observedMachineId && suppliedMachineId && observedMachineId !== suppliedMachineId) return null;
  if (observedMachineId) return observedMachineId;
  return suppliedMachineId || null;
}

/** Protected E2EE equality and authenticated caller facts require the Machine seam. */
export function requiresMachineAdmissionForSessionInput(params: Readonly<{
  request: SessionInputRequest | null;
  mode: 'plain' | 'e2ee';
  callerInputAuthorization?: ExternalActionExecutionAuthorizationV1;
}>): boolean {
  // A person's Ask needs the authenticated Account actor on its original
  // input, including when content is encrypted. A Machine receipt attests the
  // target's installation, not the person who chose a return destination.
  if (params.request?.v === 1 && params.request.replyIntent?.humanOrigin
    && !requiresAuthenticatedMachineAdmissionForSessionInput(params.request)) return false;
  // Follow-only input is authored by its captured Account, even when that
  // Account's Session runs on a foreign Machine. Other protected sources keep
  // the Machine admission requirement below.
  if (params.request?.v === 1 && params.request.followDeliveryV1
    && !requiresAuthenticatedMachineAdmissionForSessionInput(params.request)
    && params.callerInputAuthorization === undefined) return false;
  return params.request !== null && (
    requiresAuthenticatedMachineAdmissionForSessionInput(params.request)
    || params.mode === 'e2ee'
    || params.callerInputAuthorization !== undefined
  );
}

function projectPluginInvocationSurface(
  surface: keyof ActionSurfaces | null | undefined,
): PluginInvocationSurfaceV1 | 'unspecified' {
  if (surface === 'cli' || surface === 'mcp' || surface === 'agent' || surface === 'ui') {
    return surface;
  }
  // The plugin surface is an authorization surface, not the origin modality.
  // Until an origin surface is present in ActionCaller, keep this bounded and
  // truthfully non-specific instead of inferring UI or Agent authorship.
  return 'unspecified';
}

export function buildPluginSessionInputAdmissionV1(params: Readonly<{
  caller: ActionPluginCaller;
  surface?: keyof ActionSurfaces | null;
  source?: PluginSessionInputSourceV1;
  actionRequestAttributionV1?: ActionRequestAttributionV1;
}>): Readonly<{
  provenance: SessionMessageProvenanceV1;
  request: SessionInputRequestV1;
}> {
  const pluginId = PluginIdSchema.parse(params.caller.pluginId);
  const contributionLocalId = PluginContributionLocalIdSchema.parse(
    params.caller.contributionLocalId,
  );
  const source = params.source === undefined
    ? undefined
    : PluginSessionInputSourceV1Schema.parse(params.source);
  const caller = {
    kind: 'plugin' as const,
    pluginId,
    contributionLocalId,
  };
  return Object.freeze({
    provenance: Object.freeze({
      v: 1 as const,
      kind: 'pluginSession' as const,
      pluginId,
      contributionLocalId,
      surface: projectPluginInvocationSurface(params.surface),
      ...(source
        ? {
            sourceRef: source.sourceRef,
            sourceRevisionOrEpoch: source.sourceRevisionOrEpoch,
            ...(source.displayNameSnapshot === undefined ? {} : { displayNameSnapshot: source.displayNameSnapshot }),
            ...(source.externalActor && source.contentProvenance
              ? {
                  externalActor: source.externalActor,
                  contentProvenance: source.contentProvenance,
                }
              : {}),
          }
        : {}),
    }),
    request: Object.freeze({
      v: 1 as const,
      producer: 'pluginSession' as const,
      caller,
      ...(params.actionRequestAttributionV1
        ? { actionRequestAttributionV1: materializeActionRequestAttributionV1(params.actionRequestAttributionV1) }
        : {}),
      ...(source
        ? {
            sourceAuthority: {
              mediatorPluginId: pluginId,
              sourceRef: source.sourceRef,
              sourceRevisionOrEpoch: source.sourceRevisionOrEpoch,
              remoteApprovalMaxScope: source.remoteApprovalMaxScope,
            },
          }
        : {}),
      permission: source
        ? { requestedPermissionCeiling: source.requestedPermissionCeiling }
        : {},
    }),
  });
}

/**
 * Automation owns its run identity; Message only derives the one Pending key
 * and protected facts required to admit that already-authenticated run.
 */
export function deriveAutomationSessionInputLocalIdV1(params: Readonly<{
  automationId: string;
  runId: string;
}>): string {
  const request = SessionInputRequestV1Schema.parse({
    v: 1,
    producer: 'automation',
    caller: { kind: 'host' },
    automation: {
      automationId: params.automationId,
      runId: params.runId,
    },
    permission: {},
  });
  const localId = readPendingLocalId(`automation:run:${request.automation!.runId}`);
  if (localId === null) throw new Error('Derived Automation Session input local id is invalid');
  return localId;
}

export function buildAutomationSessionInputAdmissionV1(params: Readonly<{
  automationId: string;
  runId: string;
}>): Readonly<{
  provenance: SessionMessageProvenanceV1;
  request: SessionInputRequestV1;
}> {
  const request = SessionInputRequestV1Schema.parse({
    v: 1,
    producer: 'automation',
    caller: { kind: 'host' },
    automation: {
      automationId: params.automationId,
      runId: params.runId,
    },
    permission: {},
  });
  const automation = request.automation!;
  return Object.freeze({
    provenance: SessionMessageProvenanceV1Schema.parse({
      v: 1,
      kind: 'automation',
      automationId: automation.automationId,
      runId: automation.runId,
    }),
    request,
  });
}

/** Host-only V2 admission for one workflow invocation. */
export function buildWorkflowSessionInputAdmissionV2(
  params: SessionInputWorkflowV2,
  options: Readonly<{
    requestedPermissionCeiling?: SessionInputRequestV2['permission']['requestedPermissionCeiling'];
    replyIntent?: SessionInputRequestV2['replyIntent'];
    discussionAddressing?: SessionInputRequestV2['discussionAddressing'];
    sourceAuthority?: SessionInputSourceAuthorityV1;
    actionRequestAttributionV1?: ActionRequestAttributionV1;
  }> = {},
): Readonly<{
  provenance: SessionMessageProvenanceV2;
  request: SessionInputRequestV2;
}> {
  const workflow = SessionInputWorkflowV2Schema.parse(params);
  return Object.freeze({
    provenance: SessionMessageProvenanceV2Schema.parse({
      v: 2,
      kind: 'workflow_invocation',
      runId: workflow.runId,
      invocationRecordId: workflow.invocationRecordId,
      ...(workflow.workDepth !== undefined ? { workDepth: workflow.workDepth } : {}),
      ...(workflow.stepOrdinal !== undefined ? { stepOrdinal: workflow.stepOrdinal } : {}),
    }),
    request: SessionInputRequestV2Schema.parse({
      v: 2,
      producer: 'workflow',
      caller: { kind: 'host' },
      ...(options.replyIntent ? { replyIntent: options.replyIntent } : {}),
      ...(options.discussionAddressing ? { discussionAddressing: options.discussionAddressing } : {}),
      ...(options.sourceAuthority ? { sourceAuthority: options.sourceAuthority } : {}),
      ...(options.actionRequestAttributionV1 ? { actionRequestAttributionV1: options.actionRequestAttributionV1 } : {}),
      workflow,
      permission: options.requestedPermissionCeiling
        ? { requestedPermissionCeiling: options.requestedPermissionCeiling }
        : {},
    }),
  });
}

/** Builds protected cross-Session input from a host-stamped active turn. */
export function buildCausalSessionInputAdmissionV1(params: Readonly<{
  sourceSessionId: string;
  sourceTurnId: string;
  sourceInputId?: string;
  discussionAddressing?: SessionInputRequestV1['discussionAddressing'];
  callerDepth: number;
  via: 'action' | 'mcp';
  causalPermissionAuthority: SessionInputCausalPermissionAuthorityV1;
  actionRequestAttributionV1?: ActionRequestAttributionV1;
}>): Readonly<{
  provenance: SessionMessageProvenanceV1;
  request: SessionInputRequestV1;
}> {
  const sourceSession = SessionInputSourceSessionV1Schema.parse({
    sourceSessionId: params.sourceSessionId,
    sourceTurnId: params.sourceTurnId,
    ...(params.sourceInputId ? { sourceInputId: params.sourceInputId } : {}),
    ...(params.discussionAddressing !== undefined ? { discussionAddressing: params.discussionAddressing } : {}),
    via: params.via,
  });
  const causalPermissionAuthority = SessionInputCausalPermissionAuthorityV1Schema.parse(
    params.causalPermissionAuthority,
  );
  const sourceAuthority = causalPermissionAuthority.sourceAuthority;
  return Object.freeze({
    provenance: SessionMessageProvenanceV1Schema.parse({
      v: 1,
      kind: 'happierSession',
      sourceSessionId: sourceSession.sourceSessionId,
      via: sourceSession.via,
      callerDepth: params.callerDepth,
    }),
    request: SessionInputRequestV1Schema.parse({
      v: 1,
      producer: sourceSession.via === 'mcp' ? 'happierMcp' : 'sessionAction',
      caller: { kind: 'host' },
      sourceSession,
      ...(params.actionRequestAttributionV1
        ? { actionRequestAttributionV1: materializeActionRequestAttributionV1(params.actionRequestAttributionV1) }
        : {}),
      ...(sourceAuthority
        ? {
            sourceAuthority: {
              mediatorPluginId: sourceAuthority.mediatorPluginId,
              sourceRef: sourceAuthority.sourceRef,
              sourceRevisionOrEpoch: sourceAuthority.sourceRevisionOrEpoch,
              remoteApprovalMaxScope: sourceAuthority.remoteApprovalMaxScope,
            },
          }
        : {}),
      permission: {
        requestedPermissionCeiling: causalPermissionAuthority.admittedPermissionCeiling,
      },
    }),
  });
}

/**
 * The daemon's persisted first prompt is a host runtime input, not a UI RPC
 * send. It uses the same admission builder but retains its own producer fact.
 */
export function buildAgentRuntimeFirstInputAdmissionV1(): Readonly<{
  provenance: SessionMessageProvenanceV1;
  request: SessionInputRequestV1;
}> {
  return Object.freeze({
    provenance: SessionMessageProvenanceV1Schema.parse({
      v: 1,
      kind: 'host',
      producer: 'agentRuntimeFirstInput',
    }),
    request: SessionInputRequestV1Schema.parse({
      v: 1,
      producer: 'agentRuntimeFirstInput',
      caller: { kind: 'host' },
      permission: {},
    }),
  });
}

/**
 * Sole host-caller admission for a person's typed input reaching this host as an Action. The app reaches the
 * Machine over `rpc`, a transport rather than a modality; there the Home-stamped `present_user` authority on an
 * original (non-descendant) request is what says a person sent their own words, so it is the Happier app's input.
 * Unattended Accounts and descendants of another request keep host provenance; settlement still alone decides
 * the Account relationship from the authenticated receipt.
 */
export function buildHostCallerSessionInputAdmissionV1(params: Readonly<{
  surface?: keyof ActionSurfaces | null;
  authority?: ActionExecutorContext['authority'];
  descendant: boolean;
}>): ReturnType<typeof buildTrustedHostSessionInputAdmissionV1> {
  return buildTrustedHostSessionInputAdmissionV1(
    params.surface === 'rpc' && params.authority === 'present_user' && !params.descendant ? 'ui' : params.surface);
}

/** Host-private admission for a spawn handoff whose durable local id is already sealed. */
export function buildSessionSpawnInitialInputAdmissionForLocalIdV1(params: Readonly<{
  actionCaller: ActionCaller;
  callerSurface?: keyof ActionSurfaces | null;
  callerAuthority?: ActionExecutorContext['authority'];
  localId: string;
  actionRequestAttributionV1?: ActionRequestAttributionV1;
}>): Readonly<{
  localId: string;
  executionAuthority?: 'present_user';
  inputAdmission: Readonly<{
    provenance: SessionMessageProvenanceV1;
    request: SessionInputRequestV1;
  }>;
}> {
  const localId = params.localId;
  // Only an original human host invocation may establish a new requester.
  // Descendant input retains its admitted cause, never the host credential.
  const originalPresentUser = params.actionCaller.kind === 'host' && params.callerAuthority === 'present_user'
    && !params.actionRequestAttributionV1;

  const inputAdmission = params.actionCaller.kind === 'automationRun'
    ? buildAutomationSessionInputAdmissionV1({
        automationId: params.actionCaller.automationId,
        runId: params.actionCaller.runId,
      })
    : params.actionCaller.kind === 'plugin'
      ? buildPluginSessionInputAdmissionV1({ caller: params.actionCaller, surface: params.callerSurface })
      : buildHostCallerSessionInputAdmissionV1({ surface: params.callerSurface, authority: params.callerAuthority,
          descendant: !originalPresentUser });
  return Object.freeze({
    localId,
    ...(originalPresentUser ? { executionAuthority: 'present_user' as const } : {}),
    inputAdmission: params.actionRequestAttributionV1
      ? { ...inputAdmission, request: { ...inputAdmission.request,
          actionRequestAttributionV1: materializeActionRequestAttributionV1(params.actionRequestAttributionV1) } }
      : inputAdmission,
  });
}
