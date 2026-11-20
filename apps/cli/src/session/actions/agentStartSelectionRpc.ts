import { lazyZodSchema } from '@happier-dev/protocol/lazyZodSchema';
import { z } from 'zod/mini';
import { AgentStartSessionCallerV1Schema } from '@happier-dev/protocol/account/settings/admitAgentStartV1';
import { BackendTargetRefV2Schema, PersistedAgentTargetRefV1Schema } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { ConnectedServiceBindingsV2Schema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { ProviderBoundModelRefSchema } from '@happier-dev/protocol/providers/model-selection';
import { TeamCredentialProviderModelSelectionV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SessionActionRpcOriginV1Schema } from '@happier-dev/protocol/socketRpc';
import type { RpcHandlerRegistrar } from '../../api/rpc/types';
import type { NativeAgentSessionInteractionHostBinding } from '../../agent/runtime/registry/engineRegistryTypes';
import { ConnectedServiceAppliedParentSelectionUnavailableSchema } from '../../daemon/connectedServices/runs/materializeContract';

const turnIdSchema = lazyZodSchema(() => SessionActionRpcOriginV1Schema.shape.sourceTurnId);
// Validate closure before canonical legacy refinements: an intersection can
// accept keys rejected by only one of its branches.
const backendTargetSchema = lazyZodSchema(() => z.union([
  z.pipe(z.strictObject(BackendTargetRefV2Schema.shape), BackendTargetRefV2Schema),
  PersistedAgentTargetRefV1Schema,
]));
const selectionSchema = z.discriminatedUnion('status', [
  ConnectedServiceAppliedParentSelectionUnavailableSchema,
  z.strictObject({ status: z.literal('applied'), backendTarget: backendTargetSchema,
    modelId: z.nullable(z.string()), modelSelection: z.optional(ProviderBoundModelRefSchema),
    teamCredentialModel: z.optional(TeamCredentialProviderModelSelectionV1Schema),
    connectedServices: z.nullable(ConnectedServiceBindingsV2Schema) }),
]);

export const SessionAgentStartSelectionRequestV1Schema = z.strictObject({ turnId: turnIdSchema });
export const SessionAgentStartSelectionResponseV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: AgentStartSessionCallerV1Schema.shape.sessionId, turnId: turnIdSchema, selection: selectionSchema,
}));

/** Reads the existing native owner; registration never manufactures a baseline. */
export function registerSessionAgentStartSelectionRpc(
  rpc: RpcHandlerRegistrar,
  sessionId: string | null,
  host: NativeAgentSessionInteractionHostBinding | undefined,
): () => void {
  let active = true;
  if (sessionId) rpc.registerHandler(SESSION_RPC_METHODS.SESSION_AGENT_START_SELECTION_READ_V1,
    async (request: unknown, context) => {
      const parsed = SessionAgentStartSelectionRequestV1Schema.safeParse(request);
      if (!parsed.success) return { errorCode: 'RPC_INVALID_PARAMS', error: 'Invalid params' };
      const turnId = parsed.data.turnId;
      const unavailable = () => ({ sessionId, turnId, selection: { status: 'unavailable' as const } });
      const isCurrent = () => {
        // Approval can follow the proposal turn's completion. This owner-only
        // read returns the live Session selection; turnId correlates the reply.
        try { return active && host?.session.sessionId === sessionId; }
        catch { return false; }
      };
      context?.signal.throwIfAborted();
      if (!isCurrent() || !host?.readAppliedChildSelection) return unavailable();
      let selection: unknown;
      try { selection = await host.readAppliedChildSelection(); }
      catch { context?.signal.throwIfAborted(); return unavailable(); }
      context?.signal.throwIfAborted();
      const result = selectionSchema.safeParse(selection);
      return isCurrent() && result.success ? { sessionId, turnId, selection: result.data } : unavailable();
    });
  return () => { active = false; };
}
