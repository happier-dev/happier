import {
  PluginContributionLocalIdSchema,
  PluginIdSchema,
  PluginSessionInputSourceV1Schema,
  SessionInputRequestV1Schema,
  SessionMessageProvenanceV1Schema,
  buildSessionSpawnInitialInputLocalIdV1,
  readPendingLocalId,
  type ActionPluginCaller,
  type ActionCaller,
  type ActionSurfaces,
  type PluginInvocationSurfaceV1,
  type PluginSessionInputSourceV1,
  type SessionInputRequestV1,
  type SessionMessageProvenanceV1,
} from '@happier-dev/protocol';

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

export function buildHostSessionInputAdmissionV1(
  surface: keyof ActionSurfaces | null | undefined,
): Readonly<{
  provenance: SessionMessageProvenanceV1;
  request: SessionInputRequestV1;
}> {
  const producer = surface === 'ui'
    ? 'happierApp' as const
    : surface === 'cli'
      ? 'cli' as const
      : surface === 'voice'
        ? 'voiceInput' as const
        : surface === 'mcp'
          ? 'happierMcp' as const
          : 'sessionAction' as const;
  const provenance = surface === 'cli'
    ? { v: 1 as const, kind: 'cli' as const }
    : surface === 'voice'
      ? { v: 1 as const, kind: 'voice' as const }
      : { v: 1 as const, kind: 'host' as const, producer };
  return Object.freeze({
    // The Action context cannot prove an Account relationship. Keep this as
    // host-stamped modality; the server receipt owns owner/collaborator truth.
    provenance: SessionMessageProvenanceV1Schema.parse(provenance),
    request: SessionInputRequestV1Schema.parse({
      v: 1,
      producer,
      caller: { kind: 'host' },
      permission: {},
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
 * Message-owned composition for Session creation's one deterministic initial
 * input. Its identity follows the Session creation tag, while protected
 * attribution retains the authenticated caller supplied by the Action owner.
 */
export function buildSessionSpawnInitialInputAdmissionV1(params: Readonly<{
  actionCaller: ActionCaller;
  callerSurface?: keyof ActionSurfaces | null;
  sessionId: string;
  sessionCreationTag: string;
}>): Readonly<{
  localId: string;
  inputAdmission: Readonly<{
    provenance: SessionMessageProvenanceV1;
    request: SessionInputRequestV1;
  }>;
}> {
  const localId = buildSessionSpawnInitialInputLocalIdV1({
    sessionId: params.sessionId,
    sessionCreationTag: params.sessionCreationTag,
  });

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

  const inputAdmission = buildHostSessionInputAdmissionV1(params.callerSurface);
  return Object.freeze({
    localId,
    inputAdmission,
  });
}
