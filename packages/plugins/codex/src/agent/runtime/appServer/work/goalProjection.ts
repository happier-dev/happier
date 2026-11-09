import type { AgentSessionGoalRefreshResult, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';

import { decodeCodexAppServerGoal } from './goalCodec.js';

type RecordLike = Readonly<Record<string, unknown>>;
type WorkStatePublisher = ReturnType<AgentSessionRuntimeContext['workState']['publisher']>;

export type CodexGoalPayload =
  | Readonly<{ kind: 'present'; goal: RecordLike }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'malformed' }>;

function diagnostic(code: string) {
  return { code, severity: 'error' as const, message: code };
}

export function readCodexGoalPayload(value: unknown): CodexGoalPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'malformed' };
  const root = value as RecordLike;
  if (typeof root.objective === 'string') return { kind: 'present', goal: root };
  // The native Goal read contract requires an explicit nullable goal. A
  // missing field (including a ThreadResumeResponse) is not evidence of Clear.
  if (!Object.prototype.hasOwnProperty.call(root, 'goal')) return { kind: 'malformed' };
  if (root.goal === null) return { kind: 'absent' };
  return root.goal && typeof root.goal === 'object' && !Array.isArray(root.goal)
    ? { kind: 'present', goal: root.goal as RecordLike }
    : { kind: 'malformed' };
}

export function createCodexGoalProjection() {
  let sourceSequence = 0;
  return Object.freeze({
    async publish(payload: CodexGoalPayload, goalSource: WorkStatePublisher): Promise<AgentSessionGoalRefreshResult> {
      if (payload.kind === 'malformed') {
        return { status: 'unavailable' as const, retryable: false, diagnostic: diagnostic('codex_goal_payload_invalid'), goalControlFailure: { phase: 'native_effect' as const } };
      }
      const decoded = payload.kind === 'absent'
        ? null
        : decodeCodexAppServerGoal({ backendId: 'codex', goal: payload.goal });
      if (payload.kind === 'present' && decoded === null) {
        return { status: 'unavailable' as const, retryable: false, diagnostic: diagnostic('codex_goal_payload_invalid'), goalControlFailure: { phase: 'native_effect' as const } };
      }
      const outcome = await goalSource.publish({
        sourceSequence: ++sourceSequence,
        observedAtMs: decoded?.updatedAt ?? Date.now(),
        items: decoded ? [{
          localId: decoded.id,
          kind: decoded.kind,
          origin: decoded.origin,
          status: decoded.status,
          ...(decoded.statusReason ? { statusReason: decoded.statusReason } : {}),
          title: decoded.title,
          providerRef: decoded.vendorRef,
          ...(Object.prototype.hasOwnProperty.call(decoded, 'tokenBudget') ? { tokenBudget: decoded.tokenBudget } : {}),
          ...(typeof decoded.tokensUsed === 'number' ? { tokensUsed: decoded.tokensUsed } : {}),
          ...(typeof decoded.timeUsedSeconds === 'number' ? { timeUsedSeconds: decoded.timeUsedSeconds } : {}),
          ...(typeof decoded.createdAt === 'number' ? { createdAtMs: decoded.createdAt } : {}),
          updatedAtMs: decoded.updatedAt,
        }] : [],
        ...(decoded ? { primaryLocalId: decoded.id } : {}),
      });
      if (outcome.status === 'applied' || outcome.status === 'unchanged') {
        return { status: outcome.status, revision: outcome.revision } as const;
      }
      if (outcome.status === 'ignoredStale') return { status: 'unchanged' as const, revision: outcome.revision };
      return {
        status: 'unavailable' as const,
        retryable: true,
        diagnostic: 'diagnostic' in outcome ? outcome.diagnostic : diagnostic('codex_goal_publication_failed'),
        goalControlFailure: { phase: 'host_publication_rejected' as const },
      };
    },
  });
}

export type CodexGoalProjection = ReturnType<typeof createCodexGoalProjection>;
