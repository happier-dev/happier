import { AgentRuntimeJsonValueV1Schema } from '@happier-dev/protocol/runtime';
import { TurnIdSchema, type SessionInputCausalPermissionAuthorityV1 } from '@happier-dev/protocol';
import type { HostCurrentSessionInteractionsService as PluginCurrentSessionInteractionsService } from '@/agent/runtime/state/currentSessionUiTypes';

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
      const requestId = params.resolveRequestId(toolCallId);
      if (!requestId) {
        return abortDecision('ACP permission request has no active public turn');
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
        return abortDecision('ACP permission request turn custody is unavailable');
      }
      if (hasTurnIdResolver && !turnId) {
        return abortDecision('ACP permission request turn custody is unavailable');
      }
      let causalPermissionAuthority: SessionInputCausalPermissionAuthorityV1 | null = null;
      try {
        causalPermissionAuthority = params.resolveCausalPermissionAuthority?.(toolCallId) ?? null;
      } catch {
        return abortDecision('ACP permission request causal authority is unavailable');
      }
      // Current public ACP sessions always install the active-turn reader. A
      // null result therefore means that this provider request cannot be tied
      // to an admitted input, not that it is a legacy host operation.
      if (hasCausalPermissionAuthorityResolver && !causalPermissionAuthority) {
        return abortDecision('ACP permission request causal authority is unavailable');
      }
      const permissionContext = context?.origin || causalPermissionAuthority || turnId
        ? Object.freeze({
            ...(context?.origin ? { origin: context.origin } : {}),
            ...(turnId ? { turnId } : {}),
            ...(causalPermissionAuthority ? { causalPermissionAuthority } : {}),
          })
        : undefined;

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
          ...(permissionContext ? { permissionContext } : {}),
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

    async abortPendingRequestsAndFlush() {
      const snapshot = [...pending];
      for (const entry of snapshot) entry.controller.abort();
      await Promise.all(snapshot.map((entry) => entry.settled));
    },
  });
}
