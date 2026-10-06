import { buildTrustedHostSessionInputAdmissionV1, PluginSessionInputSourceV1Schema, SessionInputCausalPermissionAuthorityV1Schema, SessionInputRequestV1Schema, SessionInputRequestV2Schema, SessionInputWorkflowV2Schema, SessionInputSourceSessionV1Schema, SessionMessageProvenanceV2Schema, requiresAuthenticatedMachineAdmissionForSessionInput } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { PluginContributionLocalIdSchema } from '@happier-dev/protocol/plugins/contribution-identity';
import { PluginIdSchema } from '@happier-dev/protocol/plugins/plugin-id';
import { SessionMessageProvenanceV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { readPendingLocalId } from '@happier-dev/protocol/sessions/pending/pendingLocalId';
import type { ActionPluginCaller, ActionCaller, ActionSurfaces, ExternalActionExecutionAuthorizationV1, PluginInvocationSurfaceV1, PluginSessionInputSourceV1, SessionInputCausalPermissionAuthorityV1, SessionInputRequestV1, SessionInputRequestV2, SessionInputRequest, SessionInputSourceAuthorityV1, SessionInputWorkflowV2, SessionMessageProvenanceV1, SessionMessageProvenanceV2 } from '@happier-dev/protocol';

export { deriveWorkflowSessionInputLocalIdV2 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';

/** Protected E2EE equality and authenticated caller facts require the Machine seam. */
export function requiresMachineAdmissionForSessionInput(params: Readonly<{
  request: SessionInputRequest | null;
  mode: 'plain' | 'e2ee';
  callerInputAuthorization?: ExternalActionExecutionAuthorizationV1;
}>): boolean {
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
    sourceAuthority?: SessionInputSourceAuthorityV1;
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
    }),
    request: SessionInputRequestV2Schema.parse({
      v: 2,
      producer: 'workflow',
      caller: { kind: 'host' },
      ...(options.sourceAuthority ? { sourceAuthority: options.sourceAuthority } : {}),
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
  callerDepth: number;
  via: 'action' | 'mcp';
  causalPermissionAuthority: SessionInputCausalPermissionAuthorityV1;
}>): Readonly<{
  provenance: SessionMessageProvenanceV1;
  request: SessionInputRequestV1;
}> {
  const sourceSession = SessionInputSourceSessionV1Schema.parse({
    sourceSessionId: params.sourceSessionId,
    sourceTurnId: params.sourceTurnId,
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

/** Host-private admission for a spawn handoff whose durable local id is already sealed. */
export function buildSessionSpawnInitialInputAdmissionForLocalIdV1(params: Readonly<{
  actionCaller: ActionCaller;
  callerSurface?: keyof ActionSurfaces | null;
  localId: string;
}>): Readonly<{
  localId: string;
  inputAdmission: Readonly<{
    provenance: SessionMessageProvenanceV1;
    request: SessionInputRequestV1;
  }>;
}> {
  const localId = params.localId;

  if (params.actionCaller.kind === 'automationRun') {
    return Object.freeze({
      localId,
      inputAdmission: buildAutomationSessionInputAdmissionV1({
        automationId: params.actionCaller.automationId,
        runId: params.actionCaller.runId,
      }),
    });
  }

  if (params.actionCaller.kind === 'plugin') {
    const pluginId = PluginIdSchema.parse(params.actionCaller.pluginId);
    const contributionLocalId = PluginContributionLocalIdSchema.parse(
      params.actionCaller.contributionLocalId,
    );
    const inputAdmission = buildPluginSessionInputAdmissionV1({
      caller: { kind: 'plugin', pluginId, contributionLocalId },
      surface: params.callerSurface,
    });
    return Object.freeze({
      localId,
      inputAdmission,
    });
  }

  const inputAdmission = buildTrustedHostSessionInputAdmissionV1(params.callerSurface);
  return Object.freeze({
    localId,
    inputAdmission,
  });
}
