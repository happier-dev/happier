import {
  type AgentSessionRealtimeConversation,
  type AgentSessionRealtimeHandle,
  type AgentSessionRealtimeLifecycleEvent,
  type AgentSessionRealtimeStopResult,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { raceWithTimeout } from '@happier-dev/plugin-sdk/async';
import {
  AgentSessionRealtimeInspectRequestV1Schema,
  AgentSessionRealtimeStartRequestV1Schema,
  AgentSessionRealtimeStartResultV1Schema,
  AgentSessionRealtimeStopRequestV1Schema,
  AgentSessionRealtimeWatchRequestV1Schema,
  type PluginContributionIdentityV1,
  type VoiceProviderContribution,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';

type ConversationDeclaration = Extract<
  VoiceProviderContribution,
  Readonly<{ kind: 'conversation' }>
>;

type ResolveDeclaration = (
  ref: PluginContributionIdentityV1,
) => ConversationDeclaration | null;

type Attempt = {
  authorityKey: string;
  happierSessionId: string;
  handle: AgentSessionRealtimeHandle;
  terminal: AgentSessionRealtimeLifecycleEvent | null;
  terminalConsumed: boolean;
  terminalWaiters: Set<(event: AgentSessionRealtimeLifecycleEvent) => void>;
  watchSubscription: Readonly<{ dispose(): void }> | null;
  retirementSubscription: Readonly<{
    signal: AbortSignal;
    listener: () => void;
  }> | null;
  disposed: boolean;
  cleanupPromise: Promise<AgentSessionRealtimeStopResult | null> | null;
};

type PendingAttempt = {
  happierSessionId: string;
  abortController: AbortController;
  stopRequested: boolean;
};

export type AgentSessionRealtimeVoiceAuthority = Readonly<{
  generation: string;
  policyAgentRef: PluginContributionIdentityV1;
  resolveDeclaration: ResolveDeclaration;
  isCurrent(provider: PluginContributionIdentityV1): boolean;
  resolveProviderGeneration(
    provider: PluginContributionIdentityV1,
  ): string | null;
  resolveRetirementSignal(
    provider: PluginContributionIdentityV1,
  ): AbortSignal | null;
  resolveConversation(input: Readonly<{
    provider: PluginContributionIdentityV1;
    runtime: unknown;
  }>): Readonly<{
    conversation: AgentSessionRealtimeConversation;
    retirementSignal: AbortSignal | null;
  }> | null;
}>;

const SAFE_DIAGNOSTIC_CODE_PATTERN = /^[a-z][a-z0-9_]{0,127}$/;
const OPERATION_ABORTED = Symbol('operation_aborted');
const AGENT_REALTIME_HANDLE_RETIRE_PHASE_TIMEOUT_MS = 5_000;

function stableDiagnosticCode(value: unknown, fallback: string): string {
  return typeof value === 'string' && SAFE_DIAGNOSTIC_CODE_PATTERN.test(value)
    ? value
    : fallback;
}

type UnavailableReason = NonNullable<
  Parameters<typeof unavailable>[3]
>;

function stableUnavailableReason(value: unknown): UnavailableReason {
  switch (value) {
    case 'authentication_required':
    case 'session_unavailable':
    case 'unsupported_runtime':
    case 'update_required':
    case 'feature_unavailable':
      return value;
    default:
      return 'session_unavailable';
  }
}

function stableTerminalReason(
  value: unknown,
): AgentSessionRealtimeLifecycleEvent['reason'] {
  switch (value) {
    case 'stopped':
    case 'upstream_closed':
    case 'agent_session_disposed':
    case 'aborted':
    case 'error':
      return value;
    default:
      return 'error';
  }
}

function unavailable(
  code: string,
  message: string,
  status: 'unavailable' | 'failed' = 'unavailable',
  reason?:
    | 'authentication_required'
    | 'session_unavailable'
    | 'unsupported_runtime'
    | 'update_required'
    | 'feature_unavailable',
) {
  return {
    ok: false as const,
    status,
    code,
    message,
    ...(reason ? { reason } : {}),
  };
}

function sanitizeTerminalEvent(
  event: AgentSessionRealtimeLifecycleEvent,
): AgentSessionRealtimeLifecycleEvent {
  const diagnostic = event.diagnostic;
  return Object.freeze({
    kind: 'terminal' as const,
    reason: stableTerminalReason(event.reason),
    ...(diagnostic
      ? {
          diagnostic: Object.freeze({
            code: stableDiagnosticCode(
              diagnostic.code,
              'agent_realtime_terminal_error',
            ),
            severity:
              diagnostic.severity === 'info'
              || diagnostic.severity === 'warning'
              || diagnostic.severity === 'error'
                ? diagnostic.severity
                : 'error',
          }),
        }
      : {}),
  });
}

function optionsFor(
  context?: RpcHandlerContext,
  ownedSignal?: AbortSignal,
): Readonly<{ signal?: AbortSignal }> {
  if (context && ownedSignal) {
    return { signal: AbortSignal.any([context.signal, ownedSignal]) };
  }
  if (context) return { signal: context.signal };
  return ownedSignal ? { signal: ownedSignal } : {};
}

function waitForOperationOrAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T | typeof OPERATION_ABORTED> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.resolve(OPERATION_ABORTED);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      resolve(OPERATION_ABORTED);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function retireHandleBestEffort(
  handle: AgentSessionRealtimeHandle,
): Promise<AgentSessionRealtimeStopResult | null> {
  const stopController = new AbortController();
  let stopResult: AgentSessionRealtimeStopResult | null = null;
  try {
    const outcome = await raceWithTimeout(
      Promise.resolve().then(() => handle.stop({
        signal: stopController.signal,
      })),
      AGENT_REALTIME_HANDLE_RETIRE_PHASE_TIMEOUT_MS,
    );
    if (outcome.type === 'resolved') {
      stopResult = outcome.value;
    } else if (outcome.type === 'timeout') {
      stopController.abort();
    }
  } catch {
    // Disposal remains mandatory when the bounded stop wait itself fails.
  } finally {
    await raceWithTimeout(
      Promise.resolve().then(() => handle.dispose()),
      AGENT_REALTIME_HANDLE_RETIRE_PHASE_TIMEOUT_MS,
    ).catch(() => undefined);
  }
  return stopResult;
}

export function registerAgentSessionRealtimeVoiceRpc(input: Readonly<{
  rpc: RpcHandlerRegistrar;
  runtime: unknown;
  getHappierSessionId: () => string;
  ownerId: string;
  agentGeneration: string;
  isGenerationCurrent: (provider: PluginContributionIdentityV1) => boolean;
  resolveProviderGeneration: (
    provider: PluginContributionIdentityV1,
  ) => string | null;
  resolveRetirementSignal: (
    provider: PluginContributionIdentityV1,
  ) => AbortSignal | null;
  resolveConversation(
    input: Readonly<{
      provider: PluginContributionIdentityV1;
      runtime: unknown;
    }>,
  ): Readonly<{
    conversation: AgentSessionRealtimeConversation;
    retirementSignal: AbortSignal | null;
  }> | null;
}>): Readonly<{ dispose(): void }> {
  const attempts = new Map<string, Attempt>();
  const pendingAttempts = new Map<string, PendingAttempt>();
  let disposed = false;
  const attemptAuthorityKey = (
    happierSessionId: string,
    provider: PluginContributionIdentityV1,
    applicationAttemptId: string,
  ): string => JSON.stringify([
    happierSessionId,
    input.ownerId,
    input.agentGeneration,
    input.resolveProviderGeneration(provider) ?? 'provider-generation-unavailable',
    provider.pluginId,
    provider.localId,
    applicationAttemptId,
  ]);
  const resolveRuntime = (provider: PluginContributionIdentityV1) => {
    if (disposed) return null;
    if (!input.isGenerationCurrent(provider)) {
      return null;
    }
    if (!input.resolveProviderGeneration(provider)) return null;
    return input.resolveConversation({
      provider,
      runtime: input.runtime,
    });
  };
  const detachRetirementSubscription = (attempt: Attempt): void => {
    if (!attempt.retirementSubscription) return;
    attempt.retirementSubscription.signal.removeEventListener(
      'abort',
      attempt.retirementSubscription.listener,
    );
    attempt.retirementSubscription = null;
  };
  const ensureAttemptCleanup = (
    attempt: Attempt,
    options: Readonly<{
      stop: 'none' | 'required' | 'best_effort';
    }>,
  ): Promise<AgentSessionRealtimeStopResult | null> => {
    if (attempt.cleanupPromise) return attempt.cleanupPromise;
    attempt.cleanupPromise = (async () => {
      if (options.stop === 'best_effort') {
        attempt.disposed = true;
        return await retireHandleBestEffort(attempt.handle);
      }
      attempt.disposed = true;
      try {
        return options.stop === 'required'
          ? await Promise.resolve().then(() => attempt.handle.stop())
          : null;
      } finally {
        await Promise.resolve()
          .then(() => attempt.handle.dispose())
          .catch(() => undefined);
      }
    })();
    return attempt.cleanupPromise;
  };
  const finishAttempt = (
    attempt: Attempt,
    event: AgentSessionRealtimeLifecycleEvent,
    options: Readonly<{
      cleanupStop?: 'none' | 'best_effort';
    }> = {},
  ): void => {
    if (attempt.terminal) return;
    attempt.terminal = event;
    try {
      attempt.watchSubscription?.dispose();
    } catch {
      // Provider cleanup cannot prevent host-owned terminal settlement.
    }
    attempt.watchSubscription = null;
    detachRetirementSubscription(attempt);
    const waiters = [...attempt.terminalWaiters];
    attempt.terminalWaiters.clear();
    for (const resolve of waiters) resolve(event);
    void ensureAttemptCleanup(attempt, {
      stop: options.cleanupStop ?? 'none',
    }).catch(() => undefined);
  };
  const consumeAttemptAfterCleanup = (attempt: Attempt): Promise<void> => {
    attempt.terminalConsumed = true;
    return ensureAttemptCleanup(attempt, { stop: 'none' }).then(
      () => {
        if (attempts.get(attempt.authorityKey) === attempt) {
          attempts.delete(attempt.authorityKey);
        }
      },
      () => {
        if (attempts.get(attempt.authorityKey) === attempt) {
          attempts.delete(attempt.authorityKey);
        }
      },
    );
  };
  const retireStaleAttempts = (happierSessionId: string): void => {
    for (const pendingAttempt of pendingAttempts.values()) {
      if (pendingAttempt.happierSessionId === happierSessionId) continue;
      pendingAttempt.stopRequested = true;
      pendingAttempt.abortController.abort();
    }
    for (const [authorityKey, attempt] of attempts) {
      if (attempt.happierSessionId === happierSessionId) continue;
      attempts.delete(authorityKey);
      finishAttempt(attempt, {
        kind: 'terminal',
        reason: 'agent_session_disposed',
      }, { cleanupStop: 'best_effort' });
    }
  };

  input.rpc.registerHandler(
    SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_INSPECT,
    async (raw: unknown, context?: RpcHandlerContext) => {
      const parsed = AgentSessionRealtimeInspectRequestV1Schema.safeParse(raw);
      if (!parsed.success) {
        return unavailable('invalid_parameters', 'Invalid Agent realtime inspection request.');
      }
      retireStaleAttempts(input.getHappierSessionId());
      const resolved = resolveRuntime(parsed.data.provider);
      if (!resolved) {
        return unavailable(
          'agent_realtime_declaration_unavailable',
          'The selected Voice contribution does not resolve to this session Agent.',
          'unavailable',
          'unsupported_runtime',
        );
      }
      let inspected;
      try {
        inspected = await resolved.conversation.inspect(
          optionsFor(context, resolved.retirementSignal ?? undefined),
        );
      } catch {
        return unavailable(
          'agent_realtime_inspect_failed',
          'Agent realtime inspection failed.',
        );
      }
      if (inspected.status === 'unavailable') {
        return unavailable(
          stableDiagnosticCode(
            inspected.diagnostic.code,
            'agent_realtime_inspect_failed',
          ),
          'Agent realtime is unavailable.',
          'unavailable',
          stableUnavailableReason(inspected.reason),
        );
      }
      if (inspected.status !== 'available' || inspected.transport !== 'webrtc') {
        return unavailable(
          'agent_realtime_inspect_failed',
          'Agent realtime inspection failed.',
        );
      }
      return {
        ok: true as const,
        status: 'available' as const,
        transport: 'webrtc' as const,
      };
    },
  );

  input.rpc.registerHandler(
    SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START,
    async (raw: unknown, context?: RpcHandlerContext) => {
      const parsed = AgentSessionRealtimeStartRequestV1Schema.safeParse(raw);
      if (!parsed.success) {
        return unavailable('invalid_parameters', 'Invalid Agent realtime start request.');
      }
      const happierSessionId = input.getHappierSessionId();
      retireStaleAttempts(happierSessionId);
      const resolved = resolveRuntime(parsed.data.provider);
      if (!resolved) {
        return unavailable(
          'agent_realtime_declaration_unavailable',
          'The selected Voice contribution does not resolve to this session Agent.',
          'unavailable',
          'unsupported_runtime',
        );
      }
      const authorityKey = attemptAuthorityKey(
        happierSessionId,
        parsed.data.provider,
        parsed.data.applicationAttemptId,
      );
      if (
        pendingAttempts.has(authorityKey)
        || attempts.has(authorityKey)
      ) {
        return { ok: true as const, status: 'busy' as const };
      }
      const pendingAttempt: PendingAttempt = {
        happierSessionId,
        abortController: new AbortController(),
        stopRequested: false,
      };
      pendingAttempts.set(authorityKey, pendingAttempt);
      const startSignal = resolved.retirementSignal
        ? AbortSignal.any([
            pendingAttempt.abortController.signal,
            resolved.retirementSignal,
          ])
        : pendingAttempt.abortController.signal;
      const startOptions = optionsFor(context, startSignal);
      try {
        let started;
        try {
          started = await resolved.conversation.start(
            { transport: parsed.data.transport },
            startOptions,
          );
        } catch (error) {
          if (pendingAttempt.stopRequested || startOptions.signal?.aborted) {
            return { ok: true as const, status: 'aborted' as const };
          }
          return unavailable(
            'agent_realtime_start_failed',
            'Agent realtime start failed.',
            'failed',
          );
        }
        if (pendingAttempt.stopRequested || startOptions.signal?.aborted) {
          if (started.status === 'started') {
            await retireHandleBestEffort(started.handle);
          }
          return { ok: true as const, status: 'aborted' as const };
        }
        if (started.status !== 'started') {
          if (started.status === 'unavailable' || started.status === 'failed') {
            return unavailable(
              stableDiagnosticCode(
                started.diagnostic.code,
                'agent_realtime_start_failed',
              ),
              'Agent realtime start failed.',
              started.status,
            );
          }
          if (started.status === 'busy' || started.status === 'aborted') {
            return { ok: true as const, status: started.status };
          }
          return unavailable(
            'agent_realtime_start_failed',
            'Agent realtime start failed.',
            'failed',
          );
        }
        if (
          input.getHappierSessionId() !== happierSessionId
          || !input.isGenerationCurrent(parsed.data.provider)
          || resolved.retirementSignal?.aborted
        ) {
          await retireHandleBestEffort(started.handle);
          return { ok: true as const, status: 'aborted' as const };
        }
        const startResponse = AgentSessionRealtimeStartResultV1Schema.safeParse({
          ok: true,
          status: 'started',
          transport: started.transport,
        });
        if (!startResponse.success) {
          await retireHandleBestEffort(started.handle);
          return unavailable(
            'agent_realtime_answer_invalid',
            'Agent realtime returned an invalid WebRTC answer.',
            'failed',
          );
        }
        const attempt: Attempt = {
          authorityKey,
          happierSessionId,
          handle: started.handle,
          terminal: null,
          terminalConsumed: false,
          terminalWaiters: new Set(),
          watchSubscription: null,
          retirementSubscription: null,
          disposed: false,
          cleanupPromise: null,
        };
        attempts.set(authorityKey, attempt);
        let subscription;
        try {
          subscription = started.handle.watch((event) => {
            finishAttempt(attempt, sanitizeTerminalEvent(event));
          });
        } catch {
          attempts.delete(authorityKey);
          await retireHandleBestEffort(started.handle);
          return unavailable(
            'agent_realtime_watch_failed',
            'Agent realtime watch failed.',
            'failed',
          );
        }
        if (attempt.terminal) {
          try {
            subscription.dispose();
          } catch {
            // Terminal settlement already owns cleanup.
          }
        } else {
          attempt.watchSubscription = subscription;
        }
        const retireAttempt = () => {
          if (attempts.get(authorityKey) !== attempt) return;
          finishAttempt(attempt, {
            kind: 'terminal',
            reason: 'agent_session_disposed',
          }, { cleanupStop: 'best_effort' });
        };
        if (resolved.retirementSignal) {
          attempt.retirementSubscription = {
            signal: resolved.retirementSignal,
            listener: retireAttempt,
          };
          resolved.retirementSignal.addEventListener(
            'abort',
            retireAttempt,
            { once: true },
          );
          if (resolved.retirementSignal.aborted) {
            retireAttempt();
            await consumeAttemptAfterCleanup(attempt);
            return { ok: true as const, status: 'aborted' as const };
          }
        }
        return {
          ...startResponse.data,
        };
      } finally {
        if (pendingAttempts.get(authorityKey) === pendingAttempt) {
          pendingAttempts.delete(authorityKey);
        }
      }
    },
  );

  input.rpc.registerHandler(
    SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_WATCH,
    async (raw: unknown, context?: RpcHandlerContext) => {
      const parsed = AgentSessionRealtimeWatchRequestV1Schema.safeParse(raw);
      if (!parsed.success) {
        return unavailable('invalid_parameters', 'Invalid Agent realtime watch request.');
      }
      const happierSessionId = input.getHappierSessionId();
      retireStaleAttempts(happierSessionId);
      const authorityKey = attemptAuthorityKey(
        happierSessionId,
        parsed.data.provider,
        parsed.data.applicationAttemptId,
      );
      const attempt = attempts.get(authorityKey);
      const canConsumeRetainedTerminal = Boolean(
        attempt?.terminal && !attempt.terminalConsumed
      );
      if (!canConsumeRetainedTerminal && !resolveRuntime(parsed.data.provider)) {
        return unavailable(
          'agent_realtime_declaration_unavailable',
          'The selected Voice contribution does not resolve to this session Agent.',
          'unavailable',
          'unsupported_runtime',
        );
      }
      if (!attempt || attempt.terminalConsumed) {
        return unavailable(
          'agent_realtime_attempt_unavailable',
          'The Agent realtime attempt is unavailable.',
        );
      }
      const event = attempt.terminal ?? await new Promise<AgentSessionRealtimeLifecycleEvent>(
        (resolve, reject) => {
          const signal = context?.signal;
          const settle = (terminal: AgentSessionRealtimeLifecycleEvent) => {
            signal?.removeEventListener('abort', onAbort);
            resolve(terminal);
          };
          const onAbort = () => {
            signal?.removeEventListener('abort', onAbort);
            attempt.terminalWaiters.delete(settle);
            reject(new Error('agent_realtime_watch_aborted'));
          };
          if (signal?.aborted) {
            onAbort();
            return;
          }
          attempt.terminalWaiters.add(settle);
          signal?.addEventListener('abort', onAbort, { once: true });
          if (signal?.aborted) onAbort();
        },
      );
      void consumeAttemptAfterCleanup(attempt);
      return { ok: true as const, status: 'terminal' as const, event };
    },
  );

  input.rpc.registerHandler(
    SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_STOP,
    async (raw: unknown, context?: RpcHandlerContext) => {
      const parsed = AgentSessionRealtimeStopRequestV1Schema.safeParse(raw);
      if (!parsed.success) {
        return unavailable('invalid_parameters', 'Invalid Agent realtime stop request.');
      }
      const happierSessionId = input.getHappierSessionId();
      retireStaleAttempts(happierSessionId);
      if (!resolveRuntime(parsed.data.provider)) {
        return unavailable(
          'agent_realtime_declaration_unavailable',
          'The selected Voice contribution does not resolve to this session Agent.',
          'unavailable',
          'unsupported_runtime',
        );
      }
      const authorityKey = attemptAuthorityKey(
        happierSessionId,
        parsed.data.provider,
        parsed.data.applicationAttemptId,
      );
      const pendingAttempt = pendingAttempts.get(authorityKey);
      if (pendingAttempt) {
        if (pendingAttempt.stopRequested) {
          return { ok: true as const, status: 'already_stopped' as const };
        }
        pendingAttempt.stopRequested = true;
        pendingAttempt.abortController.abort();
        return { ok: true as const, status: 'stopped' as const };
      }
      const attempt = attempts.get(authorityKey);
      if (!attempt) {
        return { ok: true as const, status: 'already_stopped' as const };
      }
      if (attempt.terminal) {
        const cleanupOutcome = await waitForOperationOrAbort(
          consumeAttemptAfterCleanup(attempt),
          context?.signal,
        );
        if (cleanupOutcome === OPERATION_ABORTED) {
          return { ok: true as const, status: 'aborted' as const };
        }
        return { ok: true as const, status: 'already_stopped' as const };
      }
      const cleanup = ensureAttemptCleanup(attempt, { stop: 'required' });
      let stopped: AgentSessionRealtimeStopResult | null;
      try {
        const stopOutcome = await waitForOperationOrAbort(
          cleanup,
          context?.signal,
        );
        if (stopOutcome === OPERATION_ABORTED) {
          finishAttempt(attempt, {
            kind: 'terminal',
            reason: 'aborted',
          });
          void consumeAttemptAfterCleanup(attempt);
          return { ok: true as const, status: 'aborted' as const };
        }
        stopped = stopOutcome;
      } catch {
        finishAttempt(attempt, {
          kind: 'terminal',
          reason: 'error',
        });
        void consumeAttemptAfterCleanup(attempt);
        return unavailable(
          'agent_realtime_stop_unavailable',
          'Agent realtime stop is unavailable.',
        );
      }
      if (!stopped) {
        finishAttempt(attempt, {
          kind: 'terminal',
          reason: 'error',
        });
        void consumeAttemptAfterCleanup(attempt);
        return unavailable(
          'agent_realtime_stop_unavailable',
          'Agent realtime stop is unavailable.',
        );
      }
      if (stopped.status === 'unavailable') {
        finishAttempt(attempt, {
          kind: 'terminal',
          reason: 'error',
        });
        void consumeAttemptAfterCleanup(attempt);
        return unavailable(
          stableDiagnosticCode(
            stopped.diagnostic.code,
            'agent_realtime_stop_unavailable',
          ),
          'Agent realtime stop is unavailable.',
        );
      }
      if (
        stopped.status !== 'stopped'
        && stopped.status !== 'already_stopped'
        && stopped.status !== 'aborted'
      ) {
        finishAttempt(attempt, {
          kind: 'terminal',
          reason: 'error',
        });
        void consumeAttemptAfterCleanup(attempt);
        return unavailable(
          'agent_realtime_stop_unavailable',
          'Agent realtime stop is unavailable.',
        );
      }
      finishAttempt(attempt, {
        kind: 'terminal',
        reason: stopped.status === 'aborted' ? 'aborted' : 'stopped',
      });
      await consumeAttemptAfterCleanup(attempt);
      return { ok: true as const, status: stopped.status };
    },
  );

  return Object.freeze({
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const pendingAttempt of pendingAttempts.values()) {
        pendingAttempt.stopRequested = true;
        pendingAttempt.abortController.abort();
      }
      pendingAttempts.clear();
      for (const [authorityKey, attempt] of attempts) {
        attempts.delete(authorityKey);
        finishAttempt(attempt, {
          kind: 'terminal',
          reason: 'agent_session_disposed',
        }, { cleanupStop: 'best_effort' });
      }
    },
  });
}
