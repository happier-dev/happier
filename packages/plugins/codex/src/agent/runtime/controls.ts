import type {
  AgentSessionCatalogControl,
  AgentSessionContinuationControl,
  AgentSessionControlContext,
  AgentSessionGoalControl,
  AgentSessionGoalControlContext,
  AgentSessionUsageLimitRecoveryControl,
} from '@happier-dev/plugin-sdk/agent-runtime';

import {
  listCodexAppServerSkills,
  listCodexVendorPlugins,
} from './appServer/catalog/index.js';
import { createCodexNativeAppServerClient } from './appServer/client.js';
import { decodeCodexAppServerGoal } from './appServer/work/goalCodec.js';
import {
  isCodexRateLimitSnapshotExhausted,
  readEarliestCodexRateLimitResetAtMs,
} from '../auth/services/quota/rateLimitSnapshot.js';
import { readCodexRuntimeRateLimitsSnapshot } from '../auth/services/quota/runtimeRateLimits.js';

type RecordLike = Readonly<Record<string, unknown>>;
type GoalPayload =
  | Readonly<{ kind: 'present'; goal: RecordLike }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'malformed' }>;

function record(value: unknown): RecordLike | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordLike : null;
}

function diagnostic(code: string, message = code) {
  return { code, severity: 'error' as const, message };
}

async function withControlClient<T>(
  context: AgentSessionControlContext,
  run: (client: Awaited<ReturnType<typeof createCodexNativeAppServerClient>>) => Promise<T>,
): Promise<T> {
  const client = await createCodexNativeAppServerClient({
    exec: context.services.exec,
    cwd: context.session.cwd,
    processEnv: {},
    signal: context.signal,
  });
  try {
    return await run(client);
  } finally {
    await client.dispose().catch(() => undefined);
  }
}

function readGoal(value: unknown): GoalPayload {
  const root = record(value);
  if (!root) return { kind: 'malformed' };
  if (typeof root.objective === 'string') return { kind: 'present', goal: root };
  if (!Object.prototype.hasOwnProperty.call(root, 'goal') || root.goal === null || root.goal === undefined) {
    return { kind: 'absent' };
  }
  const goal = record(root.goal);
  return goal ? { kind: 'present', goal } : { kind: 'malformed' };
}

function createGoalControl(): AgentSessionGoalControl {
  let sourceSequence = 0;
  const publish = async (payload: GoalPayload, context: AgentSessionGoalControlContext) => {
    if (payload.kind === 'malformed') {
      return {
        status: 'unavailable' as const,
        retryable: false,
        diagnostic: diagnostic('codex_goal_payload_invalid'),
      };
    }
    const decoded = payload.kind === 'absent'
      ? null
      : decodeCodexAppServerGoal({ backendId: 'codex', goal: payload.goal });
    if (payload.kind === 'present' && decoded === null) {
      return {
        status: 'unavailable' as const,
        retryable: false,
        diagnostic: diagnostic('codex_goal_payload_invalid'),
      };
    }
    const observedAtMs = decoded?.updatedAt ?? Date.now();
    const outcome = await context.goalSource.publish({
      sourceSequence: ++sourceSequence,
      observedAtMs,
      items: decoded ? [{
        localId: decoded.id,
        kind: decoded.kind,
        origin: decoded.origin,
        status: decoded.status,
        ...(decoded.statusReason ? { statusReason: decoded.statusReason } : {}),
        title: decoded.title,
        providerRef: decoded.vendorRef,
        ...(Object.prototype.hasOwnProperty.call(decoded, 'tokenBudget')
          ? { tokenBudget: decoded.tokenBudget }
          : {}),
        ...(typeof decoded.tokensUsed === 'number' ? { tokensUsed: decoded.tokensUsed } : {}),
        ...(typeof decoded.timeUsedSeconds === 'number'
          ? { timeUsedSeconds: decoded.timeUsedSeconds }
          : {}),
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
      diagnostic: 'diagnostic' in outcome
        ? outcome.diagnostic
        : diagnostic('codex_goal_publication_failed'),
    };
  };
  return {
    async get(context) {
      const threadId = context.session.providerSessionId;
      if (!threadId) return { status: 'unavailable', retryable: false, diagnostic: diagnostic('codex_goal_thread_unavailable') };
      try {
        const response = await withControlClient(context, async (client) => await client.request('thread/goal/get', { threadId }));
        return await publish(readGoal(response), context);
      } catch {
        return { status: 'unavailable', retryable: true, diagnostic: diagnostic('codex_goal_read_failed') };
      }
    },
    async set(mutation, context) {
      const threadId = context.session.providerSessionId;
      if (!threadId) return { status: 'unavailable', retryable: false, diagnostic: diagnostic('codex_goal_thread_unavailable') };
      try {
        const response = await withControlClient(context, async (client) => await client.request('thread/goal/set', {
          threadId,
          ...mutation,
        }));
        return await publish(readGoal(response), context);
      } catch {
        return { status: 'unavailable', retryable: true, diagnostic: diagnostic('codex_goal_write_failed') };
      }
    },
    async clear(context) {
      const threadId = context.session.providerSessionId;
      if (!threadId) return { status: 'unavailable', retryable: false, diagnostic: diagnostic('codex_goal_thread_unavailable') };
      try {
        await withControlClient(context, async (client) => await client.request('thread/goal/clear', { threadId }));
        return await publish({ kind: 'absent' }, context);
      } catch {
        return { status: 'unavailable', retryable: true, diagnostic: diagnostic('codex_goal_clear_failed') };
      }
    },
  };
}

const catalog: AgentSessionCatalogControl = {
  async list(request, context) {
    try {
      return await withControlClient(context, async (client) => {
        if (request.kind === 'vendorPlugins') {
          const result = await listCodexVendorPlugins({ client, cwd: context.session.cwd });
          if (!result.supported) return { status: 'unsupported' as const, diagnostic: diagnostic('codex_vendor_catalog_unsupported') };
          return {
            status: 'ok' as const,
            kind: 'vendorPlugins' as const,
            items: result.vendorPlugins.map((item) => ({
              id: item.vendorPluginRef,
              name: item.name,
              displayName: item.displayName,
              ...(item.description ? { description: item.description } : {}),
              installed: item.installed,
              enabled: item.enabled,
              mentionable: item.mentionable,
            })),
          };
        }
        const result = await listCodexAppServerSkills({ client, cwd: context.session.cwd });
        if (!result.supported) return { status: 'unsupported' as const, diagnostic: diagnostic('codex_skill_catalog_unsupported') };
        return {
          status: 'ok' as const,
          kind: 'skills' as const,
          items: result.skills.map((item) => ({
            id: item.id,
            name: item.name,
            displayName: item.displayName ?? item.name,
            ...(item.description ? { description: item.description } : {}),
            path: item.path,
            enabled: item.enabled,
          })),
        };
      });
    } catch {
      return { status: 'unavailable', retryable: true, diagnostic: diagnostic('codex_catalog_read_failed') };
    }
  },
};

const usageLimitRecovery: AgentSessionUsageLimitRecoveryControl = {
  async execute(request, context) {
    if (request.kind !== 'checkNow') {
      return { status: 'unsupported', diagnostic: diagnostic('codex_reset_credit_unsupported') };
    }
    try {
      const snapshot = await withControlClient(context, async (client) => (
        await readCodexRuntimeRateLimitsSnapshot(client)
      ).rawSnapshot);
      if (!isCodexRateLimitSnapshotExhausted(snapshot)) return { status: 'ready' };
      const resetAtMs = readEarliestCodexRateLimitResetAtMs(snapshot);
      return {
        status: 'waiting',
        ...(resetAtMs === null ? {} : { retryAfterMs: Math.max(0, resetAtMs - Date.now()) }),
      };
    } catch {
      return { status: 'unavailable', retryable: true, diagnostic: diagnostic('codex_usage_limit_probe_failed') };
    }
  },
};

const continuation: AgentSessionContinuationControl = {
  async verify(request, context) {
    const providerSessionId = request.kind === 'resume'
      ? request.providerSessionId
      : request.source.providerSessionId;
    try {
      await withControlClient(context, async (client) => await client.request('thread/read', {
        threadId: providerSessionId,
        includeTurns: false,
      }));
      return { status: 'reachable' };
    } catch {
      return { status: 'unreachable', diagnostic: diagnostic('codex_continuation_unreachable') };
    }
  },
};

export function createCodexNativeSessionControls() {
  return Object.freeze({
    goals: createGoalControl(),
    catalog,
    usageLimitRecovery,
    continuation,
  });
}
