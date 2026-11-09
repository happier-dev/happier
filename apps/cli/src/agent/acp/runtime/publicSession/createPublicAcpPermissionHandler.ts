import { randomUUID } from 'node:crypto';
import {
  CreateElicitationRequest,
  type CreateElicitationResponse,
} from '@agentclientprotocol/sdk';
import {
  type SessionInputCausalPermissionAuthorityV1,
} from '@happier-dev/protocol';
import { AgentRuntimeJsonValueV1Schema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { TurnIdSchema } from '@happier-dev/protocol/sessions/idsV1';
import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import type { HostCurrentSessionInteractionsService as PluginCurrentSessionInteractionsService } from '@/agent/runtime/state/currentSessionUiTypes';
import { isWorkflowInteractionCapacityError } from '@/agent/permissions/interactionPersistenceError';
import { logger } from '@/ui/logger';
import {
  mcpElicitationFormContent,
  mcpElicitationFormRequest,
  parseAcpElicitationFormSchema,
} from '@/plugins/runtime/invocation/services/mcpElicitationForm';

import type {
  AcpPermissionCallContext,
  AcpPermissionDecisionResult,
  AcpPermissionHandler,
} from '@/agent/acp/permissions/acpPermissionHandler';

function abortDecision(rationale?: string): AcpPermissionDecisionResult {
  return Object.freeze({
    decision: 'abort' as const,
    ...(rationale ? { rationale } : {}),
  });
}

export function createPublicAcpPermissionHandler(params: Readonly<{
  interactions: PluginCurrentSessionInteractionsService;
  signal: AbortSignal;
  resolveRequestId(toolCallId: string): string | null;
  /** Returns only the current active turn's host-stamped identity. */
  resolveTurnId?(toolCallId: string): string | null;
  /** Returns only the current active turn's host-stamped admitted-input authority. */
  resolveCausalPermissionAuthority?(toolCallId: string): SessionInputCausalPermissionAuthorityV1 | null;
}>): AcpPermissionHandler {
  const pending = new Set<Readonly<{
    controller: AbortController;
    settled: Promise<void>;
    resolveSettled(): void;
  }>>();

  const resolveTurnCustody = (
    toolCallId: string,
    context?: AcpPermissionCallContext,
  ):
    | Readonly<{
        ok: true;
        requestId: string;
        permissionContext?: Readonly<{
          origin?: AcpPermissionCallContext['origin'];
          turnId?: string;
          causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
        }>;
      }>
    | Readonly<{ ok: false; rationale: string }> => {
    const requestId = params.resolveRequestId(toolCallId);
    if (!requestId) {
      return { ok: false, rationale: 'ACP permission request has no active public turn' };
    }
    const hasCausalPermissionAuthorityResolver =
      typeof params.resolveCausalPermissionAuthority === 'function';
    const hasTurnIdResolver = typeof params.resolveTurnId === 'function';
    let turnId: string | null = null;
    try {
      const candidate = params.resolveTurnId?.(toolCallId) ?? null;
      const parsedTurnId = TurnIdSchema.safeParse(candidate);
      turnId = parsedTurnId.success ? parsedTurnId.data : null;
    } catch {
      return { ok: false, rationale: 'ACP permission request turn custody is unavailable' };
    }
    if (hasTurnIdResolver && !turnId) {
      return { ok: false, rationale: 'ACP permission request turn custody is unavailable' };
    }
    let causalPermissionAuthority: SessionInputCausalPermissionAuthorityV1 | null = null;
    try {
      causalPermissionAuthority = params.resolveCausalPermissionAuthority?.(toolCallId) ?? null;
    } catch {
      return { ok: false, rationale: 'ACP permission request causal authority is unavailable' };
    }
    // Current public ACP sessions always install the active-turn reader. A
    // null result therefore means that this provider request cannot be tied
    // to an admitted input, not that it is a legacy host operation.
    if (hasCausalPermissionAuthorityResolver && !causalPermissionAuthority) {
      return { ok: false, rationale: 'ACP permission request causal authority is unavailable' };
    }
    const permissionContext = context?.origin || causalPermissionAuthority || turnId
      ? Object.freeze({
          ...(context?.origin ? { origin: context.origin } : {}),
          ...(turnId ? { turnId } : {}),
          ...(causalPermissionAuthority ? { causalPermissionAuthority } : {}),
        })
      : undefined;

    return {
      ok: true,
      requestId,
      ...(permissionContext ? { permissionContext } : {}),
    };
  };

  return Object.freeze({
    async handleToolCall(
      toolCallId: string,
      toolName: string,
      input: unknown,
      context?: AcpPermissionCallContext,
    ) {
      const parsedInput = AgentRuntimeJsonValueV1Schema.safeParse(input);
      if (!parsedInput.success) {
        return abortDecision('ACP tool input is not valid bounded JSON');
      }
      const custody = resolveTurnCustody(toolCallId, context);
      if (!custody.ok) {
        return abortDecision(custody.rationale);
      }

      const controller = new AbortController();
      let resolveSettled!: () => void;
      const entry = Object.freeze({
        controller,
        settled: new Promise<void>((resolve) => { resolveSettled = resolve; }),
        resolveSettled: () => resolveSettled(),
      });
      pending.add(entry);
      try {
        const result = await params.interactions.request({
          kind: 'approval',
          title: `Allow ${toolName}?`,
          subject: Object.freeze({
            kind: 'tool',
            name: toolName,
            input: parsedInput.data,
          }),
          allowSessionPersistence: true,
          ...(context?.nativeChoices ? { nativeChoices: context.nativeChoices } : {}),
        }, {
          signal: AbortSignal.any([params.signal, controller.signal]),
          ...(custody.permissionContext ? { permissionContext: custody.permissionContext } : {}),
        });

        if (result.status === 'declined') {
          return Object.freeze({ decision: 'denied' as const, ...(result.nativeChoice ? { nativeChoice: result.nativeChoice } : {}) });
        }
        if (result.status !== 'approved') {
          return abortDecision();
        }

        return Object.freeze({
          decision: result.persistence === 'session' ? 'approved_for_session' as const : 'approved' as const,
          ...(result.nativeChoice ? { nativeChoice: result.nativeChoice } : {}),
        });
      } catch (error) {
        return abortDecision(error instanceof Error ? error.message : undefined);
      } finally {
        pending.delete(entry);
        entry.resolveSettled();
      }
    },

    async handleElicitation(
      request: CreateElicitationRequest,
      context?: AcpPermissionCallContext,
    ): Promise<CreateElicitationResponse> {
      if (request.mode !== 'form' || context?.signal?.aborted || params.signal.aborted) {
        return Object.freeze({ action: 'cancel' as const });
      }
      if (!CreateElicitationRequest.isForm(request)) {
        logger.warn('[ACP] Form elicitation schema could not be presented');
        return Object.freeze({ action: 'cancel' as const });
      }
      const toolCallId = readNonBlankOpaqueIdentifier('toolCallId' in request ? request.toolCallId : null)
        ?? `elicitation:${randomUUID()}`;
      const custody = resolveTurnCustody(toolCallId, context);
      if (!custody.ok) {
        return Object.freeze({ action: 'cancel' as const });
      }

      // ACP cancellation withdraws this native request; it does not detach a durable Session question.
      const permissionContext = Object.freeze({
        ...custody.permissionContext,
        origin: 'host_occurrence_question' as const,
        lifetime: 'occurrence' as const,
      });
      let schema: ReturnType<typeof parseAcpElicitationFormSchema>;
      let interaction: ReturnType<typeof mcpElicitationFormRequest>;
      try {
        schema = parseAcpElicitationFormSchema(request.requestedSchema);
        interaction = mcpElicitationFormRequest(schema, request.message);
      } catch {
        logger.warn('[ACP] Form elicitation schema could not be presented');
        return Object.freeze({ action: 'cancel' as const });
      }

      const controller = new AbortController();
      let resolveSettled!: () => void;
      const entry = Object.freeze({
        controller,
        settled: new Promise<void>((resolve) => { resolveSettled = resolve; }),
        resolveSettled: () => resolveSettled(),
      });
      pending.add(entry);
      const signal = AbortSignal.any([params.signal, controller.signal, ...(context?.signal ? [context.signal] : [])]);
      try {
        if (interaction.kind === 'confirmation') {
          const result = await params.interactions.request(
            interaction,
            {
              signal,
              permissionContext,
            },
          );
          if (signal.aborted) return Object.freeze({ action: 'cancel' as const });
          if (result.status === 'approved') {
            return Object.freeze({ action: 'accept' as const, content: {} });
          }
          if (result.status === 'declined') {
            return Object.freeze({ action: 'decline' as const });
          }
          return Object.freeze({ action: 'cancel' as const });
        }

        const result = await params.interactions.request(
          interaction,
          {
            signal,
            permissionContext,
          },
        );
        if (signal.aborted || result.status !== 'answered') {
          return Object.freeze({ action: 'cancel' as const });
        }
        return Object.freeze({
          action: 'accept' as const,
          content: mcpElicitationFormContent(schema, result.answers),
        });
      } catch (error) {
        if (isWorkflowInteractionCapacityError(error)) {
          throw error;
        }
        if (!signal.aborted) logger.warn('[ACP] Form elicitation presentation failed');
        return Object.freeze({ action: 'cancel' as const });
      } finally {
        pending.delete(entry);
        entry.resolveSettled();
      }
    },

    async abortPendingRequestsAndFlush() {
      const snapshot = [...pending];
      for (const entry of snapshot) entry.controller.abort();
      await Promise.all(snapshot.map((entry) => entry.settled));
    },
  });
}
