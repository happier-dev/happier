import { AgentRuntimeJsonValueV1Schema } from '@happier-dev/protocol/runtime';
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
          requestId,
          title: `Allow ${toolName}?`,
          subject: Object.freeze({
            kind: 'tool',
            name: toolName,
            input: parsedInput.data,
          }),
          allowedPersistenceScopes: ['session'],
        }, {
          signal: AbortSignal.any([params.signal, controller.signal]),
          ...(context?.origin === 'host_acp_fs_write'
            ? { permissionContext: { origin: context.origin } }
            : {}),
        });

        if (result.status === 'denied') {
          return Object.freeze({ decision: 'denied' as const });
        }
        if (result.status !== 'approved') {
          return abortDecision(result.diagnostic?.message);
        }

        const effects = result.effects;
        if (effects?.replaceInput !== undefined
          || effects?.permissionModeId !== undefined
          || effects?.followUp !== undefined) {
          return abortDecision('The approval contains effects ACP cannot apply safely');
        }
        const persisted = effects?.persistApprovals ?? [];
        if (persisted.some((approval) => (
          approval.scope !== 'session'
          || approval.toolName !== undefined && approval.toolName !== toolName
        ))) {
          return abortDecision('The approval persistence does not match this ACP tool request');
        }

        return Object.freeze({
          decision: persisted.length > 0 ? 'approved_for_session' as const : 'approved' as const,
          ...(result.rationale ? { rationale: result.rationale } : {}),
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
