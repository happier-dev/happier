import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  AgentRuntimeJsonValueV1Schema,
  AgentSessionCompactRequestV1Schema,
  AgentSessionConfigurationSnapshotV1Schema,
  AgentSessionConversationRollbackReconciliationResultV1Schema,
  AgentSessionConversationRollbackRequestV1Schema,
  AgentSessionConversationRollbackResultV1Schema,
  AgentSessionRuntimeEventV1Schema,
  AgentSessionSendRequestV1Schema,
} from '@happier-dev/protocol/runtime';
import type {
  AgentRuntime,
  AgentSessionControlContext,
  AgentSessionCatalogControl,
  AgentSessionContinuationControl,
  AgentSessionGoalControl,
  AgentSessionGoalControlContext,
  AgentSessionRuntimeFactory,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
  AgentSessionRuntimeEvent,
  AgentSessionUsageLimitRecoveryControl,
} from '@happier-dev/plugin-sdk/agent-runtime';
import type {
  AgentSessionRealtimeConversation,
  AgentSessionRealtimeHandle,
  AgentSessionRealtimeLifecycleEvent,
} from '@happier-dev/plugin-sdk/experimental/agent-runtime/realtime';
import type { PluginUiQuestion } from '@happier-dev/plugin-sdk/runtime';
import type { PluginCurrentSessionWorkStatePublisher } from '@happier-dev/plugin-sdk/runtime';
import type {
  HostCurrentSessionInteractionsService,
  HostSessionInteractionRequest,
} from '@/agent/runtime/state/currentSessionUiTypes';
import {
  FEATURE_IDS,
  ProviderErrorV1Schema,
  SessionSystemRecordKindSchema,
  SessionSystemRecordNamespaceSchema,
} from '@happier-dev/protocol';

import { dispatchDaemonAgentRuntimeBridgeRequest } from '@/daemon/controlClient';
import { createAgentSessionRuntimeEventStream } from '@/agent/runtime/session/events/agentSessionRuntimeEventStream';
import {
  AgentRuntimeDaemonSessionDescriptorV1Schema,
  AgentRuntimeDaemonSessionOpenRequestV1Schema,
  AgentRuntimeDaemonBridgeEffectV1Schema,
  AgentRuntimeDaemonExternalSessionFollowEventV1Schema,
  AgentRuntimeDaemonExternalSessionFollowOpenResultV1Schema,
  AgentRuntimeDaemonExternalSessionTakeoverResultV1Schema,
  AgentRuntimeDaemonModelTransitionAuthorizationResultV1Schema,
  AgentRuntimeDaemonSessionModelsSnapshotV1Schema,
  AgentRuntimeDaemonTerminalLaunchRequestV1Schema,
  AgentRuntimeDaemonTurnPayloadV1Schema,
  AgentRuntimeDaemonTurnContributionsResultV1Schema,
  AgentRuntimeDaemonUiApprovalRequestV1Schema,
  AgentRuntimeDaemonUiApprovalResultV1Schema,
  AgentRuntimeDaemonRealtimeAvailabilityV1Schema,
  AgentRuntimeDaemonRealtimeLifecycleEventV1Schema,
  AgentRuntimeDaemonRealtimeStartResultV1Schema,
  AgentRuntimeDaemonRealtimeStopResultV1Schema,
  HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY,
  type AgentRuntimeDaemonBridgeRequestV1,
  type AgentRuntimeDaemonSessionDescriptorV1,
  type AgentRuntimeDaemonTurnContributionsResultV1,
} from './agentRuntimeDaemonBridgeProtocol';
import type {
  SessionModelTransitionProviderTargetAuthorizer,
} from '@/providers/sessions/authorizeSessionModelTransitionTarget';
import type {
  ExternalSessionHostOperationPort,
} from '@/session/external/hostOperationOwner';
import type {
  ExternalSessionHostOperationPortFactory,
} from '@/agent/runtime/registry/engineRegistry/types';
import type {
  HostExternalTranscriptFollowEvent,
} from '@/session/external/privateContract';
import { createAgentRuntimeBridgeEffectPump } from './agentRuntimeBridgeEffectPump';
import { normalizeAgentRuntimeBridgeError } from './agentRuntimeBridgeError';
import {
  applyChildAcpReverseOperation,
  openChildAcpReverseSession,
  type ChildAcpReverseSession,
} from './agentRuntimeDaemonAcpReverseSessionClient';
import {
  AgentRuntimeDaemonAcpOpenResultV1Schema,
  type AgentRuntimeDaemonAcpDaemonOperationV1,
} from './agentRuntimeDaemonAcpReverseSessionProtocol';
import { AgentRuntimeBridgeCompletionReplayCache } from './agentRuntimeBridgeCompletionReplayCache';
import type {
  AgentSessionRealtimeVoiceAuthority,
} from '@/agent/runtime/session/realtime/registerAgentSessionRealtimeVoiceRpc';

const HandoffSchema = z.object({
  v: z.literal(1),
  token: z.string().min(1).max(4_096),
  descriptor: AgentRuntimeDaemonSessionDescriptorV1Schema,
}).strict();

const OpenResultSchema = z.object({
  methods: z.array(z.enum([
    'cancel',
    'updateConfiguration',
    'compact',
    'rollback',
    'reconcileRollback',
  ])).max(5),
}).strict();
const PrepareResultSchema = z.object({
  controls: z.array(z.enum([
    'continuation',
    'goals',
    'catalog',
    'usageLimitRecovery',
  ])).max(4),
}).strict();

const UiQuestionSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string(),
    prompt: z.string(),
    type: z.literal('text'),
    required: z.boolean().optional(),
  }).strict(),
  z.object({
    id: z.string(),
    prompt: z.string(),
    type: z.enum(['single', 'multiple']),
    required: z.boolean().optional(),
    choices: z.array(z.object({
      id: z.string(),
      label: z.string().optional(),
      description: z.string().optional(),
    }).strict()).min(1),
    allowCustom: z.boolean().optional(),
  }).strict(),
]);

const UiOptionsSchema = z.object({ title: z.string().optional() }).strict();
const UiWidgetSchema = z.object({
  placement: z.enum(['beforeComposer', 'afterComposer']),
  lines: z.array(z.string()),
}).strict();

const SendResultSchema = z.union([
  z.object({ status: z.literal('admitted') }).strict(),
  z.object({
    status: z.enum(['rejected', 'unavailable', 'unsupported']),
    diagnostic: z.object({
      code: z.string(),
      severity: z.enum(['info', 'warning', 'error']),
      message: z.string().optional(),
    }).strict(),
    retryable: z.boolean(),
  }).strict(),
]);

const ConfigurationResultSchema = z.union([
  z.object({
    status: z.enum(['applied', 'deferred']),
    changed: z.array(z.string()),
  }).strict(),
  z.object({
    status: z.enum(['rejected', 'unavailable', 'unsupported']),
    diagnostic: z.object({
      code: z.string(),
      severity: z.enum(['info', 'warning', 'error']),
      message: z.string().optional(),
    }).strict(),
  }).strict(),
]);

type BridgeHandoff = z.infer<typeof HandoffSchema>;
const handoffByEnvironment = new WeakMap<
  NodeJS.ProcessEnv,
  Readonly<{ filePath: string; handoff: BridgeHandoff }>
>();
type AgentSessionDisposeReason = NonNullable<
  Parameters<AgentSessionRuntime['dispose']>[0]
>;

export type DaemonAgentRuntimeCarrier = Readonly<{
  descriptor: AgentRuntimeDaemonSessionDescriptorV1;
  runtime: AgentRuntime;
  externalSessionHostOperations: ExternalSessionHostOperationPortFactory;
  agentSessionRealtimeVoiceAuthority:
    AgentSessionRealtimeVoiceAuthority | null;
  retirementSignal: AbortSignal;
  isCurrent(): boolean;
}>;

type DaemonAgentRuntimePromptContributions = Extract<
  AgentRuntimeDaemonTurnContributionsResultV1,
  { kind: 'prompt' }
>;

type ExternalSessionFollowListenerBinding = Readonly<{
  listener(event: HostExternalTranscriptFollowEvent): void | Promise<void>;
  close(): Promise<void>;
}>;

export type DaemonAgentRuntimeTurnContributionsBridge = Readonly<{
  resolvePrompt(params: Readonly<{
    sessionId: string;
    selectedAsset?: Readonly<{ pluginId: string; localId: string }>;
    machineId?: string;
    featureIds?: readonly string[];
    signal?: AbortSignal;
  }>): Promise<DaemonAgentRuntimePromptContributions>;
  transformAgentContext(params: Readonly<{
    sessionId: string;
    payload: Readonly<Record<string, unknown>>;
    signal?: AbortSignal;
  }>): Promise<Readonly<Record<string, unknown>>>;
  transformSessionInput(params: Readonly<{
    sessionId: string;
    payload: Readonly<Record<string, unknown>>;
    signal?: AbortSignal;
  }>): Promise<Readonly<Record<string, unknown>>>;
}>;

const preparedSessionAbandoners = new WeakMap<
  AgentRuntime,
  (sessionId: string) => Promise<void>
>();
const MAX_EXTERNAL_SESSION_FOLLOWS_PER_CHILD_SESSION = 64;
// The daemon owns a 5 s disposal fence. Give its terminal response one
// bounded second to cross the local control transport before timing out.
const EXTERNAL_SESSION_FOLLOW_CLOSE_REQUEST_TIMEOUT_MS = 6_000;
const INITIAL_BRIDGE_CUSTODY_SETTLEMENT_TIMEOUT_MS = 1_000;
const INITIAL_BRIDGE_CUSTODY_RETRY_DELAY_MS = 10;

export async function abandonDaemonAgentRuntimePreparedSession(
  runtime: AgentRuntime,
  sessionId: string,
): Promise<void> {
  await preparedSessionAbandoners.get(runtime)?.(sessionId);
}

function createDaemonExternalSessionHostOperationPortFactory(params: Readonly<{
  handoff: BridgeHandoff;
  isCurrent(): boolean;
  followListeners: Map<string, ExternalSessionFollowListenerBinding>;
}>): ExternalSessionHostOperationPortFactory {
  let boundSessionId: string | null = null;

  return Object.freeze({
    bindSession(sessionIdRaw) {
      const sessionId = sessionIdRaw.trim();
      if (!sessionId) {
        throw new Error('External Session host operation session is invalid');
      }
      if (boundSessionId !== null && boundSessionId !== sessionId) {
        throw new Error(
          'Daemon Agent runtime carrier cannot bind External Session operations to multiple sessions',
        );
      }
      boundSessionId = sessionId;
      let retired = false;
      const followIds = new Set<string>();
      const followClosePromises = new Map<string, Promise<void>>();
      const closeFollow = async (followId: string): Promise<void> => {
        const existing = followClosePromises.get(followId);
        if (existing) {
          await existing;
          return;
        }
        if (!followIds.has(followId)) return;
        const closing = requestWithCancellation({
          handoff: params.handoff,
          sessionId,
          operation: {
            kind: 'session.externalSession.follow.close',
            requestId: randomUUID(),
            followId,
          },
        }).then(() => {
          followIds.delete(followId);
          params.followListeners.delete(followId);
        }).finally(() => {
          followClosePromises.delete(followId);
        });
        followClosePromises.set(followId, closing);
        await closing;
      };
      type FollowOpenOperation = Extract<
        AgentRuntimeDaemonBridgeRequestV1['operation'],
        {
          kind:
            | 'session.externalSession.follow.open'
            | 'session.externalSession.follow.openProviderSession';
        }
      >;
      const executeFollowOpen = async (
        request: Pick<
          Parameters<
            ExternalSessionHostOperationPort['executeFollow']
          >[0],
          'options' | 'listener'
        >,
        buildOperation: (
          requestId: string,
          followId: string,
        ) => FollowOpenOperation,
      ) => {
        if (retired || !params.isCurrent()) {
          return Object.freeze({
            status: 'unavailable' as const,
            code: 'plugin_generation_retired',
          });
        }
        if (
          followIds.size
            >= MAX_EXTERNAL_SESSION_FOLLOWS_PER_CHILD_SESSION
        ) {
          return Object.freeze({
            status: 'unavailable' as const,
            code: 'plugin_external_follow_capacity_exceeded',
          });
        }
        const followId = randomUUID();
        followIds.add(followId);
        const callerSignal = request.options.signal;
        let onCallerAbort: (() => void) | null = null;
        const close = async (): Promise<void> => {
          if (onCallerAbort) {
            callerSignal?.removeEventListener('abort', onCallerAbort);
            onCallerAbort = null;
          }
          await closeFollow(followId);
        };
        // Register before asking the daemon to acquire the follow so an
        // immediately emitted first effect always has a callback target.
        params.followListeners.set(followId, Object.freeze({
          listener: request.listener,
          close,
        }));
        try {
          const result =
            AgentRuntimeDaemonExternalSessionFollowOpenResultV1Schema.parse(
              await requestWithCancellation({
                handoff: params.handoff,
                sessionId,
                operation: buildOperation(randomUUID(), followId),
                ...(request.options.signal
                  ? { signal: request.options.signal }
                  : {}),
              }),
            );
          if (result.status === 'unavailable') {
            await close();
            return result;
          }
          onCallerAbort = () => {
            void close().catch(() => undefined);
          };
          callerSignal?.addEventListener(
            'abort',
            onCallerAbort,
            { once: true },
          );
          if (callerSignal?.aborted) {
            await close();
            return Object.freeze({
              status: 'unavailable' as const,
              code: 'plugin_operation_aborted',
            });
          }
          let disposalPromise: Promise<void> | null = null;
          return Object.freeze({
            status: 'following' as const,
            startingCursor: result.startingCursor,
            subscription: Object.freeze({
              async dispose() {
                const disposal = disposalPromise ??= close();
                try {
                  await disposal;
                } catch (error) {
                  if (disposalPromise === disposal) {
                    disposalPromise = null;
                  }
                  throw error;
                }
              },
            }),
          });
        } catch (error) {
          await close();
          throw error;
        }
      };

      const port: ExternalSessionHostOperationPort = Object.freeze({
        async executeTakeover(request) {
          if (retired || !params.isCurrent()) {
            throw new Error('External Session host operation port is retired');
          }
          if (request.signal?.aborted) {
            const aborted = new Error(
              'External Session takeover was aborted before dispatch',
            ) as Error & { code: string };
            aborted.code = 'plugin_operation_aborted';
            throw aborted;
          }
          try {
            return AgentRuntimeDaemonExternalSessionTakeoverResultV1Schema.parse(
              await requestWithCancellation({
                handoff: params.handoff,
                sessionId,
                operation: {
                  kind: 'session.externalSession.takeover',
                  requestId: randomUUID(),
                  ref: request.ref,
                  source: request.source,
                },
                ...(request.signal ? { signal: request.signal } : {}),
                awaitTerminalOnAbort: true,
              }),
            );
          } catch (error) {
            if (isDaemonBridgeResponseError(error)) throw error;
            const outcomeUnknown = new Error(
              'External Session takeover outcome is unknown',
              { cause: error },
            ) as Error & { code: string };
            outcomeUnknown.code =
              'plugin_external_takeover_outcome_unknown';
            throw outcomeUnknown;
          }
        },
        async executeFollow(request) {
          return await executeFollowOpen(
            request,
            (requestId, followId) => ({
              kind: 'session.externalSession.follow.open',
              requestId,
              followId,
              ref: request.ref,
              source: request.source,
              ...(request.options.cursor
                ? { cursor: request.options.cursor }
                : {}),
            }),
          );
        },
        async executeProviderSessionFollow(request) {
          return await executeFollowOpen(
            request,
            (requestId, followId) => ({
              kind:
                'session.externalSession.follow.openProviderSession',
              requestId,
              followId,
              agentId: request.agentId,
              providerSessionId: request.providerSessionId,
              ...(request.options.cursor
                ? { cursor: request.options.cursor }
                : {}),
            }),
          );
        },
        async retire() {
          if (retired) return;
          retired = true;
          await Promise.allSettled([...followIds].map(async (followId) => {
            try {
              await closeFollow(followId);
            } catch {
              await closeFollow(followId);
            }
          }));
        },
      });
      return port;
    },
  });
}

type CarriedRealtimeProvider = NonNullable<
  NonNullable<
    AgentRuntimeDaemonSessionDescriptorV1['runtimeSurfaces']
  >['realtimeConversation']
>['providers'][number];

function createDaemonRealtimeConversation(params: Readonly<{
  handoff: BridgeHandoff;
  sessionId: string;
  provider: CarriedRealtimeProvider;
}>): AgentSessionRealtimeConversation {
  const provider = {
    identity: params.provider.identity,
    generation: params.provider.generation,
  };
  const conversation: AgentSessionRealtimeConversation = {
    async inspect(options) {
      return AgentRuntimeDaemonRealtimeAvailabilityV1Schema.parse(
        await requestWithCancellation({
          handoff: params.handoff,
          sessionId: params.sessionId,
          operation: {
            kind: 'runtime.realtimeConversation.inspect',
            requestId: randomUUID(),
            provider,
          },
          ...(options?.signal ? { signal: options.signal } : {}),
        }),
      );
    },
    async start(input, options) {
      const result = AgentRuntimeDaemonRealtimeStartResultV1Schema.parse(
        await requestWithCancellation({
          handoff: params.handoff,
          sessionId: params.sessionId,
          operation: {
            kind: 'runtime.realtimeConversation.start',
            requestId: randomUUID(),
            transport: input.transport,
            provider,
          },
          ...(options?.signal ? { signal: options.signal } : {}),
        }),
      );
      if (result.status !== 'started') return result;
      let disposed = false;
      let disposalPromise: Promise<void> | null = null;
      let terminal: AgentSessionRealtimeLifecycleEvent | null = null;
      let watchController: AbortController | null = null;
      const listeners = new Set<
        (event: AgentSessionRealtimeLifecycleEvent) => void
      >();
      const publishTerminal = (
        event: AgentSessionRealtimeLifecycleEvent,
      ) => {
        if (terminal) return;
        terminal = event;
        for (const listener of [...listeners]) listener(event);
        listeners.clear();
      };
      const ensureWatch = () => {
        if (watchController || terminal || disposed) return;
        const controller = new AbortController();
        watchController = controller;
        void requestWithCancellation({
          handoff: params.handoff,
          sessionId: params.sessionId,
          operation: {
            kind: 'runtime.realtimeConversation.handle.watch',
            requestId: randomUUID(),
            handleId: result.handleId,
          },
          signal: controller.signal,
        }).then(
          (value) => publishTerminal(
            AgentRuntimeDaemonRealtimeLifecycleEventV1Schema.parse(value),
          ),
          () => {
            if (disposed || controller.signal.aborted) return;
            publishTerminal({
              kind: 'terminal',
              reason: 'error',
              diagnostic: {
                code: 'agent_runtime_daemon_bridge_lost',
                severity: 'error',
              },
            });
          },
        );
      };
      return {
        status: 'started' as const,
        transport: result.transport,
        handle: Object.freeze({
          async stop(
            stopOptions?: Parameters<AgentSessionRealtimeHandle['stop']>[0],
          ) {
            const stopped = AgentRuntimeDaemonRealtimeStopResultV1Schema.parse(
              await requestWithCancellation({
                handoff: params.handoff,
                sessionId: params.sessionId,
                operation: {
                  kind: 'runtime.realtimeConversation.handle.stop',
                  requestId: randomUUID(),
                  handleId: result.handleId,
                },
                ...(stopOptions?.signal
                  ? { signal: stopOptions.signal }
                  : {}),
              }),
            );
            if (stopped.status === 'stopped') {
              publishTerminal({
                kind: 'terminal',
                reason: 'stopped',
              });
            }
            return stopped;
          },
          watch(listener: Parameters<AgentSessionRealtimeHandle['watch']>[0]) {
            if (terminal) {
              listener(terminal);
              return { dispose() {} };
            }
            listeners.add(listener);
            ensureWatch();
            return {
              dispose() {
                listeners.delete(listener);
              },
            };
          },
          async dispose() {
            if (disposalPromise) return await disposalPromise;
            disposalPromise = (async () => {
              publishTerminal({
                kind: 'terminal',
                reason: 'aborted',
              });
              disposed = true;
              watchController?.abort('disposed');
              try {
                await requestWithCancellation({
                  handoff: params.handoff,
                  sessionId: params.sessionId,
                  operation: {
                    kind: 'runtime.realtimeConversation.handle.dispose',
                    requestId: randomUUID(),
                    handleId: result.handleId,
                  },
                });
              } finally {
                listeners.clear();
              }
            })();
            return await disposalPromise;
          },
        }),
      };
    },
  };
  return Object.freeze(conversation);
}

function readHandoff(env: NodeJS.ProcessEnv): BridgeHandoff | null {
  const filePath =
    env[HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY]?.trim() ?? '';
  if (!filePath) return null;
  const cached = handoffByEnvironment.get(env);
  if (cached?.filePath === filePath) return cached.handoff;
  const handoff = HandoffSchema.parse(
    JSON.parse(readFileSync(filePath, 'utf8')),
  );
  handoffByEnvironment.set(env, Object.freeze({ filePath, handoff }));
  return handoff;
}

const daemonBridgeResponseErrorMarker = Symbol(
  'daemonBridgeResponseErrorMarker',
);

type DaemonBridgeResponseError = Error & Readonly<{
  code: string;
  [daemonBridgeResponseErrorMarker]: true;
}>;

function requireSuccess(
  response: Awaited<ReturnType<typeof dispatchDaemonAgentRuntimeBridgeRequest>>,
) {
  if (response.ok) return response.result;
  const error = new Error(response.error.message) as Error & {
    code: string;
    [daemonBridgeResponseErrorMarker]: true;
  };
  error.code = response.error.code;
  error[daemonBridgeResponseErrorMarker] = true;
  throw error;
}

function isDaemonBridgeResponseError(
  error: unknown,
): error is DaemonBridgeResponseError {
  return error instanceof Error
    && Reflect.get(error, daemonBridgeResponseErrorMarker) === true;
}

function createContext(
  handoff: BridgeHandoff,
  sessionId: string,
): AgentRuntimeDaemonBridgeRequestV1['context'] {
  return {
    token: handoff.token,
    sessionId,
    pluginId: handoff.descriptor.pluginId,
    agentId: handoff.descriptor.agentId,
    generation: handoff.descriptor.generation,
  };
}

async function requestWithCancellation(params: Readonly<{
  handoff: BridgeHandoff;
  sessionId: string;
  operation: AgentRuntimeDaemonBridgeRequestV1['operation'];
  signal?: AbortSignal;
  /**
   * A takeover may cross its canonical commit boundary while cancellation is
   * racing. The daemon owns that boundary, so the child sends cancellation but
   * still awaits the terminal response instead of relabelling a committed
   * success as a local AbortError.
   */
  awaitTerminalOnAbort?: boolean;
}>) {
  const request = {
    v: 1 as const,
    context: createContext(params.handoff, params.sessionId),
    operation: params.operation,
  };
  const supportsCancellation = params.operation.kind !== 'acp.session.event';
  const cancel = () => {
    void dispatchDaemonAgentRuntimeBridgeRequest({
      v: 1,
      context: request.context,
      operation: {
        kind: 'request.cancel',
        requestId: randomUUID(),
        targetRequestId: params.operation.requestId,
      },
    }).catch(() => undefined);
  };
  if (params.signal?.aborted) {
    params.signal.throwIfAborted();
  }
  if (supportsCancellation) {
    params.signal?.addEventListener('abort', cancel, { once: true });
  }
  try {
    return requireSuccess(await dispatchDaemonAgentRuntimeBridgeRequest(request, {
      ...(params.signal && !params.awaitTerminalOnAbort
        ? { signal: params.signal }
        : {}),
      ...(params.operation.kind === 'session.send'
        ? { timeoutMs: null }
        : params.operation.kind === 'session.externalSession.follow.close'
          ? { timeoutMs: EXTERNAL_SESSION_FOLLOW_CLOSE_REQUEST_TIMEOUT_MS }
          : {}),
    }));
  } finally {
    if (supportsCancellation) {
      params.signal?.removeEventListener('abort', cancel);
    }
  }
}

async function requestInitialPrepareWithCustodySettlement(
  params: Parameters<typeof requestWithCancellation>[0],
): ReturnType<typeof requestWithCancellation> {
  const deadlineMs =
    Date.now() + INITIAL_BRIDGE_CUSTODY_SETTLEMENT_TIMEOUT_MS;
  while (true) {
    try {
      return await requestWithCancellation(params);
    } catch (error) {
      if (
        !isDaemonBridgeResponseError(error)
        || error.code !== 'agent_runtime_daemon_bridge_forbidden'
        || Date.now() >= deadlineMs
      ) {
        throw error;
      }
      params.signal?.throwIfAborted();
      await new Promise<void>((resolve) => {
        setTimeout(
          resolve,
          INITIAL_BRIDGE_CUSTODY_RETRY_DELAY_MS,
        );
      });
    }
  }
}

const ForegroundEnvironmentClaimResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    environment: z.record(z.string(), z.string()),
    unsetEnvironmentVariableNames: z.array(z.string()),
    sensitiveEnvironmentVariableNames: z.array(
      z.string().min(1).max(256),
    ).max(256),
  }).strict(),
  z.object({
    ok: z.literal(false),
    error: ProviderErrorV1Schema,
    profileSecretRecovery: z.object({
      requirementNames: z.array(z.string().min(1).max(256)).max(256),
    }).strict().optional(),
  }).strict(),
]);

export async function claimDaemonForegroundAgentRuntimeEnvironment(
  params: Readonly<{
    env: NodeJS.ProcessEnv;
    sessionId: string;
    attemptId: string;
    foregroundSatisfiedProfileSecretRequirementNames: readonly string[];
    signal?: AbortSignal;
  }>,
) {
  const handoff = readHandoff(params.env);
  if (!handoff) {
    throw new Error('Foreground Agent runtime admission capability is missing');
  }
  return ForegroundEnvironmentClaimResultSchema.parse(
    await requestWithCancellation({
      handoff,
      sessionId: params.sessionId,
      operation: {
        kind: 'foreground.environment.claim',
        requestId: randomUUID(),
        attemptId: params.attemptId,
        foregroundSatisfiedProfileSecretRequirementNames:
          [...params.foregroundSatisfiedProfileSecretRequirementNames],
      },
      ...(params.signal ? { signal: params.signal } : {}),
    }),
  );
}

export function tryCreateDaemonSessionModelTransitionProviderAuthorizer(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): SessionModelTransitionProviderTargetAuthorizer | null {
  const handoff = readHandoff(env);
  if (!handoff) return null;
  return async (input) => {
    return AgentRuntimeDaemonModelTransitionAuthorizationResultV1Schema.parse(
      await requestWithCancellation({
        handoff,
        sessionId,
        operation: {
          kind: 'session.modelTransition.authorize',
          requestId: randomUUID(),
          selection: input.selection,
        },
      }),
    );
  };
}

export function tryCreateDaemonAgentRuntimeTurnContributionsBridge(
  env: NodeJS.ProcessEnv = process.env,
): DaemonAgentRuntimeTurnContributionsBridge | null {
  const handoff = readHandoff(env);
  if (!handoff) return null;

  return Object.freeze({
    async resolvePrompt(params) {
      const result = AgentRuntimeDaemonTurnContributionsResultV1Schema.parse(
        await requestWithCancellation({
          handoff,
          sessionId: params.sessionId,
          operation: {
            kind: 'session.turnContributions.resolve',
            requestId: randomUUID(),
            request: {
              kind: 'prompt',
              ...(params.selectedAsset
                ? { selectedAsset: params.selectedAsset }
                : {}),
              ...(params.machineId ? { machineId: params.machineId } : {}),
              ...(params.featureIds
                ? { featureIds: [...params.featureIds] }
                : {}),
            },
          },
          ...(params.signal ? { signal: params.signal } : {}),
        }),
      );
      if (result.kind !== 'prompt') {
        throw new Error(
          'Daemon Agent runtime bridge returned the wrong turn contribution result',
        );
      }
      return result;
    },
    async transformAgentContext(params) {
      const result = AgentRuntimeDaemonTurnContributionsResultV1Schema.parse(
        await requestWithCancellation({
          handoff,
          sessionId: params.sessionId,
          operation: {
            kind: 'session.turnContributions.resolve',
            requestId: randomUUID(),
            request: {
              kind: 'transformAgentContext',
              payload: AgentRuntimeDaemonTurnPayloadV1Schema.parse(
                params.payload,
              ),
            },
          },
          ...(params.signal ? { signal: params.signal } : {}),
        }),
      );
      if (result.kind !== 'transformAgentContext') {
        throw new Error(
          'Daemon Agent runtime bridge returned the wrong turn contribution result',
        );
      }
      return result.payload;
    },
    async transformSessionInput(params) {
      const result = AgentRuntimeDaemonTurnContributionsResultV1Schema.parse(
        await requestWithCancellation({
          handoff,
          sessionId: params.sessionId,
          operation: {
            kind: 'session.turnContributions.resolve',
            requestId: randomUUID(),
            request: {
              kind: 'transformSessionInput',
              payload: AgentRuntimeDaemonTurnPayloadV1Schema.parse(
                params.payload,
              ),
            },
          },
          ...(params.signal ? { signal: params.signal } : {}),
        }),
      );
      if (result.kind !== 'transformSessionInput') {
        throw new Error(
          'Daemon Agent runtime bridge returned the wrong session input transform result',
        );
      }
      return result.payload;
    },
  });
}

function createSessionProxy(params: Readonly<{
  handoff: BridgeHandoff;
  sessionId: string;
  methods: ReadonlySet<z.infer<typeof OpenResultSchema>['methods'][number]>;
  runtimeContext: AgentSessionRuntimeContext;
  isOpening(): boolean;
  beginSessionDispose(): void;
  completeSessionDispose(): void;
  retire(): void;
  goalSources: ReadonlyMap<string, PluginCurrentSessionWorkStatePublisher>;
  externalSessionFollowListeners: Map<
    string,
    ExternalSessionFollowListenerBinding
  >;
}>): Readonly<{ createRuntime(): AgentSessionRuntime }> {
  const stream = createAgentSessionRuntimeEventStream({
    recoveryReserve: {
      maxEvents: 3,
      maxJsonBytes: 1024 * 1024,
    },
  });
  let pollStopped = false;
  let localDisposed = false;
  let afterSequence = -1;
  const mediaRoots = new Map<string, Awaited<
    ReturnType<AgentSessionRuntimeContext['services']['sessions']['current']['media']['registerSourceRoot']>
  >>();
  let modelSnapshot: z.infer<
    typeof AgentRuntimeDaemonSessionModelsSnapshotV1Schema
  > = { models: null };
  const modelListeners = new Set<(snapshot: typeof modelSnapshot) => void>();
  let modelBinding: Readonly<{ dispose(): void }> | null = null;
  type CompletedEffect = Readonly<
    | { kind: 'complete'; result: z.infer<typeof AgentRuntimeJsonValueV1Schema> }
    | { kind: 'fail'; error: Readonly<{ code: string; message: string }> }
  >;
  const completedEffects =
    new AgentRuntimeBridgeCompletionReplayCache<CompletedEffect>();
  const activeInputBindings = new Map<string, Readonly<{ dispose(): void }>>();
  const reverseAcpSessions = new Map<string, ChildAcpReverseSession>();
  const terminalControlPorts = new Map<string, NonNullable<Awaited<ReturnType<
    NonNullable<AgentSessionRuntimeContext['session']['services']['terminalHost']>['controlPort']
  >>>>();
  const hookServerHandles = new Map<string, Awaited<ReturnType<
    AgentSessionRuntimeContext['session']['services']['sessionHooks']['startServer']
  >>>();
  const transcriptFollowHandles = new Map<string, Awaited<ReturnType<
    AgentSessionRuntimeContext['session']['services']['transcripts']['fileFollow']['follow']
  >>>();
  const activeTurnIds = new Set<string>();
  const pendingAcceptedDeliveries = new Map<string, Readonly<{
    inputIds: readonly [string, ...string[]];
    delivery: Extract<
      AgentSessionRuntimeEvent,
      { kind: 'input-delivery-failed' }
    >['delivery'];
  }>>();
  let runtimeEnded = false;
  let latestSteerAvailable: boolean | null = null;
  const effectPump = createAgentRuntimeBridgeEffectPump({ maxActive: 1_024 });
  let localDisposePromise: Promise<void> | null = null;
  const disposeLocalResources = (): Promise<void> => {
    if (localDisposePromise) return localDisposePromise;
    localDisposed = true;
    localDisposePromise = Promise.resolve().then(async () => {
      effectPump.dispose('runtime_recovery');
      modelBinding?.dispose();
      for (const root of mediaRoots.values()) root.dispose();
      for (const binding of activeInputBindings.values()) binding.dispose();
      const asynchronousDisposals: Promise<unknown>[] = [];
      for (const reverse of reverseAcpSessions.values()) {
        asynchronousDisposals.push(reverse.dispose('runtime_recovery'));
      }
      asynchronousDisposals.push(effectPump.whenIdle());
      terminalControlPorts.clear();
      for (const hook of hookServerHandles.values()) {
        asynchronousDisposals.push(hook.dispose());
      }
      for (const transcript of transcriptFollowHandles.values()) {
        asynchronousDisposals.push(transcript.close());
      }
      for (const follow of params.externalSessionFollowListeners.values()) {
        asynchronousDisposals.push(follow.close());
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(asynchronousDisposals),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 250);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
      mediaRoots.clear();
      activeInputBindings.clear();
      reverseAcpSessions.clear();
      hookServerHandles.clear();
      transcriptFollowHandles.clear();
      params.externalSessionFollowListeners.clear();
    });
    return localDisposePromise;
  };

  const admitEvent = (
    event: Parameters<typeof stream.admit>[0],
    useRecoveryReserve = false,
  ): boolean => {
    const admission = stream.admit(event, { useRecoveryReserve });
    return admission.status === 'accepted';
  };

  const terminateForChannelLoss = async (error: unknown): Promise<void> => {
    if (pollStopped) return;
    pollStopped = true;
    params.retire();
    await disposeLocalResources();
    const diagnostic = Object.freeze({
      code: 'agent_runtime_daemon_bridge_lost',
      severity: 'error' as const,
      message: error instanceof Error
        ? error.message
        : 'The daemon-owned Agent runtime bridge became unavailable',
    });
    const nextSequence = (): number => afterSequence + 1;
    for (const pending of [...pendingAcceptedDeliveries.values()]) {
      const event = AgentSessionRuntimeEventV1Schema.parse({
        sequence: nextSequence(),
        sessionId: params.sessionId,
        emittedAtMs: Date.now(),
        kind: 'input-delivery-failed',
        inputIds: pending.inputIds,
        delivery: pending.delivery,
        issue: diagnostic,
        duplicateRisk: 'possible',
      });
      if (!admitEvent(event, true)) break;
      afterSequence = event.sequence;
    }
    for (const turnId of [...activeTurnIds]) {
      const event = AgentSessionRuntimeEventV1Schema.parse({
        sequence: nextSequence(),
        sessionId: params.sessionId,
        emittedAtMs: Date.now(),
        kind: 'turn-cancelled',
        turnId,
        cause: 'runtimeRecovery',
        diagnostic,
      });
      if (!admitEvent(event, true)) break;
      afterSequence = event.sequence;
    }
    const runtimeEnded = AgentSessionRuntimeEventV1Schema.parse({
      sequence: nextSequence(),
      sessionId: params.sessionId,
      emittedAtMs: Date.now(),
      kind: 'runtime-ended',
      cause: 'protocolError',
      retryable: true,
      diagnostic,
    });
    if (admitEvent(runtimeEnded, true)) afterSequence = runtimeEnded.sequence;
    await stream.whenIdle();
  };

  const rememberCompletedEffect = (
    effectId: string,
    completion: CompletedEffect,
  ): void => {
    completedEffects.remember(effectId, completion);
  };

  const forgetCompletedEffect = (effectId: string): void => {
    completedEffects.forget(effectId);
  };

  const completeEffect = async (
    effectId: string,
    result: unknown,
  ): Promise<void> => {
    const parsedResult = AgentRuntimeJsonValueV1Schema.parse(result);
    rememberCompletedEffect(effectId, { kind: 'complete', result: parsedResult });
    await dispatchDaemonAgentRuntimeBridgeRequest({
        v: 1,
        context: createContext(params.handoff, params.sessionId),
        operation: {
          kind: 'effect.complete',
          requestId: randomUUID(),
          effectId,
          result: parsedResult,
        },
      })
      .then((response) => {
        requireSuccess(response);
        forgetCompletedEffect(effectId);
      })
      .catch(() => {
        // The daemon retains an unacknowledged effect. A later poll either
        // observes the retained effect and retries this exact completion, or
        // proves that the first settlement arrived. Never reinterpret an
        // ambiguous completion as effect failure.
      });
  };

  const failEffect = async (effectId: string, error: unknown): Promise<void> => {
    const serializedError = normalizeAgentRuntimeBridgeError(
      error,
      'agent_runtime_child_effect_failed',
    );
    rememberCompletedEffect(effectId, { kind: 'fail', error: serializedError });
    await dispatchDaemonAgentRuntimeBridgeRequest({
        v: 1,
        context: createContext(params.handoff, params.sessionId),
        operation: {
          kind: 'effect.fail',
          requestId: randomUUID(),
          effectId,
          error: serializedError,
        },
      })
      .then((response) => {
        requireSuccess(response);
        forgetCompletedEffect(effectId);
      })
      .catch(() => {
        // Retry the same cached failure if the daemon retains the effect.
      });
  };

  const applyEffect = async (
    rawEffect: z.infer<typeof AgentRuntimeDaemonBridgeEffectV1Schema>,
    signal: AbortSignal,
  ): Promise<void> => {
    const effect = AgentRuntimeDaemonBridgeEffectV1Schema.parse(rawEffect);
    const completed = completedEffects.get(effect.effectId);
    if (completed?.kind === 'complete') {
      await completeEffect(effect.effectId, completed.result);
      return;
    }
    if (completed?.kind === 'fail') {
      await dispatchDaemonAgentRuntimeBridgeRequest({
        v: 1,
        context: createContext(params.handoff, params.sessionId),
        operation: {
          kind: 'effect.fail',
          requestId: randomUUID(),
          effectId: effect.effectId,
          error: completed.error,
        },
      })
        .then((response) => {
          requireSuccess(response);
          forgetCompletedEffect(effect.effectId);
        })
        .catch(() => {
          // The same cached failure remains available for retained redelivery.
        });
      return;
    }
    try {
      switch (effect.kind) {
        case 'effect.cancel':
          effectPump.cancel(effect.targetEffectId);
          await completeEffect(effect.effectId, null);
          return;
        case 'acp.session.open': {
          if (reverseAcpSessions.has(effect.reverseSessionId)) {
            throw new Error('ACP reverse session is already open');
          }
          const reverse = await openChildAcpReverseSession({
            reverseSessionId: effect.reverseSessionId,
            request: effect.request,
            options: effect.options,
            runtimeContext: params.runtimeContext,
            pluginId: params.handoff.descriptor.pluginId,
            agentId: params.handoff.descriptor.agentId,
            isCurrent: () => !pollStopped,
            requestDaemon: async (
              operation: AgentRuntimeDaemonAcpDaemonOperationV1,
              signal?: AbortSignal,
            ) => await requestWithCancellation({
              handoff: params.handoff,
              sessionId: params.sessionId,
              operation,
              signal,
            }),
          });
          reverseAcpSessions.set(effect.reverseSessionId, reverse);
          await completeEffect(effect.effectId, AgentRuntimeDaemonAcpOpenResultV1Schema.parse({
            reverseSessionId: effect.reverseSessionId,
            methods: [...reverse.methods],
          }));
          return;
        }
        case 'acp.session.send':
        case 'acp.session.cancel':
        case 'acp.session.updateConfiguration':
        case 'acp.session.compact':
        case 'acp.session.rollback':
        case 'acp.session.reconcileRollback':
        case 'acp.historySession.requestExtension':
        case 'acp.session.dispose': {
          const reverse = reverseAcpSessions.get(effect.reverseSessionId);
          if (!reverse) throw new Error('ACP reverse session is unavailable');
          const result = await applyChildAcpReverseOperation(
            reverse,
            effect,
            signal,
          );
          if (effect.kind === 'acp.session.dispose') {
            reverseAcpSessions.delete(effect.reverseSessionId);
          }
          await completeEffect(effect.effectId, result);
          return;
        }
        case 'ui.requestApproval': {
          const request = AgentRuntimeDaemonUiApprovalRequestV1Schema.parse(effect.request);
          const result = await params.runtimeContext.ui.requestApproval(request);
          await completeEffect(
            effect.effectId,
            AgentRuntimeDaemonUiApprovalResultV1Schema.parse(result),
          );
          return;
        }
        case 'ui.askQuestions': {
          const questions = z.array(UiQuestionSchema).min(1).parse(effect.questions);
          const normalizedQuestions: PluginUiQuestion[] = questions.map((question) => {
            if (question.type === 'text') return question;
            return {
              ...question,
              choices: [question.choices[0]!, ...question.choices.slice(1)],
            };
          });
          const result = await params.runtimeContext.ui.askQuestions(
            [normalizedQuestions[0]!, ...normalizedQuestions.slice(1)],
            effect.options === undefined ? undefined : UiOptionsSchema.parse(effect.options),
          );
          await completeEffect(effect.effectId, result);
          return;
        }
        case 'ui.confirm':
          await completeEffect(
            effect.effectId,
            await params.runtimeContext.ui.confirm(
              effect.message,
              effect.options === undefined ? undefined : UiOptionsSchema.parse(effect.options),
            ),
          );
          return;
        case 'ui.notify':
          await params.runtimeContext.ui.notify(
            effect.message,
            effect.options === undefined
              ? undefined
              : z.object({
                  severity: z.enum(['info', 'warning', 'error']).optional(),
                }).strict().parse(effect.options),
          );
          await completeEffect(effect.effectId, null);
          return;
        case 'ui.status.set':
          await params.runtimeContext.ui.status.set(effect.key, effect.text);
          await completeEffect(effect.effectId, null);
          return;
        case 'ui.widget.set':
          await params.runtimeContext.ui.widget.set(
            effect.key,
            effect.widget === null ? null : UiWidgetSchema.parse(effect.widget),
          );
          await completeEffect(effect.effectId, null);
          return;
        case 'ui.title.set':
          await params.runtimeContext.ui.title.set(effect.title);
          await completeEffect(effect.effectId, null);
          return;
        case 'ui.composer.replace':
          await params.runtimeContext.ui.composer.replace(effect.text);
          await completeEffect(effect.effectId, null);
          return;
        case 'session.media.registerSourceRoot': {
          const root = await params.runtimeContext.services.sessions.current.media
            .registerSourceRoot({ rootPath: effect.rootPath });
          mediaRoots.set(effect.effectId, root);
          await completeEffect(effect.effectId, effect.effectId);
          return;
        }
        case 'session.media.publishGenerated': {
          const root = mediaRoots.get(effect.sourceId);
          if (!root) throw new Error('Agent runtime media source root is unavailable');
          const request = z.object({
            localId: z.string(),
            path: z.string(),
            referencePaths: z.array(z.string()).optional(),
            description: z.string().optional(),
            toolCallId: z.string().optional(),
            createdAtMs: z.number().optional(),
          }).strict().parse(effect.request);
          await completeEffect(effect.effectId, await root.publishGenerated(request));
          return;
        }
        case 'session.media.disposeSourceRoot':
          mediaRoots.get(effect.sourceId)?.dispose();
          mediaRoots.delete(effect.sourceId);
          await completeEffect(effect.effectId, null);
          return;
        case 'session.current.summary':
          await completeEffect(
            effect.effectId,
            await params.runtimeContext.services.sessions.current.summary(),
          );
          return;
        case 'session.current.send': {
          const request = z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('userText'), text: z.string() }).strict(),
            z.object({
              kind: z.literal('event'),
              eventId: z.string(),
              data: AgentRuntimeJsonValueV1Schema.optional(),
            }).strict(),
            z.object({
              kind: z.literal('structuredMessage'),
              message: AgentRuntimeJsonValueV1Schema,
              delivery: z.enum(['ephemeral', 'committed']),
            }).strict(),
          ]).parse(effect.request);
          await completeEffect(
            effect.effectId,
            await params.runtimeContext.services.sessions.current.send(request),
          );
          return;
        }
        case 'session.models.publish': {
          modelSnapshot =
            AgentRuntimeDaemonSessionModelsSnapshotV1Schema.parse(
              effect.snapshot,
            );
          modelBinding ??= params.runtimeContext.session.services.models.bind({
            read: () => modelSnapshot,
            subscribe(listener) {
              modelListeners.add(listener);
              return Object.freeze({
                dispose() {
                  modelListeners.delete(listener);
                },
              });
            },
          });
          for (const listener of [...modelListeners]) listener(modelSnapshot);
          await completeEffect(effect.effectId, null);
          return;
        }
        case 'session.activeInput.publishStatus': {
          const status = z.object({
            steerAvailable: z.boolean(),
            steerUnavailableReason: z.enum([
              'unsafe_window',
              'user_terminal_draft',
              'turn_settling',
            ]).nullable(),
            stateUpdatedAtMs: z.number(),
            terminalComposerDraftPresent: z.boolean(),
            terminalComposerClearSupported: z.boolean(),
            inFlightConfigurationApplySupported: z.boolean(),
            pendingInputInterruptAndRunLocalId: z.string().nullable(),
            pendingInputInterruptAndRunStateAt: z.number().nullable(),
          }).strict().parse(effect.status);
          params.runtimeContext.session.services.activeInput.publishStatus(status);
          latestSteerAvailable = status.steerAvailable;
          await completeEffect(effect.effectId, null);
          return;
        }
        case 'session.activeInput.bind': {
          activeInputBindings.get(effect.bindingId)?.dispose();
          let initialInFlight = effect.isTurnInFlight;
          let initialCanSteer = effect.canSteer;
          const binding = params.runtimeContext.session.services.activeInput.bind({
            isTurnInFlight: () => activeTurnIds.size > 0 || initialInFlight,
            canSteer: () => latestSteerAvailable ?? initialCanSteer,
            onPromptQueued() {
              initialInFlight = true;
              void requestWithCancellation({
                handoff: params.handoff,
                sessionId: params.sessionId,
                operation: {
                  kind: 'activeInput.onPromptQueued',
                  requestId: randomUUID(),
                  bindingId: effect.bindingId,
                },
              }).catch((error) => terminateForChannelLoss(error));
            },
            async applyPermissionIntentDuringTurn(permissionIntent) {
              const result = await requestWithCancellation({
                handoff: params.handoff,
                sessionId: params.sessionId,
                operation: {
                  kind: 'activeInput.applyPermissionIntent',
                  requestId: randomUUID(),
                  bindingId: effect.bindingId,
                  permissionIntent,
                },
              });
              return z.union([
                z.object({ status: z.literal('applied') }).strict(),
                z.object({ status: z.literal('scheduled_in_turn') }).strict(),
                z.object({
                  status: z.literal('unsupported'),
                  reason: z.string().optional(),
                }).strict(),
                z.object({
                  status: z.literal('failed'),
                  reason: z.string().optional(),
                }).strict(),
              ]).parse(result);
            },
            async clearTerminalComposer(request) {
              const result = await requestWithCancellation({
                handoff: params.handoff,
                sessionId: params.sessionId,
                operation: {
                  kind: 'activeInput.clearTerminalComposer',
                  requestId: randomUUID(),
                  bindingId: effect.bindingId,
                  request,
                },
              });
              return z.union([
                z.object({
                  ok: z.literal(true),
                  status: z.enum(['cleared', 'already_empty']),
                }).strict(),
                z.object({
                  ok: z.literal(false),
                  status: z.enum([
                    'unsupported',
                    'no_live_terminal',
                    'not_safe',
                    'generating',
                    'dialog_open',
                    'capture_unavailable',
                    'clear_failed',
                    'host_dead',
                    'stale_state',
                    'failed',
                  ]),
                  errorCode: z.string().optional(),
                  error: z.string().optional(),
                }).strict(),
              ]).parse(result);
            },
            async interruptPendingInputAndRun(request) {
              return await requestWithCancellation({
                handoff: params.handoff,
                sessionId: params.sessionId,
                operation: {
                  kind: 'activeInput.interruptPendingInputAndRun',
                  requestId: randomUUID(),
                  bindingId: effect.bindingId,
                  request,
                },
              });
            },
          });
          activeInputBindings.set(effect.bindingId, binding);
          await completeEffect(effect.effectId, null);
          return;
        }
        case 'session.activeInput.unbind':
          activeInputBindings.get(effect.bindingId)?.dispose();
          activeInputBindings.delete(effect.bindingId);
          await completeEffect(effect.effectId, null);
          return;
        case 'session.terminal.resolve': {
          const terminalHost = params.runtimeContext.session.services.terminalHost;
          if (!terminalHost) throw new Error('Agent terminal host is unavailable');
          await completeEffect(
            effect.effectId,
            await terminalHost.resolve(effect.request),
          );
          return;
        }
        case 'session.terminal.createOrAttachHost': {
          const terminalHost = params.runtimeContext.session.services.terminalHost;
          if (!terminalHost) throw new Error('Agent terminal host is unavailable');
          await completeEffect(
            effect.effectId,
            await terminalHost.createOrAttachHost(
              effect.request as Parameters<typeof terminalHost.createOrAttachHost>[0],
            ),
          );
          return;
        }
        case 'session.terminal.injectUserPrompt': {
          const terminalHost = params.runtimeContext.session.services.terminalHost;
          if (!terminalHost) throw new Error('Agent terminal host is unavailable');
          await completeEffect(
            effect.effectId,
            await terminalHost.injectUserPrompt(
              effect.handle as Parameters<typeof terminalHost.injectUserPrompt>[0],
              effect.input as Parameters<typeof terminalHost.injectUserPrompt>[1],
            ),
          );
          return;
        }
        case 'session.terminal.interruptTurn': {
          const terminalHost = params.runtimeContext.session.services.terminalHost;
          if (!terminalHost) throw new Error('Agent terminal host is unavailable');
          await terminalHost.interruptTurn(
            effect.handle as Parameters<typeof terminalHost.interruptTurn>[0],
          );
          await completeEffect(effect.effectId, null);
          return;
        }
        case 'session.terminal.evaluateLiveness': {
          const terminalHost = params.runtimeContext.session.services.terminalHost;
          if (!terminalHost) throw new Error('Agent terminal host is unavailable');
          await completeEffect(
            effect.effectId,
            await terminalHost.evaluateLiveness(
              effect.handle as Parameters<typeof terminalHost.evaluateLiveness>[0],
            ),
          );
          return;
        }
        case 'session.terminal.captureInputState': {
          const terminalHost = params.runtimeContext.session.services.terminalHost;
          if (!terminalHost) throw new Error('Agent terminal host is unavailable');
          await completeEffect(
            effect.effectId,
            await terminalHost.captureInputState(
              effect.handle as Parameters<typeof terminalHost.captureInputState>[0],
            ),
          );
          return;
        }
        case 'session.terminal.controlPort.open': {
          const terminalHost = params.runtimeContext.session.services.terminalHost;
          if (!terminalHost) throw new Error('Agent terminal host is unavailable');
          const port = await terminalHost.controlPort(
            effect.handle as Parameters<typeof terminalHost.controlPort>[0],
          );
          if (!port) {
            await completeEffect(effect.effectId, null);
            return;
          }
          const controlPortId = randomUUID();
          terminalControlPorts.set(controlPortId, port);
          await completeEffect(effect.effectId, {
            controlPortId,
            hostKind: port.hostKind,
          });
          return;
        }
        case 'session.terminal.controlPort.call': {
          const port = terminalControlPorts.get(effect.controlPortId);
          if (!port) throw new Error('Agent terminal control port is unavailable');
          const result = effect.method === 'captureScreen'
            ? await port.captureScreen()
            : effect.method === 'sendLiteralText'
              ? await port.sendLiteralText(effect.argument ?? '')
              : effect.method === 'sendRawSequence'
                ? await port.sendRawSequence(effect.argument ?? '')
                : await port.sendSpecialKey(
                    effect.argument as Parameters<typeof port.sendSpecialKey>[0],
                  );
          await completeEffect(effect.effectId, result);
          return;
        }
        case 'session.terminal.dispose': {
          const terminalHost = params.runtimeContext.session.services.terminalHost;
          if (!terminalHost) throw new Error('Agent terminal host is unavailable');
          await terminalHost.dispose(
            effect.handle as Parameters<typeof terminalHost.dispose>[0],
            effect.intent as Parameters<typeof terminalHost.dispose>[1],
          );
          await completeEffect(effect.effectId, null);
          return;
        }
        case 'session.hooks.startServer': {
          const handleId = randomUUID();
          const requestDaemonCallback = async (
            callbackKind:
              | 'session'
              | 'permission'
              | 'statusline'
              | 'defaultPermission'
              | 'permissionTimeoutForTool',
            payload: unknown,
          ) => await requestWithCancellation({
            handoff: params.handoff,
            sessionId: params.sessionId,
            operation: {
              kind: 'session.hooks.callback',
              requestId: randomUUID(),
              callbackId: effect.callbackId,
              callbackKind,
              payload: AgentRuntimeJsonValueV1Schema.parse(payload),
            },
          });
          type HookStartRequest = Parameters<
            typeof params.runtimeContext.session.services.sessionHooks.startServer
          >[0];
          type AwaitableHookStartRequest = Omit<
            HookStartRequest,
            'defaultPermissionHookResponse' | 'permissionRequestTimeoutMsForTool'
          > & Readonly<{
            defaultPermissionHookResponse?: (
              data: Readonly<Record<string, unknown>>,
            ) => unknown | Promise<unknown>;
            permissionRequestTimeoutMsForTool?: (
              toolName: string | null,
            ) => number | null | undefined | Promise<number | null | undefined>;
          }>;
          const startHookServer = params.runtimeContext.session.services.sessionHooks
            .startServer as (
              request: AwaitableHookStartRequest,
            ) => ReturnType<
              typeof params.runtimeContext.session.services.sessionHooks.startServer
            >;
          const hook = await startHookServer({
              ...(effect.request.hasSessionHook
                ? {
                    onSessionHook: async (providerSessionId, data) => {
                      await requestDaemonCallback('session', {
                        providerSessionId,
                        data,
                      });
                    },
                  }
                : {}),
              ...(effect.request.hasPermissionHook
                ? {
                    onPermissionHook: async (data) => (
                      await requestDaemonCallback('permission', data)
                    ),
                  }
                : {}),
              ...(effect.request.hasStatuslineUpdate
                ? {
                    onStatuslineUpdate: async (data) => {
                      await requestDaemonCallback('statusline', data);
                    },
                  }
                : {}),
              ...(effect.request.hasDefaultPermissionHookResponse
                ? {
                    defaultPermissionHookResponse: async (data) => (
                      await requestDaemonCallback('defaultPermission', data)
                    ),
                  }
                : {}),
              ...(effect.request.hasPermissionRequestTimeoutForTool
                ? {
                    permissionRequestTimeoutMsForTool: async (toolName) => {
                      const result = z.discriminatedUnion('kind', [
                        z.object({
                          kind: z.literal('undefined'),
                        }).strict(),
                        z.object({
                          kind: z.literal('value'),
                          value: z.number().nullable(),
                        }).strict(),
                      ]).parse(await requestDaemonCallback(
                        'permissionTimeoutForTool',
                        toolName,
                      ));
                      return result.kind === 'undefined'
                        ? undefined
                        : result.value;
                    },
                  }
                : {}),
              ...(effect.request.sessionHookSecret === undefined
                ? {}
                : { sessionHookSecret: effect.request.sessionHookSecret }),
              ...(effect.request.permissionHookSecret === undefined
                ? {}
                : { permissionHookSecret: effect.request.permissionHookSecret }),
              ...(effect.request.permissionRequestTimeoutMs === undefined
                ? {}
                : {
                    permissionRequestTimeoutMs:
                      effect.request.permissionRequestTimeoutMs,
                  }),
            });
          hookServerHandles.set(handleId, hook);
          await completeEffect(effect.effectId, {
            handleId,
            port: hook.port,
            ...(hook.sessionHookSecretFile
              ? { sessionHookSecretFile: hook.sessionHookSecretFile }
              : {}),
            ...(hook.permissionHookSecretFile
              ? { permissionHookSecretFile: hook.permissionHookSecretFile }
              : {}),
          });
          return;
        }
        case 'session.hooks.resolveForwarderAssets':
          await completeEffect(
            effect.effectId,
            await params.runtimeContext.session.services.sessionHooks
              .resolveForwarderAssets(),
          );
          return;
        case 'session.hooks.createPluginDir':
          await completeEffect(
            effect.effectId,
            await params.runtimeContext.session.services.sessionHooks
              .createPluginDir(
                z.object({
                  files: z.array(z.union([
                    z.object({
                      path: z.string(),
                      json: AgentRuntimeJsonValueV1Schema,
                    }).strict(),
                    z.object({
                      path: z.string(),
                      contents: z.string(),
                    }).strict(),
                  ])),
                }).strict().parse(effect.request),
              ),
          );
          return;
        case 'session.hooks.disposePluginDir':
          await params.runtimeContext.session.services.sessionHooks
            .disposePluginDir(effect.pluginDir);
          await completeEffect(effect.effectId, null);
          return;
        case 'session.hooks.publishProviderTranscript':
          await params.runtimeContext.session.services.sessionHooks
            .publishProviderTranscript(
              effect.request as Parameters<
                AgentSessionRuntimeContext['session']['services']['sessionHooks']['publishProviderTranscript']
              >[0],
            );
          await completeEffect(effect.effectId, null);
          return;
        case 'session.hooks.handle.stop':
          hookServerHandles.get(effect.handleId)?.stop();
          await completeEffect(effect.effectId, null);
          return;
        case 'session.hooks.handle.dispose': {
          const hook = hookServerHandles.get(effect.handleId);
          hookServerHandles.delete(effect.handleId);
          await hook?.dispose();
          await completeEffect(effect.effectId, null);
          return;
        }
        case 'session.transcripts.fileFollow.follow': {
          const follow = await params.runtimeContext.session.services.transcripts
            .fileFollow.follow({
              ...effect.input,
              signal,
              onLine: async (line) => {
                await requestWithCancellation({
                  handoff: params.handoff,
                  sessionId: params.sessionId,
                  operation: {
                    kind: 'session.transcripts.fileFollow.callback',
                    requestId: randomUUID(),
                    callbackId: effect.callbackId,
                    callbackKind: 'line',
                    payload: line,
                  },
                });
              },
              onReset: async (event) => {
                await requestWithCancellation({
                  handoff: params.handoff,
                  sessionId: params.sessionId,
                  operation: {
                    kind: 'session.transcripts.fileFollow.callback',
                    requestId: randomUUID(),
                    callbackId: effect.callbackId,
                    callbackKind: 'reset',
                    payload: event,
                  },
                });
              },
              onError: async (error) => {
                await requestWithCancellation({
                  handoff: params.handoff,
                  sessionId: params.sessionId,
                  operation: {
                    kind: 'session.transcripts.fileFollow.callback',
                    requestId: randomUUID(),
                    callbackId: effect.callbackId,
                    callbackKind: 'error',
                    payload: {
                      message: error instanceof Error
                        ? error.message
                        : String(error),
                    },
                  },
                });
              },
            });
          const handleId = randomUUID();
          transcriptFollowHandles.set(handleId, follow);
          await completeEffect(effect.effectId, { handleId, id: follow.id });
          return;
        }
        case 'session.transcripts.fileFollow.drainNow': {
          const follow = transcriptFollowHandles.get(effect.handleId);
          if (!follow) throw new Error('Agent transcript follow handle is unavailable');
          await follow.drainNow(
            effect.options as Parameters<typeof follow.drainNow>[0],
          );
          await completeEffect(effect.effectId, null);
          return;
        }
        case 'session.transcripts.fileFollow.close': {
          const follow = transcriptFollowHandles.get(effect.handleId);
          transcriptFollowHandles.delete(effect.handleId);
          if (follow) {
            await follow.close(
              effect.options as Parameters<typeof follow.close>[0],
            );
          }
          await completeEffect(effect.effectId, null);
          return;
        }
        case 'session.accountUsage.resolveSourceContext':
          await completeEffect(
            effect.effectId,
            await params.runtimeContext.session.services.accountUsage
              .resolveSourceContext(effect.input, { signal }),
          );
          return;
        case 'session.accountUsage.recordSnapshot':
          await completeEffect(
            effect.effectId,
            await params.runtimeContext.session.services.accountUsage
              .recordSnapshot(
                effect.input as Parameters<
                  AgentSessionRuntimeContext['session']['services']['accountUsage']['recordSnapshot']
                >[0],
                { signal },
              ),
          );
          return;
        case 'session.accountUsage.adoptProvisionalRecord':
          await completeEffect(
            effect.effectId,
            await params.runtimeContext.session.services.accountUsage
              .adoptProvisionalRecord(
                effect.input as Parameters<
                  AgentSessionRuntimeContext['session']['services']['accountUsage']['adoptProvisionalRecord']
                >[0],
                { signal },
              ),
          );
          return;
        case 'session.auth.refreshRuntimeAuth':
          await completeEffect(
            effect.effectId,
            await params.runtimeContext.session.services.auth.refreshRuntimeAuth(
              effect.request as Parameters<
                AgentSessionRuntimeContext['session']['services']['auth']['refreshRuntimeAuth']
              >[0],
              { signal },
            ),
          );
          return;
        case 'session.mcp.resolveServers':
          await completeEffect(
            effect.effectId,
            await params.runtimeContext.session.services.mcp.resolveServers({ signal }),
          );
          return;
        case 'session.externalSession.follow.event': {
          const follow = params.externalSessionFollowListeners.get(
            effect.followId,
          );
          if (!follow) {
            throw new Error(
              'External Session follow callback is unavailable',
            );
          }
          const event =
            AgentRuntimeDaemonExternalSessionFollowEventV1Schema.parse(
              effect.event,
            );
          try {
            await follow.listener(event);
          } catch (error) {
            params.externalSessionFollowListeners.delete(effect.followId);
            await follow.close().catch(() => undefined);
            throw error;
          }
          const terminal = event.kind === 'terminated';
          if (terminal) {
            params.externalSessionFollowListeners.delete(effect.followId);
          }
          await completeEffect(effect.effectId, null);
          // A terminal event ends the subscription lifetime. Close only after
          // acknowledging the effect so daemon-side disposal cannot wait on
          // this still-unsettled delivery.
          if (terminal) {
            void follow.close().catch(() => undefined);
          }
          return;
        }
        case 'session.interactions.request': {
          const current = (
            params.runtimeContext.services.sessions.current as
              typeof params.runtimeContext.services.sessions.current & Readonly<{
                interactions: HostCurrentSessionInteractionsService;
              }>
          );
          const interactionRequest = z.object({
            kind: z.enum(['approval', 'questions', 'confirmation']),
            requestId: z.string(),
          }).passthrough().parse(effect.request) as HostSessionInteractionRequest;
          const interactionResult = interactionRequest.kind === 'approval'
            ? await current.interactions.request(interactionRequest, {
                signal,
                ...(effect.permissionContext
                  ? { permissionContext: effect.permissionContext }
                  : {}),
              })
            : interactionRequest.kind === 'questions'
              ? await current.interactions.request(interactionRequest, { signal })
              : await current.interactions.request(interactionRequest, { signal });
          await completeEffect(
            effect.effectId,
            interactionResult,
          );
          return;
        }
        case 'session.systemRecords.read': {
          const request = z.object({
            namespace: SessionSystemRecordNamespaceSchema,
            localId: z.string().trim().min(1),
          }).strict().parse(effect.request);
          await completeEffect(
            effect.effectId,
            await params.runtimeContext.session.services.systemRecords.read(request),
          );
          return;
        }
        case 'session.systemRecords.write': {
          const request = z.object({
            namespace: SessionSystemRecordNamespaceSchema,
            kind: SessionSystemRecordKindSchema,
            localId: z.string().trim().min(1),
            payload: AgentRuntimeJsonValueV1Schema,
          }).strict().parse(effect.request);
          await params.runtimeContext.session.services.systemRecords.write(request);
          await completeEffect(effect.effectId, null);
          return;
        }
        case 'session.workflow.publishHeadline':
          await params.runtimeContext.session.services.workflowActivity.publishHeadline(
            effect.headline,
          );
          await completeEffect(effect.effectId, null);
          return;
        case 'session.workState.publish': {
          const request = z.object({
            sourceSequence: z.number().int().nonnegative(),
            observedAtMs: z.number().nonnegative(),
            items: z.array(z.object({
              localId: z.string(),
              kind: z.enum(['goal', 'task', 'todo']),
              origin: z.enum(['vendor', 'happier', 'derived']),
              status: z.enum([
                'pending',
                'active',
                'paused',
                'blocked',
                'complete',
                'cancelled',
                'unknown',
              ]),
              title: z.string(),
              statusReason: z.enum([
                'blocked',
                'usageLimited',
                'budgetLimited',
                'interrupted',
              ]).optional(),
              summary: z.string().optional(),
              providerRef: z.string().optional(),
              order: z.number().optional(),
              parentProviderRef: z.string().optional(),
              priority: z.string().optional(),
              progress: z.number().optional(),
              tokenBudget: z.number().nullable().optional(),
              tokensUsed: z.number().optional(),
              timeUsedSeconds: z.number().optional(),
              createdAtMs: z.number().optional(),
              startedAtMs: z.number().optional(),
              completedAtMs: z.number().optional(),
              updatedAtMs: z.number(),
              providerData: AgentRuntimeJsonValueV1Schema.optional(),
            }).passthrough()),
            primaryLocalId: z.string().nullable().optional(),
            truncation: z.discriminatedUnion('reason', [
              z.object({
                reason: z.literal('itemLimit'),
                omittedCount: z.number(),
              }).strict(),
              z.object({
                reason: z.enum(['providerLimit', 'byteLimit']),
                omittedCount: z.number().optional(),
              }).strict(),
            ]).optional(),
          }).strict().parse(effect.request);
          await completeEffect(
            effect.effectId,
            await params.runtimeContext.workState
              .publisher(effect.declaredSourceId)
              .publish(request),
          );
          return;
        }
        case 'factory.goalSource.publish': {
          const publisher = params.goalSources.get(effect.goalSourceId);
          if (!publisher) throw new Error('Agent goal-source bridge handle is unavailable');
          await completeEffect(
            effect.effectId,
            await publisher.publish(z.object({
              sourceSequence: z.number().int().nonnegative(),
              observedAtMs: z.number().nonnegative(),
              items: z.array(z.object({
                localId: z.string(),
                kind: z.enum(['goal', 'task', 'todo']),
                origin: z.enum(['vendor', 'happier', 'derived']),
                status: z.enum([
                  'pending',
                  'active',
                  'paused',
                  'blocked',
                  'complete',
                  'cancelled',
                  'unknown',
                ]),
                title: z.string(),
                updatedAtMs: z.number(),
              }).passthrough()),
              primaryLocalId: z.string().nullable().optional(),
              truncation: z.discriminatedUnion('reason', [
                z.object({
                  reason: z.literal('itemLimit'),
                  omittedCount: z.number(),
                }).strict(),
                z.object({
                  reason: z.enum(['providerLimit', 'byteLimit']),
                  omittedCount: z.number().optional(),
                }).strict(),
              ]).optional(),
            }).strict().parse(effect.request), { signal }),
          );
          return;
        }
        default:
          throw new Error('Unsupported Agent runtime child effect');
      }
    } catch (error) {
      await failEffect(effect.effectId, error);
    }
  };

  const poll = async (): Promise<void> => {
    while (!pollStopped) {
      let result;
      try {
        result = await requestWithCancellation({
          handoff: params.handoff,
          sessionId: params.sessionId,
          operation: {
            kind: 'channel.poll',
            requestId: randomUUID(),
            afterSequence,
          },
        });
      } catch (error) {
        if (
          params.isOpening()
          && error instanceof Error
          && 'code' in error
          && error.code === 'agent_runtime_daemon_bridge_failed'
        ) {
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
          continue;
        }
        await terminateForChannelLoss(error);
        return;
      }
      const batch = z.object({
        events: z.array(AgentSessionRuntimeEventV1Schema).max(1_024),
        effects: z.array(AgentRuntimeDaemonBridgeEffectV1Schema).max(1_024),
      }).strict().parse(result);
      let duplicateEffects = 0;
      for (const effect of batch.effects) {
        const admission = effectPump.admit(
          effect.effectId,
          async (signal) => await applyEffect(effect, signal),
        );
        if (admission === 'overflow') {
          await terminateForChannelLoss(
            new Error('Daemon Agent runtime bridge active-effect bound exceeded'),
          );
          return;
        }
        if (admission === 'duplicate') duplicateEffects += 1;
      }
      if (
        batch.events.length === 0
        && batch.effects.length > 0
        && duplicateEffects === batch.effects.length
      ) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, 25);
          timer.unref?.();
          function done() {
            clearTimeout(timer);
            params.runtimeContext.signal.removeEventListener('abort', done);
            resolve();
          }
          params.runtimeContext.signal.addEventListener('abort', done, {
            once: true,
          });
        });
      }
      const events = batch.events;
      for (const event of events) {
        if (event.sessionId !== params.sessionId || event.sequence <= afterSequence) {
          throw new Error('Daemon Agent runtime bridge emitted an invalid session event');
        }
        const isTurnTerminal = event.kind === 'turn-complete'
          || event.kind === 'turn-failed'
          || event.kind === 'turn-cancelled';
        if (
          runtimeEnded
          || (isTurnTerminal && !activeTurnIds.has(event.turnId))
          || (
            event.kind === 'turn-start'
            && !activeTurnIds.has(event.turnId)
            && activeTurnIds.size >= 1
          )
          || (
            event.kind === 'runtime-ended'
            && (
              activeTurnIds.size > 0
              || pendingAcceptedDeliveries.size > 0
            )
          )
        ) {
          throw new Error(
            'Daemon Agent runtime bridge emitted an invalid lifecycle transition',
          );
        }
        if (event.kind === 'input-accepted' && event.delivery.kind !== 'steer') {
          if (
            pendingAcceptedDeliveries.has(event.delivery.turnId)
            || pendingAcceptedDeliveries.size >= 1
          ) {
            throw new Error(
              'Daemon Agent runtime bridge emitted overlapping input acceptance',
            );
          }
        } else if (event.kind === 'input-delivery-failed') {
          const pending = pendingAcceptedDeliveries.get(event.delivery.turnId);
          if (
            !pending
            || pending.delivery.kind !== event.delivery.kind
            || pending.inputIds.length !== event.inputIds.length
            || pending.inputIds.some(
              (inputId, index) => inputId !== event.inputIds[index],
            )
          ) {
            throw new Error(
              'Daemon Agent runtime bridge emitted an unmatched delivery failure',
            );
          }
        }
        const publication = await stream.publish(event);
        if (publication.status !== 'accepted') {
          await terminateForChannelLoss(
            new Error('Daemon Agent runtime bridge event stream rejected an event'),
          );
          return;
        }
        afterSequence = event.sequence;
        if (event.kind === 'input-accepted' && event.delivery.kind !== 'steer') {
          pendingAcceptedDeliveries.set(event.delivery.turnId, {
            inputIds: event.inputIds,
            delivery: event.delivery,
          });
        } else if (event.kind === 'input-delivery-failed') {
          pendingAcceptedDeliveries.delete(event.delivery.turnId);
        }
        if (event.kind === 'turn-start') {
          activeTurnIds.add(event.turnId);
          pendingAcceptedDeliveries.delete(event.turnId);
        } else if (isTurnTerminal) {
          activeTurnIds.delete(event.turnId);
        }
        if (event.kind === 'runtime-ended') runtimeEnded = true;
      }
    }
  };
  void poll().catch((error) => terminateForChannelLoss(error));
  let createdRuntime: AgentSessionRuntime | null = null;
  const createRuntime = (): AgentSessionRuntime => {
    createdRuntime ??= Object.freeze({
    async send(
      request: Parameters<AgentSessionRuntime['send']>[0],
      options?: Parameters<AgentSessionRuntime['send']>[1],
    ) {
      if (pollStopped) throw new Error('Daemon Agent runtime bridge is unavailable');
      const result = await requestWithCancellation({
        handoff: params.handoff,
        sessionId: params.sessionId,
        signal: options?.signal,
        operation: {
          kind: 'session.send',
          requestId: randomUUID(),
          request: AgentSessionSendRequestV1Schema.parse(request),
        },
      });
      return SendResultSchema.parse(result);
    },
    ...(params.methods.has('cancel') ? {
      async cancel(
        request: Parameters<NonNullable<AgentSessionRuntime['cancel']>>[0],
        options?: Parameters<NonNullable<AgentSessionRuntime['cancel']>>[1],
      ) {
        const result = await requestWithCancellation({
          handoff: params.handoff,
          sessionId: params.sessionId,
          signal: options?.signal,
          operation: {
            kind: 'session.cancel',
            requestId: randomUUID(),
            turnId: request.turnId,
            reason: request.reason,
          },
        });
        return z.union([
          z.object({ status: z.literal('requested'), turnId: z.string() }).strict(),
          z.object({
            status: z.enum(['notRunning', 'unavailable', 'unsupported']),
            diagnostic: z.object({
              code: z.string(),
              severity: z.enum(['info', 'warning', 'error']),
              message: z.string().optional(),
            }).strict().optional(),
          }).strict(),
        ]).parse(result);
      },
    } : {}),
    ...(params.methods.has('updateConfiguration') ? {
      async updateConfiguration(
        request: Parameters<NonNullable<AgentSessionRuntime['updateConfiguration']>>[0],
        options?: Parameters<NonNullable<AgentSessionRuntime['updateConfiguration']>>[1],
      ) {
        const result = await requestWithCancellation({
          handoff: params.handoff,
          sessionId: params.sessionId,
          signal: options?.signal,
          operation: {
            kind: 'session.updateConfiguration',
            requestId: randomUUID(),
            request: AgentSessionConfigurationSnapshotV1Schema.parse(request),
          },
        });
        return ConfigurationResultSchema.parse(result);
      },
    } : {}),
    ...(params.methods.has('compact') ? {
      async compact(
        request: Parameters<NonNullable<AgentSessionRuntime['compact']>>[0],
        options?: Parameters<NonNullable<AgentSessionRuntime['compact']>>[1],
      ) {
        const result = await requestWithCancellation({
          handoff: params.handoff,
          sessionId: params.sessionId,
          signal: options?.signal,
          operation: {
            kind: 'session.compact',
            requestId: randomUUID(),
            request: AgentSessionCompactRequestV1Schema.parse(request),
          },
        });
        return SendResultSchema.parse(result);
      },
    } : {}),
    ...(params.methods.has('rollback') && params.methods.has('reconcileRollback') ? {
      conversationRollback: Object.freeze({
        async rollback(
          request: Parameters<NonNullable<AgentSessionRuntime['conversationRollback']>['rollback']>[0],
          options?: Parameters<NonNullable<AgentSessionRuntime['conversationRollback']>['rollback']>[1],
        ) {
          const result = await requestWithCancellation({
            handoff: params.handoff,
            sessionId: params.sessionId,
            signal: options?.signal,
            operation: {
              kind: 'session.rollback',
              requestId: randomUUID(),
              request: AgentSessionConversationRollbackRequestV1Schema.parse(request),
            },
          });
          return AgentSessionConversationRollbackResultV1Schema.parse(result);
        },
        async reconcile(
          request: Parameters<NonNullable<
            NonNullable<AgentSessionRuntime['conversationRollback']>['reconcile']
          >>[0],
          options?: Parameters<NonNullable<
            NonNullable<AgentSessionRuntime['conversationRollback']>['reconcile']
          >>[1],
        ) {
          const result = await requestWithCancellation({
            handoff: params.handoff,
            sessionId: params.sessionId,
            signal: options?.signal,
            operation: {
              kind: 'session.reconcileRollback',
              requestId: randomUUID(),
              request: AgentSessionConversationRollbackRequestV1Schema.parse(request),
            },
          });
          return AgentSessionConversationRollbackReconciliationResultV1Schema.parse(result);
        },
      }),
    } : {}),
    watch(listener: Parameters<AgentSessionRuntime['watch']>[0]) {
      return stream.watch(listener);
    },
    async dispose(reason: AgentSessionDisposeReason = 'session_closed') {
      if (pollStopped && localDisposed) return;
      pollStopped = true;
      params.beginSessionDispose();
      let disposalFailed = false;
      try {
        await disposeLocalResources();
      } catch {
        disposalFailed = true;
      }
      try {
        await requestWithCancellation({
          handoff: params.handoff,
          sessionId: params.sessionId,
          operation: {
            kind: 'session.dispose',
            requestId: randomUUID(),
            reason,
          },
        });
      } catch {
        disposalFailed = true;
      }
      try {
        await stream.dispose({ timeoutMs: 250 });
      } catch {
        disposalFailed = true;
      }
      if (disposalFailed) {
        // Any incomplete retirement leaves daemon/provider ownership ambiguous.
        // Keep generation admission fenced instead of allowing an overlapping reopen.
        params.retire();
      } else {
        params.completeSessionDispose();
      }
    },
    });
    return createdRuntime;
  };
  return Object.freeze({ createRuntime });
}

export function tryCreateDaemonAgentRuntimeCarrier(
  env: NodeJS.ProcessEnv = process.env,
): DaemonAgentRuntimeCarrier | null {
  const handoff = readHandoff(env);
  if (!handoff) return null;
  let current = true;
  const retirement = new AbortController();
  const retire = () => {
    current = false;
    retirement.abort('daemon_agent_runtime_carrier_retired');
  };
  let preparedSessionId: string | null = null;
  let preparedRequestFingerprint: string | null = null;
  let preparePromise: Promise<void> | null = null;
  let sessionDisposing = false;
  const goalSources = new Map<string, PluginCurrentSessionWorkStatePublisher>();
  const externalSessionFollowListeners = new Map<
    string,
    ExternalSessionFollowListenerBinding
  >();
  const externalSessionHostOperations =
    createDaemonExternalSessionHostOperationPortFactory({
      handoff,
      isCurrent: () => current,
      followListeners: externalSessionFollowListeners,
    });
  const toControlContextWire = (
    context: AgentSessionControlContext,
  ): z.infer<typeof AgentRuntimeJsonValueV1Schema> => AgentRuntimeJsonValueV1Schema.parse({
    cwd: context.session.cwd,
    activity: context.session.activity,
    ...(context.session.providerSessionId
      ? { providerSessionId: context.session.providerSessionId }
      : {}),
    connectedAccounts: context.session.connectedAccounts,
  });
  const ensurePrepared = async (
    request: Parameters<AgentSessionRuntimeFactory['open']>[0],
    signal?: AbortSignal,
  ): Promise<void> => {
    if (sessionDisposing) {
      throw new Error('Daemon Agent runtime carrier session is disposing');
    }
    const parsedRequest = AgentRuntimeDaemonSessionOpenRequestV1Schema.parse(request);
    const fingerprint = JSON.stringify(parsedRequest);
    if (
      preparedSessionId !== null
      && (
        preparedSessionId !== request.sessionId
        || preparedRequestFingerprint !== fingerprint
      )
    ) {
      throw new Error('Daemon Agent runtime carrier cannot prepare multiple sessions');
    }
    if (preparePromise) return await preparePromise;
    preparedSessionId = request.sessionId;
    preparedRequestFingerprint = fingerprint;
    preparePromise = requestInitialPrepareWithCustodySettlement({
      handoff,
      sessionId: request.sessionId,
      signal,
      operation: {
        kind: 'factory.prepare',
        requestId: randomUUID(),
        descriptor: handoff.descriptor,
        request: parsedRequest,
      },
    }).then((value) => {
      const controls = new Set(PrepareResultSchema.parse(value).controls);
      for (const [control, declared] of Object.entries(
        handoff.descriptor.factoryControls,
      )) {
        if (declared && !controls.has(control as never)) {
          throw new Error(
            `Daemon Agent runtime factory omitted declared '${control}' control`,
          );
        }
      }
    }).catch((error) => {
      retire();
      throw error;
    });
    return await preparePromise;
  };
  const controlRequest = async (
    sessionId: string,
    operation: AgentRuntimeDaemonBridgeRequestV1['operation'],
    signal?: AbortSignal,
  ) => {
    if (!current) throw new Error('Daemon Agent runtime carrier is retired');
    return await requestWithCancellation({
      handoff,
      sessionId,
      operation,
      signal,
    });
  };
  const carriedRealtimeProviders = new Map(
    (
      handoff.descriptor.runtimeSurfaces?.realtimeConversation?.providers
      ?? []
    ).map((provider) => [
      `${provider.identity.pluginId}\u0000${provider.identity.localId}`,
      provider,
    ] as const),
  );
  const agentSessionRealtimeVoiceAuthority:
    AgentSessionRealtimeVoiceAuthority | null =
      carriedRealtimeProviders.size > 0
        ? Object.freeze({
            generation:
              handoff.descriptor.immutableGenerationId
              ?? handoff.descriptor.generation,
            policyAgentRef: {
              pluginId: handoff.descriptor.pluginId,
              localId: handoff.descriptor.agentId,
            },
            resolveDeclaration(provider) {
              const declaration = carriedRealtimeProviders.get(
                `${provider.pluginId}\u0000${provider.localId}`,
              )?.declaration;
              return declaration?.kind === 'conversation'
                ? declaration
                : null;
            },
            isCurrent(provider) {
              return current && carriedRealtimeProviders.has(
                `${provider.pluginId}\u0000${provider.localId}`,
              );
            },
            resolveProviderGeneration(provider) {
              return carriedRealtimeProviders.get(
                `${provider.pluginId}\u0000${provider.localId}`,
              )?.generation ?? null;
            },
            resolveRetirementSignal(provider) {
              return carriedRealtimeProviders.has(
                `${provider.pluginId}\u0000${provider.localId}`,
              )
                ? retirement.signal
                : null;
            },
            resolveConversation({ provider }) {
              const carried = carriedRealtimeProviders.get(
                `${provider.pluginId}\u0000${provider.localId}`,
              );
              if (!current || !carried || !preparedSessionId) return null;
              return Object.freeze({
                conversation: createDaemonRealtimeConversation({
                  handoff,
                  sessionId: preparedSessionId,
                  provider: carried,
                }),
                retirementSignal: retirement.signal,
              });
            },
          })
        : null;
  const sessions: AgentSessionRuntimeFactory = Object.freeze({
    ...(handoff.descriptor.factoryControls.continuation ? {
      continuation: Object.freeze({
        async verify(
          request: Parameters<AgentSessionContinuationControl['verify']>[0],
          context: Parameters<AgentSessionContinuationControl['verify']>[1],
          options?: Parameters<AgentSessionContinuationControl['verify']>[2],
        ) {
          await ensurePrepared(request, options?.signal);
          const result = await controlRequest(request.sessionId, {
            kind: 'factory.continuation.verify',
            requestId: randomUUID(),
            request: AgentRuntimeDaemonSessionOpenRequestV1Schema.parse(request),
            context: toControlContextWire(context),
          }, options?.signal);
          return AgentRuntimeJsonValueV1Schema.parse(result) as Awaited<
            ReturnType<NonNullable<AgentSessionRuntimeFactory['continuation']>['verify']>
          >;
        },
      }),
    } : {}),
    ...(handoff.descriptor.factoryControls.goals ? {
      goals: Object.freeze({
        async get(context: AgentSessionGoalControlContext, options?: Readonly<{
          signal?: AbortSignal;
        }>) {
          const goalSourceId = randomUUID();
          goalSources.set(goalSourceId, context.goalSource);
          try {
            const result = await controlRequest(context.session.id, {
              kind: 'factory.goals.get',
              requestId: randomUUID(),
              context: toControlContextWire(context),
              goalSourceId,
            }, options?.signal);
            return AgentRuntimeJsonValueV1Schema.parse(result) as Awaited<
              ReturnType<NonNullable<AgentSessionRuntimeFactory['goals']>['get']>
            >;
          } finally {
            goalSources.delete(goalSourceId);
          }
        },
        async set(
          mutation: Parameters<AgentSessionGoalControl['set']>[0],
          context: Parameters<AgentSessionGoalControl['set']>[1],
          options?: Parameters<AgentSessionGoalControl['set']>[2],
        ) {
          const goalSourceId = randomUUID();
          goalSources.set(goalSourceId, context.goalSource);
          try {
            const result = await controlRequest(context.session.id, {
              kind: 'factory.goals.set',
              requestId: randomUUID(),
              mutation: AgentRuntimeJsonValueV1Schema.parse(mutation),
              context: toControlContextWire(context),
              goalSourceId,
            }, options?.signal);
            return AgentRuntimeJsonValueV1Schema.parse(result) as Awaited<
              ReturnType<NonNullable<AgentSessionRuntimeFactory['goals']>['set']>
            >;
          } finally {
            goalSources.delete(goalSourceId);
          }
        },
        async clear(
          context: Parameters<AgentSessionGoalControl['clear']>[0],
          options?: Parameters<AgentSessionGoalControl['clear']>[1],
        ) {
          const goalSourceId = randomUUID();
          goalSources.set(goalSourceId, context.goalSource);
          try {
            const result = await controlRequest(context.session.id, {
              kind: 'factory.goals.clear',
              requestId: randomUUID(),
              context: toControlContextWire(context),
              goalSourceId,
            }, options?.signal);
            return AgentRuntimeJsonValueV1Schema.parse(result) as Awaited<
              ReturnType<NonNullable<AgentSessionRuntimeFactory['goals']>['clear']>
            >;
          } finally {
            goalSources.delete(goalSourceId);
          }
        },
      }),
    } : {}),
    ...(handoff.descriptor.factoryControls.catalog ? {
      catalog: Object.freeze({
        async list(
          request: Parameters<AgentSessionCatalogControl['list']>[0],
          context: Parameters<AgentSessionCatalogControl['list']>[1],
          options?: Parameters<AgentSessionCatalogControl['list']>[2],
        ) {
          const result = await controlRequest(context.session.id, {
            kind: 'factory.catalog.list',
            requestId: randomUUID(),
            request: AgentRuntimeJsonValueV1Schema.parse(request),
            context: toControlContextWire(context),
          }, options?.signal);
          return AgentRuntimeJsonValueV1Schema.parse(result) as Awaited<
            ReturnType<NonNullable<AgentSessionRuntimeFactory['catalog']>['list']>
          >;
        },
      }),
    } : {}),
    ...(handoff.descriptor.factoryControls.usageLimitRecovery ? {
      usageLimitRecovery: Object.freeze({
        async execute(
          request: Parameters<AgentSessionUsageLimitRecoveryControl['execute']>[0],
          context: Parameters<AgentSessionUsageLimitRecoveryControl['execute']>[1],
          options?: Parameters<AgentSessionUsageLimitRecoveryControl['execute']>[2],
        ) {
          const result = await controlRequest(context.session.id, {
            kind: 'factory.usageLimitRecovery.execute',
            requestId: randomUUID(),
            request: AgentRuntimeJsonValueV1Schema.parse(request),
            context: toControlContextWire(context),
          }, options?.signal);
          return AgentRuntimeJsonValueV1Schema.parse(result) as Awaited<
            ReturnType<
              NonNullable<AgentSessionRuntimeFactory['usageLimitRecovery']>['execute']
            >
          >;
        },
      }),
    } : {}),
    async open(
      request: Parameters<AgentSessionRuntimeFactory['open']>[0],
      context: Parameters<AgentSessionRuntimeFactory['open']>[1],
    ) {
      if (!current) throw new Error('Daemon Agent runtime carrier is retired');
      await ensurePrepared(request, context.signal);
      let opening = true;
      const openPromise = requestWithCancellation({
        handoff,
        sessionId: request.sessionId,
        signal: context.signal,
        operation: {
          kind: 'session.open',
          requestId: randomUUID(),
          descriptor: handoff.descriptor,
          request: AgentRuntimeDaemonSessionOpenRequestV1Schema.parse(request),
          featureDecisions: Object.fromEntries(
            FEATURE_IDS.map((featureId) => [
              featureId,
              context.session.services.features.isEnabled(featureId),
            ]),
          ),
        },
      });
      const methods = new Set<z.infer<typeof OpenResultSchema>['methods'][number]>();
      const proxy = createSessionProxy({
        handoff,
        sessionId: request.sessionId,
        methods,
        runtimeContext: context,
        goalSources,
        externalSessionFollowListeners,
        isOpening: () => opening,
        beginSessionDispose: () => {
          sessionDisposing = true;
        },
        completeSessionDispose: () => {
          if (preparedSessionId !== request.sessionId) {
            retire();
            return;
          }
          preparedSessionId = null;
          preparedRequestFingerprint = null;
          preparePromise = null;
          sessionDisposing = false;
        },
        retire: () => {
          retire();
        },
      });
      try {
        const result = OpenResultSchema.parse(await openPromise);
        opening = false;
        for (const method of result.methods) methods.add(method);
        return proxy.createRuntime();
      } catch (error) {
        opening = false;
        retire();
        await proxy.createRuntime().dispose('runtime_recovery');
        throw error;
      }
    },
  });
  const terminalSurface = handoff.descriptor.runtimeSurfaces?.terminal
    ? Object.freeze({
        async resolveLaunch(
          request: Parameters<
            NonNullable<NonNullable<AgentRuntime['surfaces']>['terminal']>['resolveLaunch']
          >[0],
        ) {
          const parsedRequest =
            AgentRuntimeDaemonTerminalLaunchRequestV1Schema.parse(request);
          const result = await controlRequest(parsedRequest.sessionId, {
            kind: 'runtime.terminal.resolveLaunch',
            requestId: randomUUID(),
            request: parsedRequest,
          });
          return AgentRuntimeJsonValueV1Schema.parse(result) as Awaited<
            ReturnType<
              NonNullable<
                NonNullable<AgentRuntime['surfaces']>['terminal']
              >['resolveLaunch']
            >
          >;
        },
      })
    : null;
  const runtime: AgentRuntime = Object.freeze({
    sessions,
    ...(terminalSurface
      ? { surfaces: Object.freeze({ terminal: terminalSurface }) }
      : {}),
  });
  preparedSessionAbandoners.set(runtime, async (sessionId) => {
    if (preparedSessionId !== sessionId || !preparePromise) return;
    retire();
    await requestWithCancellation({
      handoff,
      sessionId,
      operation: {
        kind: 'factory.abandon',
        requestId: randomUUID(),
      },
    }).catch(() => undefined);
  });
  return Object.freeze({
    descriptor: handoff.descriptor,
    runtime,
    externalSessionHostOperations,
    agentSessionRealtimeVoiceAuthority,
    retirementSignal: retirement.signal,
    isCurrent: () => current,
  });
}
