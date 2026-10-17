import { randomUUID } from 'node:crypto';
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
} from '@agentclientprotocol/sdk';
import {
  MAX_INTERACTION_TRANSIENT_PROMPT_CODE_POINTS_V1,
  MAX_INTERACTION_TRANSIENT_TITLE_OR_LABEL_CODE_POINTS_V1,
  type SessionInputCausalPermissionAuthorityV1,
} from '@happier-dev/protocol';
import { AgentRuntimeJsonValueV1Schema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { TurnIdSchema } from '@happier-dev/protocol/sessions/idsV1';
import type { HostCurrentSessionInteractionsService as PluginCurrentSessionInteractionsService } from '@/agent/runtime/state/currentSessionUiTypes';
import { isWorkflowInteractionCapacityError } from '@/agent/permissions/interactionPersistenceError';
import {
  clampToMaxCodePoints,
  mcpElicitationFormContent,
  mcpElicitationFormQuestions,
  parseMcpElicitationFormSchema,
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
          origin?: 'host_acp_fs_write';
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
        }, {
          signal: AbortSignal.any([params.signal, controller.signal]),
          ...(custody.permissionContext ? { permissionContext: custody.permissionContext } : {}),
        });

        if (result.status === 'declined') {
          return Object.freeze({ decision: 'denied' as const });
        }
        if (result.status !== 'approved') {
          return abortDecision();
        }

        return Object.freeze({
          decision: result.persistence === 'session' ? 'approved_for_session' as const : 'approved' as const,
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
      if (request.mode !== 'form') {
        return Object.freeze({ action: 'cancel' as const });
      }
      const toolCallId =
        typeof request.toolCallId === 'string' && request.toolCallId.trim().length > 0
          ? request.toolCallId.trim()
          : `elicitation:${randomUUID()}`;
      const custody = resolveTurnCustody(toolCallId, context);
      if (!custody.ok) {
        return Object.freeze({ action: 'cancel' as const });
      }

      let schema: ReturnType<typeof parseMcpElicitationFormSchema>;
      let questions: ReturnType<typeof mcpElicitationFormQuestions>;
      try {
        schema = parseMcpElicitationFormSchema(request.requestedSchema);
        questions = mcpElicitationFormQuestions(schema, {
          message: request.message,
        });
      } catch {
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
      try {
        if (questions === null) {
          const result = await params.interactions.request(
            {
              kind: 'confirmation',
              title: 'Confirmation',
              message: request.message.trim() || 'Confirmation',
            },
            {
              signal: AbortSignal.any([params.signal, controller.signal]),
              ...(custody.permissionContext ? { permissionContext: custody.permissionContext } : {}),
            },
          );
          if (result.status === 'approved') {
            return Object.freeze({ action: 'accept' as const, content: {} });
          }
          if (result.status === 'declined') {
            return Object.freeze({ action: 'decline' as const });
          }
          return Object.freeze({ action: 'cancel' as const });
        }

        const trimmedMessage = request.message.trim();
        const alreadyContainedInPrompt = questions.some((q) => q.prompt.includes(trimmedMessage));
        const shouldIncludeTitle =
          trimmedMessage.length > 0
          && !alreadyContainedInPrompt
          && Array.from(trimmedMessage).length <= MAX_INTERACTION_TRANSIENT_TITLE_OR_LABEL_CODE_POINTS_V1;

        let finalQuestions = questions;
        if (
          trimmedMessage.length > 0
          && !alreadyContainedInPrompt
          && Array.from(trimmedMessage).length > MAX_INTERACTION_TRANSIENT_TITLE_OR_LABEL_CODE_POINTS_V1
        ) {
          const first = questions[0];
          const combinedPrompt = clampToMaxCodePoints(
            `${trimmedMessage}\n\n${first.prompt}`,
            MAX_INTERACTION_TRANSIENT_PROMPT_CODE_POINTS_V1,
          );
          finalQuestions = [
            Object.freeze({ ...first, prompt: combinedPrompt }),
            ...questions.slice(1),
          ] as unknown as typeof questions;
        }

        const result = await params.interactions.request(
          {
            kind: 'questions',
            ...(shouldIncludeTitle ? { title: trimmedMessage } : {}),
            questions: finalQuestions,
          },
          {
            signal: AbortSignal.any([params.signal, controller.signal]),
            ...(custody.permissionContext ? { permissionContext: custody.permissionContext } : {}),
          },
        );
        if (result.status !== 'answered') {
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
