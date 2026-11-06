import { completeActionResult } from '../resultProjection.js';
import { MachinesAgentsSignInStartInputSchema, MachinesAgentsSignInStatusInputSchema, MachinesAgentsSignInCancelInputSchema } from '../../../daemon/agentSignIn.js';
import { DaemonAgentInstallStartRequestSchema, DaemonAgentInstallReadRequestSchema, DaemonAgentInstallCancelRequestSchema } from '../../../daemon/agentInstallJobs.js';
import { ScmDiffSummaryModelSelectorSchema } from '../../../scm/diffSummary.js';
import { resolveActionBackendTargetSelection } from '../../resolveActionBackendTargetSelection.js';
import { readOptionalString } from '../inputReading.js';
import { AgentInventoryProbeInputSchema } from '../../actionSpecs.js';
import { buildAgentInventorySelectionArgs } from '../../../inputs/inputOptions.js';
import { resolveProfileSkillSeedsAtAdmissionV1 } from '../agentStartAdmission.js';
import { SessionCapabilitiesGetInputV1Schema, SessionCapabilitiesGetOutputV1Schema, SessionCapabilitiesSetInputV1Schema, SessionCapabilitiesSetOutputV1Schema, SpawnCapabilitiesPreviewInputV1Schema, SpawnCapabilitiesPreviewOutputV1Schema } from '../../specs/sessionCapabilities.js';
import { setSessionCapabilityV1 } from '../sessionCapabilities.js';
import { SESSION_AGENT_TRANSITION_ACTION_INPUT_SCHEMAS } from '../../sessionAgentTransitionActionFamily.js';
import { resolveServerIdForSession } from '../sessionScope.js';
import type { CoreInvocation, DispatchFacts, PreparedCoreAdmission } from '../coreInvocation.js';
import type { ActionExecuteResult, ActionExecutorContext, ActionExecutorDeps } from '../types.js';



export async function dispatchAgentsCatalog(inv: Pick<CoreInvocation, 'actionId' | 'deps' | 'data' | 'parsed' | 'ctx'>): Promise<ActionExecuteResult | null> {
  const { actionId, deps, data, parsed, ctx } = inv;

        if (actionId === 'agents.backends.list') {
          if (!deps.agentsBackendsList) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const res = await deps.agentsBackendsList({
            ...(typeof data.includeDisabled === 'boolean' ? { includeDisabled: data.includeDisabled } : {}),
            ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
            ...((data.machineId) ? { machineId: String(data.machineId) } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'machines.agents.signIn.start') {
          if (!deps.machineAgentSignInStart) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
          const request = MachinesAgentsSignInStartInputSchema.parse(parsed.data);
          return completeActionResult(await deps.machineAgentSignInStart({ ...request,
            ...(ctx.serverId ? { serverId: ctx.serverId } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}),
          }), { treatReturnedErrorEnvelopeAsFailure: true });
        }
        if (actionId === 'machines.agents.signIn.status') {
          if (!deps.machineAgentSignInStatus) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
          return completeActionResult(await deps.machineAgentSignInStatus({
            ...MachinesAgentsSignInStatusInputSchema.parse(parsed.data),
            ...(ctx.serverId ? { serverId: ctx.serverId } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}),
          }, ctx));
        }
        if (actionId === 'machines.agents.signIn.cancel' || actionId === 'machines.agents.signIn.restart') {
          const operation = actionId === 'machines.agents.signIn.cancel' ? deps.machineAgentSignInCancel : deps.machineAgentSignInRestart;
          if (!operation) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
          return completeActionResult(await operation({ ...MachinesAgentsSignInCancelInputSchema.parse(parsed.data),
            ...(ctx.serverId ? { serverId: ctx.serverId } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}),
          }), { treatReturnedErrorEnvelopeAsFailure: true });
        }
        if (actionId === 'machines.agents.install' || actionId === 'machines.agents.uninstall') {
          if (!deps.machineAgentInstallStart) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
          const request = DaemonAgentInstallStartRequestSchema.parse({
            agentId: data.agentId, intent: actionId === 'machines.agents.uninstall' ? 'uninstall' : data.intent,
            ...(data.definitionId === undefined ? {} : { definitionId: data.definitionId }),
            consent: data.consent ?? { vendorRecipe: false },
            ...(data.force === undefined ? {} : { force: data.force }),
          });
          return completeActionResult(await deps.machineAgentInstallStart({
            ...request, machineId: String(data.machineId),
            ...(ctx.serverId ? { serverId: ctx.serverId } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }), { treatReturnedErrorEnvelopeAsFailure: true });
        }
        if (actionId === 'machines.agents.install.status') {
          if (!deps.machineAgentInstallRead) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
          const request = DaemonAgentInstallReadRequestSchema.parse({ jobId: data.jobId, cursor: data.cursor ?? 0 });
          return completeActionResult(await deps.machineAgentInstallRead({
            ...request, machineId: String(data.machineId),
            ...(ctx.serverId ? { serverId: ctx.serverId } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }), { treatReturnedErrorEnvelopeAsFailure: true });
        }
        if (actionId === 'machines.agents.install.cancel') {
          if (!deps.machineAgentInstallCancel) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
          const request = DaemonAgentInstallCancelRequestSchema.parse({ jobId: data.jobId });
          return completeActionResult(await deps.machineAgentInstallCancel({
            ...request, machineId: String(data.machineId),
            ...(ctx.serverId ? { serverId: ctx.serverId } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }), { treatReturnedErrorEnvelopeAsFailure: true });
        }

        if (actionId === 'agents.models.list') {
          if (!deps.agentsModelsList) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          if (data.purpose === 'scm_diff_summary') {
            return completeActionResult(await deps.agentsModelsList({ purpose: 'scm_diff_summary',
              ...(typeof data.discoveryTargetKey === 'string' ? { discoveryTargetKey: data.discoveryTargetKey } : {}),
              ...(data.modelSelector ? { modelSelector: ScmDiffSummaryModelSelectorSchema.parse(data.modelSelector) } : {}),
              machineId: String(data.machineId), ...(ctx.serverId ? { serverId: ctx.serverId } : {}),
              ...(ctx.signal ? { signal: ctx.signal } : {}) }, ctx));
          }
          const resolvedSelection = resolveActionBackendTargetSelection({
            agentId: readOptionalString(data.agentId),
            backendTargetKey: readOptionalString(data.backendTargetKey),
          });
          if (!resolvedSelection.ok) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const resolvedAgentId = resolvedSelection.selection.agentId;
          const backendTargetKey = resolvedSelection.selection.backendTargetKey;
          if (!resolvedAgentId && !backendTargetKey) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const res = await deps.agentsModelsList({
            ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}),
            ...((data.machineId) ? { machineId: String(data.machineId) } : {}),
            ...((ctx.serverId) ? { serverId: String(ctx.serverId) } : {}),
            ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
            ...(backendTargetKey ? { backendTargetKey } : {}),
            ...(data.probe === undefined ? {} : { probe: AgentInventoryProbeInputSchema.parse(data.probe) }),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }, ctx);
          return completeActionResult(res);
        }

        if (actionId === 'agents.config_options.list') {
          if (!deps.agentsConfigOptionsList) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:agents.config_options.list' };
          }
          const selectionArgs = await buildAgentInventorySelectionArgs({ deps, actionId: null, input: data });
          if ('ok' in selectionArgs) return selectionArgs;
          const res = await deps.agentsConfigOptionsList({
            ...selectionArgs,
            ...((data.machineId) ? { machineId: String(data.machineId) } : {}),
            ...((ctx.serverId) ? { serverId: String(ctx.serverId) } : {}),
            ...((data.modelId) ? { modelId: String(data.modelId) } : {}),
            ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
            ...(data.probe === undefined ? {} : { probe: AgentInventoryProbeInputSchema.parse(data.probe) }),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }, ctx);
          return completeActionResult(res);
        }

        if (actionId === 'agents.session_modes.list') {
          if (!deps.agentsSessionModesList) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:agents.session_modes.list' };
          }
          const selectionArgs = await buildAgentInventorySelectionArgs({ deps, actionId: null, input: data });
          if ('ok' in selectionArgs) return selectionArgs;
          const res = await deps.agentsSessionModesList({
            ...selectionArgs,
            ...((data.machineId) ? { machineId: String(data.machineId) } : {}),
            ...((ctx.serverId) ? { serverId: String(ctx.serverId) } : {}),
            ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
            ...(data.probe === undefined ? {} : { probe: AgentInventoryProbeInputSchema.parse(data.probe) }),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'sessions.spawn.profiles.list') {
          if (!deps.spawnProfilesList) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:sessions.spawn.profiles.list' };
          }
          const selectionArgs = await buildAgentInventorySelectionArgs({
            deps,
            actionId: null,
            input: data,
            agentScope: 'optional',
          });
          if ('ok' in selectionArgs) return selectionArgs;
          const res = await deps.spawnProfilesList({
            ...selectionArgs,
            ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'sessions.spawn.connected_services.list') {
          if (!deps.spawnConnectedServicesList) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:sessions.spawn.connected_services.list' };
          }
          const selectionArgs = await buildAgentInventorySelectionArgs({ deps, actionId: null, input: data });
          if ('ok' in selectionArgs) return selectionArgs;
          const res = await deps.spawnConnectedServicesList({
            ...selectionArgs,
            ...((data.machineId) ? { machineId: String(data.machineId) } : {}),
            ...((ctx.serverId) ? { serverId: String(ctx.serverId) } : {}),
            ...(typeof data.includeUnavailable === 'boolean' ? { includeUnavailable: data.includeUnavailable } : {}),
          }, ctx);
          return completeActionResult(res);
        }

        if (actionId === 'sessions.spawn.capabilities.preview') {
          if (!deps.spawnCapabilitiesPreview) return completeActionResult({ ok: false, reason: 'machine_unreachable' });
          const admitted = await resolveProfileSkillSeedsAtAdmissionV1(data, deps, ctx);
          if (!admitted.ok) return completeActionResult({ ok: false, reason: 'invalid_input' });
          ctx.signal?.throwIfAborted();
          return completeActionResult(SpawnCapabilitiesPreviewOutputV1Schema.parse(await deps.spawnCapabilitiesPreview(
            SpawnCapabilitiesPreviewInputV1Schema.parse(admitted.input), ctx)));
        }
        if (actionId === 'session.capabilities.get') {
          if (!deps.sessionCapabilitiesGet) return completeActionResult({ ok: false, code: 'session_unavailable' });
          return completeActionResult(SessionCapabilitiesGetOutputV1Schema.parse(await deps.sessionCapabilitiesGet(
            SessionCapabilitiesGetInputV1Schema.parse(parsed.data), ctx)));
        }
        if (actionId === 'session.capabilities.set') {
          if (!deps.sessionCapabilities) return completeActionResult({ ok: false, code: 'session_unavailable' });
          return completeActionResult(SessionCapabilitiesSetOutputV1Schema.parse(await setSessionCapabilityV1({
            port: deps.sessionCapabilities, request: SessionCapabilitiesSetInputV1Schema.parse(parsed.data), context: ctx,
          })));
        }
        if (actionId === 'sessions.spawn.mcp_servers.preview') {
          if (!deps.spawnMcpServersPreview) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:sessions.spawn.mcp_servers.preview' };
          }
          const selectionArgs = await buildAgentInventorySelectionArgs({ deps, actionId: null, input: data });
          if ('ok' in selectionArgs) return selectionArgs;
          const directory = typeof data.directory === 'string' && data.directory.trim().length > 0
            ? data.directory.trim()
            : typeof data.path === 'string' && data.path.trim().length > 0
              ? data.path.trim()
              : undefined;
          const res = await deps.spawnMcpServersPreview({
            ...selectionArgs,
            ...((data.machineId) ? { machineId: String(data.machineId) } : {}),
            ...(directory ? { directory } : {}),
            ...(Object.prototype.hasOwnProperty.call(data, 'selection') ? { selection: data.selection } : {}),
            ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
          }, ctx);
          return completeActionResult(res);
        }

        if (actionId === 'session.continuation.inspect') {
          if (!deps.sessionContinuationInspect) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
          const input = SESSION_AGENT_TRANSITION_ACTION_INPUT_SCHEMAS[actionId].parse(parsed.data);
          const serverId = resolveServerIdForSession(deps, ctx, input.sessionId);
          return completeActionResult(await deps.sessionContinuationInspect({ input, context: ctx,
            ...(serverId ? { serverId } : {}),
          }));
        }
  return null;
}
