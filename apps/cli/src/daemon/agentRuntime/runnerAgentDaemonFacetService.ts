import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { PluginContributionIdentityV1 } from '@happier-dev/protocol';

import {
  AgentRuntimeDaemonExternalSessionFollowEventV1Schema,
  RunnerAgentDaemonExternalSessionFollowProviderRequestV1Schema,
  RunnerAgentDaemonFacetResultV1Schema,
  type RunnerAgentDaemonExternalSessionFollowProviderRequestV1,
  type RunnerAgentDaemonExternalSessionFollowProviderResponseV1,
  type RunnerAgentDaemonFacetOperationV1,
  type RunnerAgentDaemonFacetResultV1,
} from '@/agent/runtime/session/process/agentRuntimeDaemonFacetProtocol';
import type {
  AgentSessionRunnerBindingV1,
} from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import type {
  ExternalSessionHostOperationOwner,
  ExternalSessionHostOperationPort,
} from '@/session/external/hostOperationOwner';
import type {
  HostExternalTranscriptFollowEvent,
} from '@/session/external/privateContract';
import type {
  AgentRuntimeDaemonServiceTurnWitnessV1,
} from '@/agent/runtime/session/process/agentRuntimeDaemonServiceTurnWitness';
import type {
  RunnerAgentExternalSessionProviderOps,
} from '@/agent/runtime/registry/engineRegistry/types';
import type {
  ConfiguredExternalSessionSourceAgentContribution,
} from '@/session/external/configuredSourceMaterializer';
import type {
  AgentRuntimeDaemonServiceAuthorityRunnerIdentity,
} from './sessionBridgeAuthorization';

type VoiceSnapshot = Extract<
  RunnerAgentDaemonFacetResultV1,
  { kind: 'voice.authority.snapshot' }
>;

type FollowEventResult = Extract<
  RunnerAgentDaemonFacetResultV1,
  { kind: 'external_session.follow.event' }
>;

type FollowOpenResult = Extract<
  RunnerAgentDaemonFacetResultV1,
  { kind: 'external_session.follow.open' }
>;

type FollowProviderRequestResult = Extract<
  RunnerAgentDaemonFacetResultV1,
  { kind: 'external_session.follow.provider_request' }
>;

type FollowProgressResult =
  | FollowOpenResult
  | FollowProviderRequestResult
  | FollowEventResult
  | Extract<
      RunnerAgentDaemonFacetResultV1,
      { kind: 'external_session.follow.closed' }
    >;

type FollowWaiter = Readonly<{
  resolve(result: FollowProgressResult): void;
  reject(error: unknown): void;
  signal?: AbortSignal;
  onAbort?: () => void;
}>;

type PendingFollowEvent = Readonly<{
  result: FollowEventResult;
  acknowledge(): void;
}>;

type PendingProviderRequest = Readonly<{
  result: FollowProviderRequestResult;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}>;

type FollowState = {
  readonly key: string;
  readonly followId: string;
  readonly binding: BindingState;
  closed: boolean;
  terminalAcknowledged: boolean;
  subscription: Readonly<{ dispose(): void | Promise<void> }> | null;
  openResult: FollowOpenResult | null;
  openFailure: unknown | null;
  pending: PendingFollowEvent | null;
  pendingProvider: PendingProviderRequest | null;
  lastAcknowledgedEventId: string | null;
  waiter: FollowWaiter | null;
  closePromise: Promise<void> | null;
};

type BindingState = {
  readonly key: string;
  readonly sessionId: string;
  readonly runner: AgentRuntimeDaemonServiceAuthorityRunnerIdentity;
  readonly retainedAgent: AgentSessionRunnerBindingV1;
  readonly port: ExternalSessionHostOperationPort;
  current: boolean;
  retirePromise: Promise<void> | null;
};

type PendingBindingState = {
  readonly kind: 'pending';
  readonly key: string;
  readonly sessionId: string;
  readonly runner: AgentRuntimeDaemonServiceAuthorityRunnerIdentity;
  readonly retainedAgent: AgentSessionRunnerBindingV1;
  readonly completion: Promise<BindingState>;
  resolve(binding: BindingState): void;
  reject(error: unknown): void;
};

type BindingSlot = BindingState | PendingBindingState;

function unavailable(): Error {
  return new Error(
    'agent_runtime_daemon_service_generation_not_current',
  );
}

function followUnavailable(code: string): Error {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}

export type RunnerAgentDaemonFacetService = Readonly<{
  dispatch(input: Readonly<{
    sessionId: string;
    runner: AgentRuntimeDaemonServiceAuthorityRunnerIdentity;
    retainedAgent: AgentSessionRunnerBindingV1;
    operation: RunnerAgentDaemonFacetOperationV1;
    signal?: AbortSignal;
  }>): Promise<RunnerAgentDaemonFacetResultV1>;
  dispose(): Promise<void>;
}>;

export function createRunnerAgentDaemonFacetService(input: Readonly<{
  externalSessionHostOperationOwner: ExternalSessionHostOperationOwner;
  machineId: string;
  readAccountRevision(): string | null;
  authorizeCurrent(input: Readonly<{
    sessionId: string;
    runner: AgentRuntimeDaemonServiceAuthorityRunnerIdentity;
    retainedAgent: AgentSessionRunnerBindingV1;
  }>): Promise<boolean>;
  authorizeActiveTurn(params: Readonly<{
    sessionId: string;
    runner: AgentRuntimeDaemonServiceAuthorityRunnerIdentity;
    retainedAgent: AgentSessionRunnerBindingV1;
    witness: AgentRuntimeDaemonServiceTurnWitnessV1;
  }>): Promise<boolean>;
  resolveRetainedExternalSessionAgentContribution?(
    input: Readonly<{
      sessionId: string;
      runner: AgentRuntimeDaemonServiceAuthorityRunnerIdentity;
      retainedAgent: AgentSessionRunnerBindingV1;
    }>,
  ): Promise<ConfiguredExternalSessionSourceAgentContribution | null>;
  /**
   * This callback re-attests the runner-carried retained Agent, then observes
   * the current independent Voice-provider lifecycle from the registry.
   */
  snapshotVoiceAuthority(input: Readonly<{
    sessionId: string;
    runner: AgentRuntimeDaemonServiceAuthorityRunnerIdentity;
    retainedAgent: AgentSessionRunnerBindingV1;
  }>): Promise<Omit<VoiceSnapshot, 'kind'> | null>;
  /**
   * This callback re-observes the exact provider generation and settles when
   * that provider generation retires. Retained-Agent lifetime remains owned by
   * the daemon-service authority, including hard revocation.
   */
  waitVoiceAuthorityRetired(params: Readonly<{
    sessionId: string;
    runner: AgentRuntimeDaemonServiceAuthorityRunnerIdentity;
    retainedAgent: AgentSessionRunnerBindingV1;
    provider: PluginContributionIdentityV1;
    providerGeneration: string;
    signal?: AbortSignal;
  }>): Promise<void>;
}>): RunnerAgentDaemonFacetService {
  const bindings = new Map<string, BindingSlot>();
  const follows = new Map<string, FollowState>();
  let disposed = false;

  const followKey = (
    sessionId: string,
    followId: string,
  ) => `${sessionId}\u0000${followId}`;

  const hasExactBinding = (
    binding: Pick<
      BindingSlot,
      'sessionId' | 'runner' | 'retainedAgent'
    >,
    sessionId: string,
    runner: AgentRuntimeDaemonServiceAuthorityRunnerIdentity,
    retainedAgent: AgentSessionRunnerBindingV1,
  ): boolean =>
    binding.sessionId === sessionId
    && isDeepStrictEqual(binding.runner, runner)
    && isDeepStrictEqual(binding.retainedAgent, retainedAgent);

  const isPendingBinding = (
    binding: BindingSlot,
  ): binding is PendingBindingState => 'kind' in binding;

  const isCurrentBinding = (binding: BindingState): boolean =>
    binding.current
    && !disposed
    && bindings.get(binding.key) === binding;

  const createPendingBinding = (
    sessionId: string,
    runner: AgentRuntimeDaemonServiceAuthorityRunnerIdentity,
    retainedAgent: AgentSessionRunnerBindingV1,
  ): PendingBindingState => {
    let resolve!: (binding: BindingState) => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<BindingState>((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });
    // A concurrent caller normally waits for this promise, but a rejected
    // candidate may be displaced before another call observes it.
    void completion.catch(() => undefined);
    return {
      kind: 'pending',
      key: sessionId,
      sessionId,
      runner,
      retainedAgent,
      completion,
      resolve,
      reject,
    };
  };

  const waitForPendingBinding = async (
    pending: PendingBindingState,
    signal?: AbortSignal,
  ): Promise<BindingState> => {
    if (!signal) return await pending.completion;
    if (signal.aborted) {
      throw followUnavailable('plugin_operation_aborted');
    }
    let onAbort: (() => void) | null = null;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(
        followUnavailable('plugin_operation_aborted'),
      );
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([pending.completion, aborted]);
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  };

  const detachWaiter = (state: FollowState): FollowWaiter | null => {
    const waiter = state.waiter;
    if (!waiter) return null;
    state.waiter = null;
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    return waiter;
  };

  const acknowledgePending = (
    state: FollowState,
    eventId: string | undefined,
  ): void => {
    if (!eventId) return;
    const pending = state.pending;
    if (
      !pending
      && state.lastAcknowledgedEventId === eventId
    ) {
      return;
    }
    if (!pending || pending.result.eventId !== eventId) {
      throw followUnavailable(
        'plugin_external_follow_acknowledgement_invalid',
      );
    }
    state.pending = null;
    state.lastAcknowledgedEventId = eventId;
    if (pending.result.event.kind === 'terminated') {
      state.terminalAcknowledged = true;
    }
    pending.acknowledge();
  };

  const closeFollow = async (state: FollowState): Promise<void> => {
    if (state.closePromise) return await state.closePromise;
    state.closed = true;
    const pending = state.pending;
    state.pending = null;
    pending?.acknowledge();
    const pendingProvider = state.pendingProvider;
    state.pendingProvider = null;
    pendingProvider?.reject(
      followUnavailable('plugin_external_follow_unavailable'),
    );
    detachWaiter(state)?.resolve({
      kind: 'external_session.follow.closed',
      followId: state.followId,
    });
    const attempt = (async () => {
      await state.subscription?.dispose();
    })();
    state.closePromise = attempt;
    try {
      await attempt;
      follows.delete(state.key);
      state.subscription = null;
    } catch (error) {
      if (state.closePromise === attempt) {
        state.closePromise = null;
      }
      throw error;
    }
  };

  const closeFollowForRetirement = async (
    state: FollowState,
  ): Promise<void> => {
    try {
      await closeFollow(state);
    } finally {
      // Retirement is the final bounded lifecycle fence. Explicit close
      // failures retain the exact state for retry, while retirement must not
      // leave a dead generation reachable even if its source disposer fails.
      follows.delete(state.key);
      state.subscription = null;
    }
  };

  const retireBinding = async (binding: BindingState): Promise<void> => {
    binding.current = false;
    if (binding.retirePromise) return await binding.retirePromise;
    binding.retirePromise = (async () => {
      const closeResults = await Promise.allSettled(
        [...follows.values()]
          .filter((state) => state.binding === binding)
          .map(closeFollowForRetirement),
      );
      try {
        await binding.port.retire();
      } finally {
        if (bindings.get(binding.key) === binding) {
          bindings.delete(binding.key);
        }
      }
      const closeFailure = closeResults.find(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      );
      if (closeFailure) throw closeFailure.reason;
    })();
    return await binding.retirePromise;
  };

  const retireBindingSlot = async (binding: BindingSlot): Promise<void> => {
    if (isPendingBinding(binding)) {
      if (bindings.get(binding.key) === binding) {
        bindings.delete(binding.key);
        binding.reject(unavailable());
      }
      return;
    }
    await retireBinding(binding);
  };

  const authorizeBinding = async (
    sessionId: string,
    runner: AgentRuntimeDaemonServiceAuthorityRunnerIdentity,
    retainedAgent: AgentSessionRunnerBindingV1,
    witness?: AgentRuntimeDaemonServiceTurnWitnessV1,
  ): Promise<boolean> => witness
    ? await input.authorizeActiveTurn({
        sessionId,
        runner,
        retainedAgent,
        witness,
      })
    : await input.authorizeCurrent({
        sessionId,
        runner,
        retainedAgent,
      });

  const requireBinding = async (
    sessionId: string,
    runner: AgentRuntimeDaemonServiceAuthorityRunnerIdentity,
    retainedAgent: AgentSessionRunnerBindingV1,
    witness?: AgentRuntimeDaemonServiceTurnWitnessV1,
    signal?: AbortSignal,
  ): Promise<BindingState> => {
    for (;;) {
      const authorized = await authorizeBinding(
        sessionId,
        runner,
        retainedAgent,
        witness,
      );
      if (disposed || !authorized) {
        const stale = bindings.get(sessionId);
        if (
          stale
          && hasExactBinding(stale, sessionId, runner, retainedAgent)
        ) {
          await retireBindingSlot(stale);
        }
        throw unavailable();
      }

      const existing = bindings.get(sessionId);
      if (existing) {
        if (isPendingBinding(existing)) {
          if (!hasExactBinding(
            existing,
            sessionId,
            runner,
            retainedAgent,
          )) {
            // Authorization above established that this different retained
            // generation may own the Session now. Fence the unresolved
            // predecessor at the one binding slot; its late resolution checks
            // this slot before binding and is therefore discarded.
            if (bindings.get(existing.key) === existing) {
              bindings.delete(existing.key);
              existing.reject(unavailable());
            }
            continue;
          }
          try {
            await waitForPendingBinding(existing, signal);
          } catch (error) {
            if (signal?.aborted) throw error;
            // Re-authorize and either reuse the installed winner or create a
            // replacement. A failed candidate is never a reusable owner.
          }
          continue;
        }
        if (hasExactBinding(
          existing,
          sessionId,
          runner,
          retainedAgent,
        )) {
          return existing;
        }
        await retireBinding(existing);
        continue;
      }

      const pending = createPendingBinding(
        sessionId,
        runner,
        retainedAgent,
      );
      bindings.set(pending.key, pending);
      void (async () => {
        try {
          const agentContribution =
            await input.resolveRetainedExternalSessionAgentContribution?.({
              sessionId,
              runner,
              retainedAgent,
            })
            ?? null;
          const stillAuthorized = await authorizeBinding(
            sessionId,
            runner,
            retainedAgent,
            witness,
          );
          if (
            disposed
            || !stillAuthorized
            || bindings.get(pending.key) !== pending
          ) {
            throw unavailable();
          }
          let binding: BindingState | null = null;
          const port = input.externalSessionHostOperationOwner.bind({
            pluginId: retainedAgent.pluginId,
            agentId: retainedAgent.localAgentId,
            generationId: retainedAgent.immutableGenerationId,
            sessionId,
            machineId: input.machineId,
            readAccountRevision: input.readAccountRevision,
            isGenerationCurrent: () =>
              binding !== null && isCurrentBinding(binding),
            ...(agentContribution ? { agentContribution } : {}),
          });
          binding = {
            key: sessionId,
            sessionId,
            runner,
            retainedAgent,
            current: true,
            retirePromise: null,
            port,
          };
          bindings.set(binding.key, binding);
          pending.resolve(binding);
        } catch (error) {
          if (bindings.get(pending.key) === pending) {
            bindings.delete(pending.key);
          }
          pending.reject(error);
        }
      })();
      return await waitForPendingBinding(pending, signal);
    }
  };

  const resolveFollow = (
    sessionId: string,
    followId: string,
  ): FollowState => {
    const state = follows.get(followKey(sessionId, followId));
    if (!state || state.closed) {
      throw followUnavailable('plugin_external_follow_unavailable');
    }
    return state;
  };

  const waitForFollowProgress = async (
    state: FollowState,
    signal?: AbortSignal,
  ): Promise<FollowProgressResult> => {
    if (state.pendingProvider) {
      return state.pendingProvider.result;
    }
    if (state.openFailure !== null) {
      throw state.openFailure;
    }
    if (state.openResult) {
      const result = state.openResult;
      state.openResult = null;
      return result;
    }
    if (state.pending) return state.pending.result;
    if (state.closed || state.terminalAcknowledged) {
      await closeFollow(state);
      return {
        kind: 'external_session.follow.closed',
        followId: state.followId,
      };
    }
    if (state.waiter) {
      throw followUnavailable(
        'plugin_external_follow_poll_already_active',
      );
    }
    return await new Promise((resolve, reject) => {
      const onAbort = () => {
        if (state.waiter?.onAbort !== onAbort) return;
        detachWaiter(state);
        reject(followUnavailable('plugin_operation_aborted'));
      };
      state.waiter = {
        resolve,
        reject,
        ...(signal ? { signal, onAbort } : {}),
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  };

  const settleProviderResponse = (
    state: FollowState,
    response: RunnerAgentDaemonExternalSessionFollowProviderResponseV1
      | undefined,
  ): void => {
    if (!response) return;
    const pending = state.pendingProvider;
    if (
      !pending
      || pending.result.providerRequestId
        !== response.providerRequestId
    ) {
      throw followUnavailable(
        'plugin_external_follow_provider_correlation_invalid',
      );
    }
    state.pendingProvider = null;
    if (response.status === 'failure') {
      pending.reject(followUnavailable(response.code));
      return;
    }
    if (response.result.kind !== pending.result.request.kind) {
      pending.reject(followUnavailable(
        'plugin_external_follow_provider_correlation_invalid',
      ));
      return;
    }
    pending.resolve(response.result.value);
  };

  const openFollow = async (
    sessionId: string,
    runner: AgentRuntimeDaemonServiceAuthorityRunnerIdentity,
    retainedAgent: AgentSessionRunnerBindingV1,
    operation: Extract<
      RunnerAgentDaemonFacetOperationV1,
      { kind: 'external_session.follow.open' }
    >,
    signal?: AbortSignal,
  ): Promise<RunnerAgentDaemonFacetResultV1> => {
    const binding = await requireBinding(
      sessionId,
      runner,
      retainedAgent,
      operation.witness,
      signal,
    );
    if (!isCurrentBinding(binding)) throw unavailable();
    const key = followKey(sessionId, operation.followId);
    if (follows.has(key)) {
      throw followUnavailable(
        'plugin_external_follow_identity_conflict',
      );
    }
    const state: FollowState = {
      key,
      followId: operation.followId,
      binding,
      closed: false,
      terminalAcknowledged: false,
      subscription: null,
      openResult: null,
      openFailure: null,
      pending: null,
      pendingProvider: null,
      lastAcknowledgedEventId: null,
      waiter: null,
      closePromise: null,
    };
    const requestProvider = async <T>(
      request: RunnerAgentDaemonExternalSessionFollowProviderRequestV1,
      providerSignal?: AbortSignal,
    ): Promise<T> => {
      if (state.closed || state.pendingProvider) {
        throw followUnavailable(
          state.closed
            ? 'plugin_external_follow_unavailable'
            : 'plugin_external_follow_provider_request_already_active',
        );
      }
      const providerRequestId = randomUUID();
      const result: FollowProviderRequestResult = {
        kind: 'external_session.follow.provider_request',
        followId: state.followId,
        providerRequestId,
        request,
      };
      if (providerSignal?.aborted) {
        await closeFollow(state);
        throw followUnavailable('plugin_operation_aborted');
      }
      return await new Promise<T>((resolve, reject) => {
        const cleanup = () => {
          providerSignal?.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
          void closeFollow(state).catch(() => undefined);
        };
        state.pendingProvider = {
          result,
          resolve: (value) => {
            cleanup();
            resolve(value as T);
          },
          reject: (error) => {
            cleanup();
            reject(error);
          },
        };
        providerSignal?.addEventListener('abort', onAbort, {
          once: true,
        });
        if (providerSignal?.aborted) onAbort();
        detachWaiter(state)?.resolve(result);
      });
    };
    const providerOps = Object.freeze({
      async validateSource(request: Parameters<
        RunnerAgentExternalSessionProviderOps['validateSource']
      >[0]) {
        return await requestProvider<Awaited<ReturnType<
          RunnerAgentExternalSessionProviderOps['validateSource']
        >>>({
          kind: 'validateSource',
          source: request.source,
        }, request.signal);
      },
      async resolveLinkIdentity(request: Parameters<
        RunnerAgentExternalSessionProviderOps['resolveLinkIdentity']
      >[0]) {
        return await requestProvider<Awaited<ReturnType<
          RunnerAgentExternalSessionProviderOps['resolveLinkIdentity']
        >>>(RunnerAgentDaemonExternalSessionFollowProviderRequestV1Schema.parse({
          kind: 'resolveLinkIdentity',
          source: request.source,
          remoteSessionId: request.remoteSessionId,
          ...(request.runtimeDescriptor !== undefined
            ? { runtimeDescriptor: request.runtimeDescriptor }
            : {}),
          ...(request.metadata ? { metadata: request.metadata } : {}),
        }), request.signal);
      },
      async pageTranscript(request: Parameters<
        RunnerAgentExternalSessionProviderOps['pageTranscript']
      >[0]) {
        return await requestProvider<Awaited<ReturnType<
          RunnerAgentExternalSessionProviderOps['pageTranscript']
        >>>({
          kind: 'pageTranscript',
          source: request.source,
          remoteSessionId: request.remoteSessionId,
          direction: request.direction,
          maxBytes: request.maxBytes,
          maxItems: request.maxItems,
          ...(request.deadlineAtMs === undefined
            ? {}
            : { deadlineAtMs: request.deadlineAtMs }),
          ...(request.cursor ? { cursor: request.cursor } : {}),
        }, request.signal);
      },
      async readAfterTranscript(request: Parameters<
        RunnerAgentExternalSessionProviderOps[
          'readAfterTranscript'
        ]
      >[0]) {
        return await requestProvider<Awaited<ReturnType<
          RunnerAgentExternalSessionProviderOps[
            'readAfterTranscript'
          ]
        >>>({
          kind: 'readAfterTranscript',
          source: request.source,
          remoteSessionId: request.remoteSessionId,
          cursor: request.cursor,
          maxBytes: request.maxBytes,
          maxItems: request.maxItems,
          ...(request.deadlineAtMs === undefined
            ? {}
            : { deadlineAtMs: request.deadlineAtMs }),
        }, request.signal);
      },
    });
    follows.set(key, state);
    const listener = async (
      rawEvent: HostExternalTranscriptFollowEvent,
    ): Promise<void> => {
      if (state.closed) {
        throw followUnavailable(
          'plugin_external_follow_unavailable',
        );
      }
      if (state.pending) {
        await closeFollow(state);
        throw followUnavailable(
          'plugin_external_follow_buffer_overflow',
        );
      }
      const event =
        AgentRuntimeDaemonExternalSessionFollowEventV1Schema.parse(
          rawEvent,
        );
      const eventId = randomUUID();
      let acknowledge!: () => void;
      const acknowledged = new Promise<void>((resolve) => {
        acknowledge = resolve;
      });
      const result: FollowEventResult = {
        kind: 'external_session.follow.event',
        followId: state.followId,
        eventId,
        event,
      };
      state.pending = { result, acknowledge };
      // One-event custody: every event — including pages emitted while the
      // open exchange is still settling — is handed to the polling exchange
      // here and blocks this callback until its acknowledgement arrives, so
      // multi-page initial replay drains oldest-first without ever needing a
      // second buffer slot.
      detachWaiter(state)?.resolve(result);
      await acknowledged;
    };
    void (async () => {
      try {
        const result = operation.target.kind === 'externalSession'
          ? await binding.port.executeFollow({
              ref: operation.target.ref,
              source: operation.target.source,
              providerOps,
              options: {
                ...(operation.cursor
                  ? { cursor: operation.cursor }
                  : {}),
                ...(operation.initialReplay
                  ? { initialReplay: true }
                  : {}),
                ...(operation.admissionDeadlineAtMs === undefined
                  ? {}
                  : { admissionDeadlineAtMs: operation.admissionDeadlineAtMs }),
                ...(signal ? { signal } : {}),
              },
              listener,
            })
          : await binding.port.executeProviderSessionFollow({
              agentId: operation.target.agentId,
              providerSessionId:
                operation.target.providerSessionId,
              providerOps,
              options: {
                ...(operation.cursor
                  ? { cursor: operation.cursor }
                  : {}),
                ...(operation.initialReplay
                  ? { initialReplay: true }
                  : {}),
                ...(operation.admissionDeadlineAtMs === undefined
                  ? {}
                  : { admissionDeadlineAtMs: operation.admissionDeadlineAtMs }),
                ...(signal ? { signal } : {}),
              },
              listener,
            });
        if (state.closed) {
          if (result.status === 'following') {
            await result.subscription.dispose();
          }
          return;
        }
        if (result.status === 'following') {
          state.subscription = result.subscription;
        }
        const openResult = RunnerAgentDaemonFacetResultV1Schema.parse({
          kind: 'external_session.follow.open',
          followId: operation.followId,
          result: result.status === 'following'
            ? {
                status: 'following',
                startingCursor: result.startingCursor,
              }
            : result,
        }) as FollowOpenResult;
        const waiter = detachWaiter(state);
        if (waiter) waiter.resolve(openResult);
        else state.openResult = openResult;
      } catch (error) {
        const waiter = detachWaiter(state);
        if (waiter) waiter.reject(error);
        else state.openFailure = error;
        await closeFollow(state).catch(() => undefined);
      }
    })();
    let progress: FollowProgressResult;
    try {
      progress = await waitForFollowProgress(state, signal);
    } catch (error) {
      await closeFollow(state).catch(() => undefined);
      throw error;
    }
    if (
      progress.kind === 'external_session.follow.open'
      && progress.result.status === 'unavailable'
    ) {
      await closeFollow(state);
    }
    return progress;
  };

  return Object.freeze({
    async dispatch({
      sessionId,
      runner,
      retainedAgent,
      operation,
      signal,
    }) {
      switch (operation.kind) {
        case 'external_session.follow.open':
          return await openFollow(
            sessionId,
            runner,
            retainedAgent,
            operation,
            signal,
          );
        case 'external_session.follow.next': {
          const state = resolveFollow(
            sessionId,
            operation.followId,
          );
          try {
            const binding = await requireBinding(
              sessionId,
              runner,
              retainedAgent,
              operation.witness,
              signal,
            );
            if (binding !== state.binding || !isCurrentBinding(binding)) {
              throw unavailable();
            }
          } catch (error) {
            await closeFollow(state);
            throw error;
          }
          acknowledgePending(
            state,
            operation.acknowledgeEventId,
          );
          settleProviderResponse(
            state,
            operation.providerResponse,
          );
          return RunnerAgentDaemonFacetResultV1Schema.parse(
            await waitForFollowProgress(state, signal),
          );
        }
        case 'external_session.follow.close': {
          const state = follows.get(
            followKey(sessionId, operation.followId),
          );
          if (!state) {
            return {
              kind: 'external_session.follow.closed',
              followId: operation.followId,
            };
          }
          acknowledgePending(
            state,
            operation.acknowledgeEventId,
          );
          await closeFollow(state);
          return {
            kind: 'external_session.follow.closed',
            followId: operation.followId,
          };
        }
        case 'voice.authority.snapshot': {
          if (disposed) throw unavailable();
          const snapshot =
            await input.snapshotVoiceAuthority({
              sessionId,
              runner,
              retainedAgent,
            });
          if (!snapshot) throw unavailable();
          return RunnerAgentDaemonFacetResultV1Schema.parse({
            kind: 'voice.authority.snapshot',
            ...snapshot,
          });
        }
        case 'voice.authority.waitRetired': {
          if (disposed) throw unavailable();
          const authorized = operation.witness
            ? await input.authorizeActiveTurn({
                sessionId,
                runner,
                retainedAgent,
                witness: operation.witness,
              })
            : await input.authorizeCurrent({
                sessionId,
                runner,
                retainedAgent,
              });
          if (!authorized) throw unavailable();
          await input.waitVoiceAuthorityRetired({
            sessionId,
            runner,
            retainedAgent,
            provider: operation.provider,
            providerGeneration:
              operation.providerGeneration,
            ...(signal ? { signal } : {}),
          });
          return {
            kind: 'voice.authority.retired',
            providerGeneration:
              operation.providerGeneration,
          };
        }
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      const bindingResults = await Promise.allSettled(
        [...bindings.values()].map(retireBindingSlot),
      );
      const followResults = await Promise.allSettled(
        [...follows.values()].map(closeFollowForRetirement),
      );
      const failure = [...bindingResults, ...followResults].find(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      );
      if (failure) throw failure.reason;
    },
  });
}
