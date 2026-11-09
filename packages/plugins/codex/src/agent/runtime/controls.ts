import type {
  AgentSessionCatalogControl,
  AgentSessionContinuationControl,
  AgentSessionControlContext,
  AgentSessionGoalControl,
  AgentSessionGoalControlContext,
  AgentSessionUsageLimitRecoveryControl,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { PluginError } from '@happier-dev/plugin-sdk';
import {
  readUnexpectedActionErrorDiagnosticV1,
  projectSessionGoalControlDiagnosticDetails,
  type SessionGoalControlDiagnosticStage,
} from '@happier-dev/protocol/actions/actionExecutionResult';

import {
  readCodexSessionCatalog,
  type CodexSessionCatalogReader,
} from './appServer/catalog/index.js';
import { createCodexNativeAppServerClient } from './appServer/client.js';
import { isCodexAppServerApplicationRejectionForMethod } from './appServer/compatibility.js';
import {
  createCodexGoalProjection,
  readCodexGoalPayload,
  type CodexGoalProjection,
} from './appServer/work/goalProjection.js';
import {
  isCodexRateLimitSnapshotExhausted,
  readEarliestCodexRateLimitResetAtMs,
} from '../auth/services/quota/rateLimitSnapshot.js';
import { readCodexRuntimeRateLimitsSnapshot } from '../auth/services/quota/runtimeRateLimits.js';

function diagnostic(code: string, message = code) {
  return { code, severity: 'error' as const, message };
}

function readGoalRefusalCondition(error: unknown, stage: SessionGoalControlDiagnosticStage) {
  if (!stage.startsWith('thread/goal/') || !(error instanceof Error)
    || !isCodexAppServerApplicationRejectionForMethod(error, stage)
    || !('code' in error) || error.code !== -32600) return 'unclassified';
  // rust-v0.162.1 thread_goal_processor.rs: the same RPC code covers feature,
  // lookup and ownership failures. Never project native prose or thread ids.
  if (error.message === 'goals feature is disabled') return 'goals_disabled';
  if (error.message.startsWith('thread not found: ')) return 'thread_not_found';
  if (error.message.startsWith('ephemeral thread does not support goals: ')) return 'ephemeral_thread';
  if (error.message === 'thread metadata does not match requested id') return 'thread_identity_mismatch';
  return 'unclassified';
}

function goalFailureResult(
  context: AgentSessionControlContext,
  code: string,
  error: unknown,
  stage: SessionGoalControlDiagnosticStage,
  phase: 'native_effect' | 'host_publication_rejected',
) {
  const condition = readGoalRefusalCondition(error, stage);
  const details = projectSessionGoalControlDiagnosticDetails(stage, error);
  context.services.logger?.debug('Codex Goal control failed', { condition, ...details });
  if (condition === 'goals_disabled') {
    return { status: 'unsupported' as const,
      diagnostic: { ...diagnostic('codex_goals_disabled'), details }, goalControlFailure: { phase } };
  }
  return { status: 'unavailable' as const, retryable: true,
    diagnostic: { ...diagnostic(code), details }, goalControlFailure: { phase } };
}

async function withControlClient<T>(
  context: AgentSessionControlContext,
  run: (client: Awaited<ReturnType<typeof createCodexNativeAppServerClient>>) => Promise<T>,
  onInitialize?: () => void,
): Promise<T> {
  const processEnv = context.session.launchEnvironment?.values;
  if (!processEnv) throw new PluginError({ code: 'codex_control_launch_scope_unavailable',
    message: 'The target Session native launch environment is unavailable' });
  const client = await createCodexNativeAppServerClient({
    exec: context.services.exec,
    logger: context.services.logger,
    cwd: context.session.cwd,
    processEnv,
    signal: context.signal,
    ...(onInitialize ? { onInitialize } : {}),
  });
  try {
    return await run(client);
  } finally {
    await client.dispose().catch(() => undefined);
  }
}

/** Native status-only writes preserve the provider's objective, budget and counters. */
export function setCodexGoal(
  client: Pick<Awaited<ReturnType<typeof createCodexNativeAppServerClient>>, 'request'>,
  threadId: string,
  mutation: Parameters<AgentSessionGoalControl['set']>[0],
  signal?: AbortSignal,
): Promise<unknown> {
  return client.request('thread/goal/set', { threadId, ...mutation }, { signal });
}

export function createCodexGoalControl(
  goalProjection: CodexGoalProjection,
  withClient: typeof withControlClient = async (context, run, onInitialize) => {
    if (context.session.activity === 'active') throw new PluginError({ code: 'codex_live_goal_runtime_unavailable',
      message: 'Live Goals require the target Session runtime control' });
    return await withControlClient(context, run, onInitialize);
  },
): AgentSessionGoalControl {
  return {
    async get(context) {
      const threadId = context.session.providerSessionId;
      if (!threadId) return { status: 'unavailable', retryable: false, diagnostic: diagnostic('codex_goal_thread_unavailable'), goalControlFailure: { phase: 'native_effect' } };
      let phase: 'native_effect' | 'host_publication_rejected' = 'native_effect';
      let stage: SessionGoalControlDiagnosticStage = 'client_creation';
      try {
        const response = await withClient(context, async (client) => {
          stage = 'thread/goal/get';
          return await client.request('thread/goal/get', { threadId }, { signal: context.signal });
        }, () => { stage = 'initialize'; });
        phase = 'host_publication_rejected';
        stage = 'host_publication';
        return await goalProjection.publish(readCodexGoalPayload(response), context.goalSource);
      } catch (error) {
        return goalFailureResult(context, 'codex_goal_read_failed', error, stage, phase);
      }
    },
    async set(mutation, context) {
      const threadId = context.session.providerSessionId;
      if (!threadId) return { status: 'unavailable', retryable: false, diagnostic: diagnostic('codex_goal_thread_unavailable'), goalControlFailure: { phase: 'native_effect' } };
      let phase: 'native_effect' | 'host_publication_rejected' = 'native_effect';
      let stage: SessionGoalControlDiagnosticStage = 'client_creation';
      try {
        const response = await withClient(context, async (client) => {
          stage = 'thread/goal/set';
          return await setCodexGoal(client, threadId, mutation, context.signal);
        }, () => { stage = 'initialize'; });
        phase = 'host_publication_rejected';
        stage = 'host_publication';
        return await goalProjection.publish(readCodexGoalPayload(response), context.goalSource);
      } catch (error) {
        return goalFailureResult(context, 'codex_goal_write_failed', error, stage, phase);
      }
    },
    async clear(context) {
      const threadId = context.session.providerSessionId;
      if (!threadId) return { status: 'unavailable', retryable: false, diagnostic: diagnostic('codex_goal_thread_unavailable'), goalControlFailure: { phase: 'native_effect' } };
      let phase: 'native_effect' | 'host_publication_rejected' = 'native_effect';
      let stage: SessionGoalControlDiagnosticStage = 'client_creation';
      try {
        await withClient(context, async (client) => {
          stage = 'thread/goal/clear';
          await client.request('thread/goal/clear', { threadId }, { signal: context.signal });
        }, () => { stage = 'initialize'; });
        phase = 'host_publication_rejected';
        stage = 'host_publication';
        return await goalProjection.publish({ kind: 'absent' }, context.goalSource);
      } catch (error) {
        return goalFailureResult(context, 'codex_goal_clear_failed', error, stage, phase);
      }
    },
  };
}

const createCatalog = (readSessionCatalog: (sessionId: string) => CodexSessionCatalogReader | undefined): AgentSessionCatalogControl => ({
  async list(request, context) {
    let phase: 'startup' | 'request' = 'startup';
    try {
      const readLiveCatalog = readSessionCatalog(context.session.id);
      if (readLiveCatalog) {
        phase = 'request';
        return await readLiveCatalog(request, { signal: context.signal });
      }
      return await withControlClient(context, async (client) => {
        phase = 'request';
        return await readCodexSessionCatalog(request, {
          client: { request: (method, params) => client.request(method, params, { signal: context.signal }) },
          cwd: context.session.cwd,
        });
      });
    } catch (error) {
      const { errorClass, errorCode, httpStatus } = readUnexpectedActionErrorDiagnosticV1(error);
      const details = { phase, errorClass, errorCode, httpStatus };
      context.services.logger.warn('codex_catalog_read_failed', details);
      return { status: 'unavailable', retryable: true,
        diagnostic: { ...diagnostic(`codex_catalog_${phase}_failed`), details } };
    }
  },
});

export function createCodexUsageLimitRecoveryControl(
  withClient: typeof withControlClient = withControlClient,
): AgentSessionUsageLimitRecoveryControl {
  return {
    async execute(request, context) {
      if (request.kind !== 'checkNow') {
        return { status: 'unsupported', diagnostic: diagnostic('codex_reset_credit_unsupported') };
      }
      try {
        const snapshot = await withClient(context, async (client) => (
          await readCodexRuntimeRateLimitsSnapshot({
            request: (method, params) => client.request(method, params, { signal: context.signal }),
          })
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
}

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
    } catch (error) {
      const { errorClass, errorCode, httpStatus } = readUnexpectedActionErrorDiagnosticV1(error);
      const details = { errorClass, errorCode, httpStatus };
      // Required verification is refused before sessions.open. Record the safe
      // cause here, before the host replaces this diagnostic with exit 78.
      context.services.logger.warn('codex_continuation_unreachable', details);
      return { status: 'unreachable', diagnostic: { ...diagnostic('codex_continuation_unreachable'), details } };
    }
  },
};

export function createCodexNativeSessionControls(
  goalProjection: CodexGoalProjection = createCodexGoalProjection(),
) {
  // The runtime owns its native client, delivered roots and disposal.
  const catalogReaders = new Map<string, CodexSessionCatalogReader>();
  return Object.freeze({
    goals: createCodexGoalControl(goalProjection),
    catalog: createCatalog(sessionId => catalogReaders.get(sessionId)),
    usageLimitRecovery: createCodexUsageLimitRecoveryControl(),
    continuation,
    bindSessionCatalog(sessionId: string, readCatalog: CodexSessionCatalogReader) {
      catalogReaders.set(sessionId, readCatalog);
      return () => {
        if (catalogReaders.get(sessionId) === readCatalog) catalogReaders.delete(sessionId);
      };
    },
  });
}

export type CodexSessionCatalogBinder = ReturnType<typeof createCodexNativeSessionControls>['bindSessionCatalog'];
