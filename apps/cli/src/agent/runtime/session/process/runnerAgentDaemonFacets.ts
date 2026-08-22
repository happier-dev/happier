import { randomUUID } from 'node:crypto';

import type {
  AgentSessionRealtimeVoiceAuthority,
} from '@/agent/runtime/session/realtime/registerAgentSessionRealtimeVoiceRpc';
import {
  createAgentSessionRealtimeVoiceAuthority,
} from '@/agent/runtime/session/realtime/resolveAgentSessionRealtimeVoiceAuthority';
import type {
  ExternalSessionHostOperationPortFactory,
  RunnerAgentCurrentExternalSessionProviderOps,
} from '@/agent/runtime/registry/engineRegistry/types';
import type {
  AgentRuntimeDaemonServiceAuthorityExpectedInput,
} from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import type {
  ExternalSessionHostOperationPort,
} from '@/session/external/hostOperationOwner';
import {
  dispatchCurrentAgentRuntimeDaemonServiceRequest,
  isCurrentRunnerAgentRuntimeDaemonServiceAuthorityTransition,
} from './agentRuntimeDaemonServiceAuthorityClient';
import {
  RunnerAgentDaemonFacetOperationV1Schema,
  RunnerAgentDaemonExternalSessionFollowProviderResponseV1Schema,
  type RunnerAgentDaemonExternalSessionFollowProviderResponseV1,
  type RunnerAgentDaemonFacetOperationV1,
  type RunnerAgentDaemonFacetResultV1,
} from './agentRuntimeDaemonFacetProtocol';
import {
  projectAgentRuntimeDaemonServiceTurnWitnessV1,
  type AgentRuntimeDaemonServiceTurnWitnessInputV1,
  type AgentRuntimeDaemonServiceTurnWitnessV1,
} from './agentRuntimeDaemonServiceTurnWitness';

type DispatchDaemonService =
  typeof dispatchCurrentAgentRuntimeDaemonServiceRequest;

type CurrentExternalSessionOperation = Extract<
  RunnerAgentDaemonFacetOperationV1,
  Readonly<{ kind: `external_session.current.${string}` }>
>;

type CurrentExternalSessionResult = Extract<
  RunnerAgentDaemonFacetResultV1,
  Readonly<{ kind: `external_session.current.${string}` }>
>;

function isCurrentExternalSessionOperation(
  operation: RunnerAgentDaemonFacetOperationV1,
): operation is CurrentExternalSessionOperation {
  return operation.kind
    === 'external_session.current.resolve_source'
    || operation.kind
      === 'external_session.current.list_candidates'
    || operation.kind
      === 'external_session.current.resolve_link_identity'
    || operation.kind
      === 'external_session.current.resolve_linked_identity'
    || operation.kind
      === 'external_session.current.page_transcript'
    || operation.kind
      === 'external_session.current.read_after_transcript';
}

function isCurrentExternalSessionResult(
  result: Readonly<{ kind: string }>,
): result is CurrentExternalSessionResult {
  return result.kind
    === 'external_session.current.resolve_source'
    || result.kind
      === 'external_session.current.list_candidates'
    || result.kind
      === 'external_session.current.resolve_link_identity'
    || result.kind
      === 'external_session.current.resolve_linked_identity'
    || result.kind
      === 'external_session.current.page_transcript'
    || result.kind
      === 'external_session.current.read_after_transcript';
}

type ActiveFollow = Readonly<{
  close(acknowledgeEventId?: string): Promise<void>;
  retire(): Promise<void>;
}>;

const EXTERNAL_SESSION_FOLLOW_CLOSE_TRANSPORT_TIMEOUT_MS =
  6_000;

function responseError(
  code: string,
  message: string,
): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function followFailureError(error: unknown): Error {
  if (
    error instanceof Error
    && 'code' in error
    && typeof error.code === 'string'
    && error.code.length > 0
    && error.code === error.code.trim()
  ) {
    return error;
  }
  return responseError(
    'plugin_external_follow_failed',
    'External Session transcript follow failed',
  );
}

export type RunnerAgentDaemonFacets = Readonly<{
  externalSessionHostOperations:
    ExternalSessionHostOperationPortFactory;
  currentExternalSessionProviderOps:
    RunnerAgentCurrentExternalSessionProviderOps;
  agentSessionRealtimeVoiceAuthority:
    AgentSessionRealtimeVoiceAuthority | null;
  dispose(): Promise<void>;
}>;

export async function createRunnerAgentDaemonFacets(input: Readonly<{
  authority: AgentRuntimeDaemonServiceAuthorityExpectedInput;
  dispatch?: DispatchDaemonService;
  readActiveTurnAdmissionWitness?():
    AgentRuntimeDaemonServiceTurnWitnessInputV1 | null;
  resolveRetainedExternalSessionProviderOps?(): Promise<
    Pick<
      RunnerAgentCurrentExternalSessionProviderOps,
      | 'validateSource'
      | 'resolveLinkIdentity'
      | 'pageTranscript'
      | 'readAfterTranscript'
    > | null
  >;
}>): Promise<RunnerAgentDaemonFacets> {
  const dispatch =
    input.dispatch
    ?? dispatchCurrentAgentRuntimeDaemonServiceRequest;
  const binding = input.authority.retainedAgent;
  const lifetime = new AbortController();
  const activeFollows = new Set<ActiveFollow>();
  let retainedExternalSessionProviderOpsPromise: Promise<
    Pick<
      RunnerAgentCurrentExternalSessionProviderOps,
      | 'validateSource'
      | 'resolveLinkIdentity'
      | 'pageTranscript'
      | 'readAfterTranscript'
    > | null
  > | null = null;
  const resolveRetainedExternalSessionProviderOps = async () => {
    retainedExternalSessionProviderOpsPromise ??=
      input.resolveRetainedExternalSessionProviderOps?.()
      ?? Promise.resolve(null);
    return await retainedExternalSessionProviderOpsPromise;
  };
  const executeRetainedExternalSessionProviderRequest = async (
    result: Extract<
      RunnerAgentDaemonFacetResultV1,
      { kind: 'external_session.follow.provider_request' }
    >,
    signal: AbortSignal,
  ): Promise<RunnerAgentDaemonExternalSessionFollowProviderResponseV1> => {
    const providerOps =
      await resolveRetainedExternalSessionProviderOps();
    if (!providerOps) {
      return {
        providerRequestId: result.providerRequestId,
        status: 'failure',
        code: 'plugin_external_follow_companion_unavailable',
        message:
          'The retained Agent generation has no authenticated External Sessions companion',
      };
    }
    try {
      if (result.request.kind === 'validateSource') {
        const value = await providerOps.validateSource({
          source: result.request.source,
          signal,
        });
        return RunnerAgentDaemonExternalSessionFollowProviderResponseV1Schema.parse({
          providerRequestId: result.providerRequestId,
          status: 'success',
          result: { kind: result.request.kind, value },
        });
      }
      if (result.request.kind === 'resolveLinkIdentity') {
        const resolved = await providerOps.resolveLinkIdentity({
          source: result.request.source,
          remoteSessionId: result.request.remoteSessionId,
          ...(result.request.runtimeDescriptor !== undefined
            ? { runtimeDescriptor: result.request.runtimeDescriptor }
            : {}),
          ...(result.request.metadata
            ? { metadata: result.request.metadata }
            : {}),
          signal,
        });
        return RunnerAgentDaemonExternalSessionFollowProviderResponseV1Schema.parse({
          providerRequestId: result.providerRequestId,
          status: 'success',
          result: {
            kind: result.request.kind,
            value: {
              ...resolved,
              ...(resolved.sessionStateUpdates
                ? { sessionStateUpdates: [...resolved.sessionStateUpdates] }
                : {}),
            },
          },
        });
      }
      if (result.request.kind === 'pageTranscript') {
        const value = await providerOps.pageTranscript({
          ...result.request,
          signal,
        });
        return {
          providerRequestId: result.providerRequestId,
          status: 'success',
          result: {
            kind: result.request.kind,
            value: { ...value, items: [...value.items] },
          },
        };
      }
      const value = await providerOps.readAfterTranscript({
        ...result.request,
        signal,
      });
      return RunnerAgentDaemonExternalSessionFollowProviderResponseV1Schema.parse({
        providerRequestId: result.providerRequestId,
        status: 'success',
        result: {
          kind: result.request.kind,
          value: value.outcome === 'advanced'
            ? {
                ...value,
                items: [...value.items],
                ...(value.diagnostics
                  ? {
                      diagnostics: value.diagnostics.map(
                        (diagnostic) => ({
                          ...diagnostic,
                          positions: [...diagnostic.positions],
                        }),
                      ),
                    }
                  : {}),
              }
            : value,
        },
      });
    } catch (error) {
      const code = error instanceof Error
        && 'code' in error
        && typeof error.code === 'string'
        && error.code.length > 0
        ? error.code.slice(0, 256)
        : 'plugin_external_follow_provider_failed';
      const message = error instanceof Error && error.message.trim()
        ? error.message.trim().slice(0, 2_000)
        : 'The retained External Sessions companion failed';
      return {
        providerRequestId: result.providerRequestId,
        status: 'failure',
        code,
        message,
      };
    }
  };
  const readWitness = ():
    AgentRuntimeDaemonServiceTurnWitnessV1 | undefined => {
    const witness =
      input.readActiveTurnAdmissionWitness?.() ?? null;
    return witness
      ? projectAgentRuntimeDaemonServiceTurnWitnessV1(witness)
      : undefined;
  };

  const dispatchOperation = async (
    operation: RunnerAgentDaemonFacetOperationV1,
    signal?: AbortSignal,
    timeoutMs?: number | null,
  ) => await dispatch({
    authority: input.authority,
    createRequest: (capability) => ({
      v: 1,
      context: {
        token: capability,
        sessionId: input.authority.sessionId,
      },
      operation,
    }),
    ...(signal ? { signal } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });

  let boundSessionId: string | null = null;
  const externalSessionHostOperations:
    ExternalSessionHostOperationPortFactory = Object.freeze({
      bindSession(sessionIdRaw) {
        const sessionId = sessionIdRaw.trim();
        if (
          !sessionId
          || sessionId !== input.authority.sessionId
          || (
            boundSessionId !== null
            && boundSessionId !== sessionId
          )
        ) {
          throw new Error(
            'Runner External Session facet session identity mismatch',
          );
        }
        boundSessionId = sessionId;
        let retired = false;
        const portFollows = new Set<ActiveFollow>();
        const createProvisionalFollow = (
          followId: string,
        ): ActiveFollow => {
          let closePromise: Promise<void> | null = null;
          let closeAttemptCount = 0;
          let retirementPromise: Promise<void> | null = null;
          const follow: ActiveFollow = Object.freeze({
            async close() {
              if (closePromise) return await closePromise;
              closeAttemptCount += 1;
              const attempt = (async () => {
                const response = await dispatchOperation(
                  {
                    kind: 'external_session.follow.close',
                    requestId: randomUUID(),
                    followId,
                  },
                  undefined,
                  EXTERNAL_SESSION_FOLLOW_CLOSE_TRANSPORT_TIMEOUT_MS,
                );
                if (!response.ok) {
                  throw responseError(
                    response.error.code,
                    response.error.message,
                  );
                }
                if (
                  response.result.kind
                    !== 'external_session.follow.closed'
                  || response.result.followId !== followId
                ) {
                  throw responseError(
                    'plugin_external_follow_response_invalid',
                    'Daemon returned an invalid External Session close result',
                  );
                }
                portFollows.delete(follow);
                activeFollows.delete(follow);
              })();
              closePromise = attempt;
              try {
                await attempt;
              } catch (error) {
                if (closePromise === attempt) {
                  closePromise = null;
                }
                throw error;
              }
            },
            async retire() {
              if (retirementPromise) {
                return await retirementPromise;
              }
              const joinedAttempt = closePromise;
              const hadSettledAttempt =
                closeAttemptCount > 0 && joinedAttempt === null;
              retirementPromise = (async () => {
                try {
                  await follow.close();
                } catch (error) {
                  if (hadSettledAttempt) throw error;
                  await follow.close();
                } finally {
                  portFollows.delete(follow);
                  activeFollows.delete(follow);
                }
              })();
              return await retirementPromise;
            },
          });
          portFollows.add(follow);
          activeFollows.add(follow);
          return follow;
        };
        const releaseProvisionalFollow = (
          follow: ActiveFollow,
        ): void => {
          portFollows.delete(follow);
          activeFollows.delete(follow);
        };

        const openFollow = async (
          operation: Extract<
            RunnerAgentDaemonFacetOperationV1,
            { kind: 'external_session.follow.open' }
          >,
          options: Readonly<{ signal?: AbortSignal }>,
          listener: Parameters<
            ExternalSessionHostOperationPort['executeFollow']
          >[0]['listener'],
        ) => {
          if (retired || lifetime.signal.aborted) {
            return {
              status: 'unavailable' as const,
              code: 'plugin_generation_retired',
            };
          }
          const callerSignal = options.signal;
          const openSignal = callerSignal
            ? AbortSignal.any([
                callerSignal,
                lifetime.signal,
              ])
            : lifetime.signal;
          const provisionalFollow = createProvisionalFollow(
            operation.followId,
          );
          let response;
          try {
            response = await dispatchOperation(
              operation,
              openSignal,
            );
            while (
              response.ok
              && response.result.kind
                === 'external_session.follow.provider_request'
            ) {
              if (response.result.followId !== operation.followId) {
                await provisionalFollow.close().catch(() => undefined);
                return {
                  status: 'unavailable' as const,
                  code: 'plugin_external_follow_response_invalid',
                };
              }
              const providerResponse =
                await executeRetainedExternalSessionProviderRequest(
                  response.result,
                  openSignal,
                );
              const witness = readWitness();
              response = await dispatchOperation({
                kind: 'external_session.follow.next',
                requestId: randomUUID(),
                followId: operation.followId,
                providerResponse,
                ...(witness ? { witness } : {}),
              }, openSignal);
            }
          } catch (error) {
            await provisionalFollow.close().catch(() => undefined);
            throw error;
          }
          if (!response.ok) {
            await provisionalFollow.close().catch(() => undefined);
            return {
              status: 'unavailable' as const,
              code: response.error.code,
            };
          }
          const result = response.result;
          if (
            result.kind !== 'external_session.follow.open'
            || result.followId !== operation.followId
          ) {
            await provisionalFollow.close().catch(() => undefined);
            return {
              status: 'unavailable' as const,
              code: 'plugin_external_follow_response_invalid',
            };
          }
          if (result.result.status === 'unavailable') {
            await provisionalFollow.close().catch(() => undefined);
            return result.result;
          }

          let active = true;
          let closePromise: Promise<void> | null = null;
          let closingFollowId: string | null = null;
          let closeAttemptCount = 0;
          let retirementPromise: Promise<void> | null = null;
          let lastDeliveredEventId: string | undefined;
          let currentCursor = result.result.startingCursor;
          let currentOperation = operation;
          let onCallerAbort: (() => void) | null = null;
          let listenerRejected = false;
          let resolveFailure!: (error: Error) => void;
          let failureReported = false;
          const failure = new Promise<Error>((resolve) => {
            resolveFailure = resolve;
          });
          const reportFailure = (error: unknown): Error => {
            const normalized = followFailureError(error);
            if (!failureReported) {
              failureReported = true;
              resolveFailure(normalized);
            }
            return normalized;
          };
          const reopenAfterDaemonReplacement =
            async (): Promise<boolean> => {
              while (
                active
                && !retired
                && !lifetime.signal.aborted
                && !callerSignal?.aborted
              ) {
                const witness = readWitness();
                const candidate = {
                  kind:
                    'external_session.follow.open' as const,
                  requestId: randomUUID(),
                  followId: randomUUID(),
                  target: currentOperation.target,
                  ...(currentCursor
                    ? { cursor: currentCursor }
                    : {}),
                  ...(witness ? { witness } : {}),
                };
                const provisionalCandidate = createProvisionalFollow(
                  candidate.followId,
                );
                let reopened;
                try {
                  const reopenSignal = callerSignal
                    ? AbortSignal.any([
                        callerSignal,
                        lifetime.signal,
                      ])
                    : lifetime.signal;
                  reopened = await dispatchOperation(
                    candidate,
                    reopenSignal,
                  );
                  while (
                    reopened.ok
                    && reopened.result.kind
                      === 'external_session.follow.provider_request'
                  ) {
                    if (
                      reopened.result.followId
                        !== candidate.followId
                    ) {
                      await provisionalCandidate.close().catch(() => undefined);
                      return false;
                    }
                    const providerResponse =
                      await executeRetainedExternalSessionProviderRequest(
                        reopened.result,
                        reopenSignal,
                      );
                    const currentWitness = readWitness();
                    reopened = await dispatchOperation({
                      kind: 'external_session.follow.next',
                      requestId: randomUUID(),
                      followId: candidate.followId,
                      providerResponse,
                      ...(currentWitness
                        ? { witness: currentWitness }
                        : {}),
                    }, reopenSignal);
                  }
                } catch (error) {
                  await provisionalCandidate.close().catch(() => undefined);
                  if (
                    isCurrentRunnerAgentRuntimeDaemonServiceAuthorityTransition(
                      error,
                    )
                  ) {
                    continue;
                  }
                  throw error;
                }
                if (
                  !reopened.ok
                  || reopened.result.kind
                    !== 'external_session.follow.open'
                  || reopened.result.followId
                    !== candidate.followId
                  || reopened.result.result.status
                    !== 'following'
                ) {
                  await provisionalCandidate.close().catch(() => undefined);
                  return false;
                }
                currentOperation = candidate;
                currentCursor =
                  reopened.result.result.startingCursor;
                lastDeliveredEventId = undefined;
                releaseProvisionalFollow(provisionalCandidate);
                return true;
              }
              return false;
            };
          const follow: ActiveFollow = Object.freeze({
            async close(acknowledgeEventId) {
              if (closePromise) return await closePromise;
              active = false;
              if (onCallerAbort) {
                callerSignal?.removeEventListener(
                  'abort',
                  onCallerAbort,
                );
                onCallerAbort = null;
              }
              closeAttemptCount += 1;
              closingFollowId ??= currentOperation.followId;
              const followId = closingFollowId;
              const attempt = (async () => {
                const response = await dispatchOperation(
                  {
                    kind: 'external_session.follow.close',
                    requestId: randomUUID(),
                    followId,
                    ...(acknowledgeEventId
                      ? { acknowledgeEventId }
                      : {}),
                  },
                  undefined,
                  EXTERNAL_SESSION_FOLLOW_CLOSE_TRANSPORT_TIMEOUT_MS,
                );
                if (!response.ok) {
                  throw responseError(
                    response.error.code,
                    response.error.message,
                  );
                }
                if (
                  response.result.kind
                    !== 'external_session.follow.closed'
                  || response.result.followId !== followId
                ) {
                  throw responseError(
                    'plugin_external_follow_response_invalid',
                    'Daemon returned an invalid External Session close result',
                  );
                }
                portFollows.delete(follow);
                activeFollows.delete(follow);
              })();
              closePromise = attempt;
              try {
                await attempt;
              } catch (error) {
                if (closePromise === attempt) {
                  closePromise = null;
                }
                throw error;
              }
            },
            async retire() {
              if (retirementPromise) {
                return await retirementPromise;
              }
              const joinedAttempt = closePromise;
              const hadSettledAttempt =
                closeAttemptCount > 0 && joinedAttempt === null;
              retirementPromise = (async () => {
                try {
                  await follow.close();
                } catch (error) {
                  if (hadSettledAttempt) throw error;
                  await follow.close();
                } finally {
                  portFollows.delete(follow);
                  activeFollows.delete(follow);
                }
              })();
              return await retirementPromise;
            },
          });
          portFollows.add(follow);
          activeFollows.add(follow);
          releaseProvisionalFollow(provisionalFollow);
          onCallerAbort = () => {
            void follow.close(lastDeliveredEventId)
              .catch(() => undefined);
          };
          callerSignal?.addEventListener(
            'abort',
            onCallerAbort,
            { once: true },
          );

          void (async () => {
            try {
              while (
                active
                && !retired
                && !lifetime.signal.aborted
              ) {
                let next;
                try {
                  const witness = readWitness();
                  next = await dispatchOperation({
                    kind: 'external_session.follow.next',
                    requestId: randomUUID(),
                    followId: currentOperation.followId,
                    ...(lastDeliveredEventId
                      ? {
                          acknowledgeEventId:
                            lastDeliveredEventId,
                        }
                      : {}),
                    ...(witness ? { witness } : {}),
                  }, openSignal);
                } catch (error) {
                  if (
                    isCurrentRunnerAgentRuntimeDaemonServiceAuthorityTransition(
                      error,
                    )
                  ) {
                    if (await reopenAfterDaemonReplacement()) {
                      continue;
                    }
                  }
                  throw error;
                }
                if (!next.ok) {
                  throw responseError(
                    next.error.code,
                    next.error.message,
                  );
                }
                while (
                  next.result.kind
                    === 'external_session.follow.provider_request'
                ) {
                  if (
                    next.result.followId
                      !== currentOperation.followId
                  ) {
                    throw responseError(
                      'plugin_external_follow_response_invalid',
                      'Daemon returned an invalid External Session provider request',
                    );
                  }
                  const providerResponse =
                    await executeRetainedExternalSessionProviderRequest(
                      next.result,
                      openSignal,
                    );
                  const witness = readWitness();
                  next = await dispatchOperation({
                    kind: 'external_session.follow.next',
                    requestId: randomUUID(),
                    followId: currentOperation.followId,
                    providerResponse,
                    ...(witness ? { witness } : {}),
                  }, openSignal);
                  if (!next.ok) {
                    throw responseError(
                      next.error.code,
                      next.error.message,
                    );
                  }
                }
                if (
                  next.result.kind
                    === 'external_session.follow.closed'
                ) {
                  active = false;
                  break;
                }
                if (
                  next.result.kind
                    !== 'external_session.follow.event'
                  || next.result.followId
                    !== currentOperation.followId
                ) {
                  throw responseError(
                    'plugin_external_follow_response_invalid',
                    'Daemon returned an invalid External Session follow event',
                  );
                }
                try {
                  await listener(next.result.event);
                } catch (error) {
                  listenerRejected = true;
                  reportFailure(error);
                  throw error;
                }
                lastDeliveredEventId =
                  next.result.eventId;
                if (next.result.event.kind === 'data') {
                  currentCursor =
                    next.result.event.nextCursor;
                } else if (
                  next.result.event.kind
                    === 'resyncRequired'
                ) {
                  currentCursor =
                    next.result.event.cursor;
                }
                if (
                  next.result.event.kind === 'terminated'
                ) {
                  await follow.close(
                    lastDeliveredEventId,
                  );
                  break;
                }
              }
            } catch (error) {
              if (
                active
                && !retired
                && !lifetime.signal.aborted
                && !callerSignal?.aborted
              ) {
                const normalized = followFailureError(error);
                if (!listenerRejected) {
                  await Promise.resolve(listener(Object.freeze({
                    kind: 'terminated',
                    reason: 'providerFailure',
                    cursor: currentCursor,
                    code:
                      'code' in normalized
                      && typeof normalized.code === 'string'
                        ? normalized.code
                      : 'plugin_external_follow_failed',
                  }))).catch(() => undefined);
                }
                reportFailure(normalized);
              }
              await follow.close(lastDeliveredEventId)
                .catch(() => undefined);
            }
          })();

          if (callerSignal?.aborted) {
            await follow.close();
            return {
              status: 'unavailable' as const,
              code: 'plugin_operation_aborted',
            };
          }
          return {
            status: 'following' as const,
            startingCursor: result.result.startingCursor,
            failure,
            subscription: Object.freeze({
              async dispose() {
                await follow.close(lastDeliveredEventId);
              },
            }),
          };
        };

        const port: ExternalSessionHostOperationPort =
          Object.freeze({
            async executeFollow(request) {
              const witness = readWitness();
              return await openFollow({
                kind: 'external_session.follow.open',
                requestId: randomUUID(),
                followId: randomUUID(),
                target: {
                  kind: 'externalSession',
                  ref: request.ref,
                  source: request.source,
                },
                ...(request.options.cursor
                  ? { cursor: request.options.cursor }
                  : {}),
                ...(witness ? { witness } : {}),
              }, request.options, request.listener);
            },
            async executeProviderSessionFollow(request) {
              const witness = readWitness();
              return await openFollow({
                kind: 'external_session.follow.open',
                requestId: randomUUID(),
                followId: randomUUID(),
                target: {
                  kind: 'providerSession',
                  agentId: request.agentId,
                  providerSessionId:
                    request.providerSessionId,
                },
                ...(request.options.cursor
                  ? { cursor: request.options.cursor }
                  : {}),
                ...(witness ? { witness } : {}),
              }, request.options, request.listener);
            },
            async retire() {
              if (retired) return;
              retired = true;
              await Promise.allSettled(
                [...portFollows].map(async (follow) =>
                  await follow.retire()),
              );
            },
          });
        return port;
      },
    });

  const dispatchCurrentExternalSessionOperation = async (
    operation: CurrentExternalSessionOperation,
    signal?: AbortSignal,
  ): Promise<CurrentExternalSessionResult> => {
    const response = await dispatchOperation(
      operation,
      signal
        ? AbortSignal.any([signal, lifetime.signal])
        : lifetime.signal,
    );
    if (!response.ok) {
      throw responseError(
        response.error.code,
        response.error.message,
      );
    }
    if (!isCurrentExternalSessionResult(response.result)) {
      throw responseError(
        'plugin_external_session_current_response_invalid',
        'Daemon returned an invalid current External Session result',
      );
    }
    return response.result;
  };

  const parseCurrentExternalSessionOperation = (
    value: unknown,
  ): CurrentExternalSessionOperation => {
    const operation =
      RunnerAgentDaemonFacetOperationV1Schema.parse(value);
    if (!isCurrentExternalSessionOperation(operation)) {
      throw responseError(
        'plugin_external_session_current_request_invalid',
        'Runner created an invalid current External Session request',
      );
    }
    return operation;
  };

  const currentExternalSessionProviderOps:
    RunnerAgentCurrentExternalSessionProviderOps = Object.freeze({
      async validateSource(request) {
        const witness = readWitness();
        const operation = parseCurrentExternalSessionOperation({
          kind: 'external_session.current.resolve_source',
          requestId: randomUUID(),
          agentId: binding.agentId,
          source: request.source,
          ...(witness ? { witness } : {}),
        });
        const result = await dispatchCurrentExternalSessionOperation(
          operation,
          request.signal,
        );
        if (
          result.kind
            !== 'external_session.current.resolve_source'
        ) {
          throw responseError(
            'plugin_external_session_current_response_invalid',
            'Daemon returned an invalid current External Session source result',
          );
        }
        return result.result;
      },
      async listCandidates(request) {
        const witness = readWitness();
        const operation = parseCurrentExternalSessionOperation({
          kind: 'external_session.current.list_candidates',
          requestId: randomUUID(),
          agentId: binding.agentId,
          source: request.source,
          cursor: request.cursor,
          limit: request.limit,
          searchTerm: request.searchTerm,
          searchMode: request.searchMode,
          maxBytes: request.maxBytes,
          ...(witness ? { witness } : {}),
        });
        const result = await dispatchCurrentExternalSessionOperation(
          operation,
          request.signal,
        );
        if (
          result.kind
            !== 'external_session.current.list_candidates'
        ) {
          throw responseError(
            'plugin_external_session_current_response_invalid',
            'Daemon returned an invalid current External Session candidate result',
          );
        }
        return result.result;
      },
      async resolveLinkIdentity(request) {
        const witness = readWitness();
        const operation = parseCurrentExternalSessionOperation({
          kind: 'external_session.current.resolve_link_identity',
          requestId: randomUUID(),
          agentId: binding.agentId,
          source: request.source,
          remoteSessionId: request.remoteSessionId,
          runtimeDescriptor: request.runtimeDescriptor,
          metadata: request.metadata,
          ...(witness ? { witness } : {}),
        });
        const result = await dispatchCurrentExternalSessionOperation(
          operation,
          request.signal,
        );
        if (
          result.kind
            !== 'external_session.current.resolve_link_identity'
        ) {
          throw responseError(
            'plugin_external_session_current_response_invalid',
            'Daemon returned an invalid current External Session link result',
          );
        }
        return result.result;
      },
      async canonicalizeLinkedSession(request) {
        const witness = readWitness();
        const operation = parseCurrentExternalSessionOperation({
          kind: 'external_session.current.resolve_linked_identity',
          requestId: randomUUID(),
          agentId: binding.agentId,
          source: request.source,
          remoteSessionId: request.remoteSessionId,
          metadata: request.metadata,
          ...(witness ? { witness } : {}),
        });
        const result = await dispatchCurrentExternalSessionOperation(
          operation,
          request.signal,
        );
        if (
          result.kind
            !== 'external_session.current.resolve_linked_identity'
        ) {
          throw responseError(
            'plugin_external_session_current_response_invalid',
            'Daemon returned an invalid current External Session linked result',
          );
        }
        return result.result;
      },
      async pageTranscript(request) {
        const witness = readWitness();
        const operation = parseCurrentExternalSessionOperation({
          kind: 'external_session.current.page_transcript',
          requestId: randomUUID(),
          agentId: binding.agentId,
          source: request.source,
          remoteSessionId: request.remoteSessionId,
          direction: request.direction,
          cursor: request.cursor,
          maxBytes: request.maxBytes,
          maxItems: request.maxItems,
          ...(witness ? { witness } : {}),
        });
        const result = await dispatchCurrentExternalSessionOperation(
          operation,
          request.signal,
        );
        if (
          result.kind
            !== 'external_session.current.page_transcript'
        ) {
          throw responseError(
            'plugin_external_session_current_response_invalid',
            'Daemon returned an invalid current External Session transcript page',
          );
        }
        return result.result;
      },
      async readAfterTranscript(request) {
        const witness = readWitness();
        const operation = parseCurrentExternalSessionOperation({
          kind: 'external_session.current.read_after_transcript',
          requestId: randomUUID(),
          agentId: binding.agentId,
          source: request.source,
          remoteSessionId: request.remoteSessionId,
          cursor: request.cursor,
          maxBytes: request.maxBytes,
          maxItems: request.maxItems,
          ...(witness ? { witness } : {}),
        });
        const result = await dispatchCurrentExternalSessionOperation(
          operation,
          request.signal,
        );
        if (
          result.kind
            !== 'external_session.current.read_after_transcript'
        ) {
          throw responseError(
            'plugin_external_session_current_response_invalid',
            'Daemon returned an invalid current External Session transcript continuation',
          );
        }
        return result.result;
      },
    });

  const voiceRetirementControllers = new Set<AbortController>();
  let voiceAuthority:
    AgentSessionRealtimeVoiceAuthority | null = null;
  try {
    let response;
    while (true) {
      try {
        response = await dispatchOperation({
          kind: 'voice.authority.snapshot',
          requestId: randomUUID(),
        }, lifetime.signal);
        break;
      } catch (error) {
        lifetime.signal.throwIfAborted();
        if (
          isCurrentRunnerAgentRuntimeDaemonServiceAuthorityTransition(
            error,
          )
        ) {
          continue;
        }
        throw error;
      }
    }
    if (
      response.ok
      && response.result.kind
        === 'voice.authority.snapshot'
      && response.result.agentGeneration
        === binding.immutableGenerationId
    ) {
      const policyAgentRef = Object.freeze({
        pluginId: binding.pluginId,
        localId: binding.localAgentId,
      });
      voiceAuthority = createAgentSessionRealtimeVoiceAuthority({
        generation: response.result.agentGeneration,
        policyAgentRef,
        isAgentRuntimeCurrent: () => !lifetime.signal.aborted,
        providers: response.result.providers.map((provider) => {
          const retirement = new AbortController();
          voiceRetirementControllers.add(retirement);
          const retirementSignal = AbortSignal.any([
            lifetime.signal,
            retirement.signal,
          ]);
          void (async () => {
            const waitForRetirement = async () => {
              const witness = readWitness();
              return await dispatchOperation({
                kind: 'voice.authority.waitRetired',
                requestId: randomUUID(),
                provider: provider.provider,
                providerGeneration:
                  provider.providerGeneration,
                ...(witness ? { witness } : {}),
              }, lifetime.signal);
            };
            let retired;
            while (!lifetime.signal.aborted) {
              try {
                retired = await waitForRetirement();
                break;
              } catch (error) {
                if (
                  isCurrentRunnerAgentRuntimeDaemonServiceAuthorityTransition(
                    error,
                  )
                ) {
                  continue;
                }
                if (!lifetime.signal.aborted) {
                  retirement.abort();
                }
                return;
              }
            }
            if (!retired) return;
            if (
              retired.ok
              && retired.result.kind
                === 'voice.authority.retired'
              && retired.result.providerGeneration
                === provider.providerGeneration
            ) {
              retirement.abort();
              return;
            }
            if (!lifetime.signal.aborted) {
              retirement.abort();
            }
          })();
          return Object.freeze({
            provider: provider.provider,
            declaration: provider.declaration,
            generation: provider.providerGeneration,
            isCurrent: () => !retirementSignal.aborted,
            retirementSignal,
          });
        }),
      });
    }
  } catch {
    voiceAuthority = null;
  }

  return Object.freeze({
    externalSessionHostOperations,
    currentExternalSessionProviderOps,
    agentSessionRealtimeVoiceAuthority: voiceAuthority,
    async dispose() {
      if (lifetime.signal.aborted) return;
      lifetime.abort();
      for (const retirement of voiceRetirementControllers) {
        retirement.abort();
      }
      await Promise.allSettled(
        [...activeFollows].map(async (follow) =>
          await follow.retire()),
      );
    },
  });
}
