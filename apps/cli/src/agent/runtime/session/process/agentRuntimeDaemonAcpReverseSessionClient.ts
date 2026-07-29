import { randomUUID } from 'node:crypto';

import {
  AgentRuntimeJsonValueV1Schema,
  AgentSessionRuntimeEventV1Schema,
} from '@happier-dev/protocol/runtime';
import type {
  AgentAcpRuntimeOptions,
  AgentAcpRuntimeExtensions,
  AgentSessionOpenRequest,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agent-runtime';
import type {
  HostCurrentSessionInteractionsService,
} from '@/agent/runtime/state/currentSessionUiTypes';

import {
  createPublicAcpSessionFromAwaitableAdapter,
  type PublicAcpSessionRuntime,
} from '@/agent/acp/runtime/publicSession/createPublicAcpSession';
import {
  AgentRuntimeDaemonAcpCompletionEvidenceV1Schema,
  AgentRuntimeDaemonAcpOpenResultV1Schema,
  AgentRuntimeDaemonAcpDaemonOperationV1Schema,
  parseAgentRuntimeDaemonAcpChildOperationResultV1,
  type AgentRuntimeDaemonAcpChildOperationV1,
  type AgentRuntimeDaemonAcpDaemonOperationV1,
  type AgentRuntimeDaemonAcpOptionsV1,
} from './agentRuntimeDaemonAcpReverseSessionProtocol';
import type {
  AgentRuntimeDaemonSessionOpenRequestV1Schema,
} from './agentRuntimeDaemonBridgeProtocol';
import { z } from 'zod';

type DaemonRequest = (
  operation: AgentRuntimeDaemonAcpDaemonOperationV1,
  signal?: AbortSignal,
) => Promise<unknown>;

type CompletionEvidenceSubmitter = NonNullable<
  Parameters<NonNullable<
    NonNullable<AgentAcpRuntimeOptions['extensions']>['requests']
  >[string]>[1]['currentTurn']
>['submitCompletionEvidence'];

export type CompletionEvidenceHandle = Readonly<{
  id: string;
  turnId: string;
  submit: CompletionEvidenceSubmitter;
}>;

export type CompletionEvidenceState = {
  current: CompletionEvidenceHandle | null;
};

export type ChildAcpReverseSession = Readonly<{
  runtime: AgentSessionRuntime;
  methods: ReadonlySet<
    z.infer<typeof AgentRuntimeDaemonAcpOpenResultV1Schema>['methods'][number]
  >;
  completionEvidence: CompletionEvidenceState;
  historySessionsById: Map<string, Readonly<{
    getProviderSessionId(): string | null;
    requestExtension(
      methods: readonly [string, ...string[]],
      params: z.infer<typeof AgentRuntimeJsonValueV1Schema>,
      options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>,
    ): Promise<z.infer<typeof AgentRuntimeJsonValueV1Schema>>;
  }>>;
  drainForwardedEvents(): Promise<void>;
  dispose(reason?: Parameters<AgentSessionRuntime['dispose']>[0]): Promise<void>;
}>;

function buildExtensionContext(
  context: Parameters<NonNullable<
    NonNullable<AgentAcpRuntimeOptions['extensions']>['requests']
  >[string]>[1],
  completionEvidence: ChildAcpReverseSession['completionEvidence'],
) {
  let completionEvidenceId: string | undefined;
  if (context.currentTurn) {
    const retained = completionEvidence.current;
    if (!retained || retained.turnId !== context.currentTurn.turnId) {
      completionEvidenceId = randomUUID();
      completionEvidence.current = {
        id: completionEvidenceId,
        turnId: context.currentTurn.turnId,
        submit: context.currentTurn.submitCompletionEvidence,
      };
    } else completionEvidenceId = retained.id;
  }
  return {
    method: context.method,
    ...(context.requestId ? { requestId: context.requestId } : {}),
    ...(context.providerSessionId
      ? { providerSessionId: context.providerSessionId }
      : {}),
    ...(context.currentTurn && completionEvidenceId
      ? {
          currentTurn: {
            turnId: context.currentTurn.turnId,
            completionEvidenceId,
          },
        }
      : {}),
  };
}

export async function resolveChildAcpExtensionCallbackResponse<Response extends Readonly<{
  completionEvidence: z.infer<
    typeof AgentRuntimeDaemonAcpCompletionEvidenceV1Schema
  > | null;
}>>(params: Readonly<{
  wireContext: ReturnType<typeof buildExtensionContext>;
  signal: AbortSignal;
  completionEvidence: CompletionEvidenceState;
  readRuntime(): PublicAcpSessionRuntime | null;
  isCurrent(): boolean;
  request(): Promise<unknown>;
  parse(value: unknown): Response;
}>): Promise<Response> {
  try {
    const response = params.parse(await params.request());
    const evidence = response.completionEvidence;
    if (evidence === null) return response;
    if (params.signal.aborted || !params.isCurrent()) {
      await params.readRuntime()?.dispose('runtime_recovery');
      params.signal.throwIfAborted();
      throw new Error('ACP completion evidence belongs to a retired runtime');
    }
    const completionEvidenceId =
      params.wireContext.currentTurn?.completionEvidenceId;
    const handle = params.completionEvidence.current;
    const matchesRetainedTurn = Boolean(
      handle
      && completionEvidenceId
      && handle.id === completionEvidenceId
      && handle.turnId === params.wireContext.currentTurn?.turnId
      && evidence.providerSessionId === params.wireContext.providerSessionId
      && evidence.promptId === params.wireContext.currentTurn?.turnId
    );
    if (!matchesRetainedTurn || !handle) {
      await params.readRuntime()?.dispose('runtime_recovery');
      throw new Error('ACP completion evidence was rejected by the active turn');
    }
    // The daemon response authenticates this exact retained turn/evidence slot.
    // Applying it can still return false when the standard prompt response won
    // the completion race and already settled that same turn. That is a benign
    // acknowledgement, not a reason to retire the runtime or drop queued output.
    handle.submit(evidence);
    params.completionEvidence.current = null;
    return response;
  } catch (error) {
    if (params.wireContext.currentTurn) {
      await params.readRuntime()?.dispose('runtime_recovery');
    }
    throw error;
  }
}

export async function openChildAcpReverseSession(params: Readonly<{
  reverseSessionId: string;
  request: z.infer<typeof AgentRuntimeDaemonSessionOpenRequestV1Schema>;
  options: AgentRuntimeDaemonAcpOptionsV1;
  runtimeContext: AgentSessionRuntimeContext;
  pluginId: string;
  agentId: string;
  isCurrent(): boolean;
  requestDaemon: DaemonRequest;
}>): Promise<ChildAcpReverseSession> {
  const encoded = params.options;
  const definition = encoded.definition;
  const resolvedExecutable = encoded.resolvedExecutable;
  const callbackAuth = definition?.auth?.kind === 'callback'
    ? definition.auth
    : null;
  const completionEvidence: CompletionEvidenceState = { current: null };
  let runtime: PublicAcpSessionRuntime | null = null;
  const historySessionsById = new Map<string, Readonly<{
    getProviderSessionId(): string | null;
    requestExtension(
      methods: readonly [string, ...string[]],
      requestParams: z.infer<typeof AgentRuntimeJsonValueV1Schema>,
      options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>,
    ): Promise<z.infer<typeof AgentRuntimeJsonValueV1Schema>>;
  }>>();
  const callback = async (
    operation: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ) => await params.requestDaemon(AgentRuntimeDaemonAcpDaemonOperationV1Schema.parse({
    ...operation,
    requestId: randomUUID(),
    reverseSessionId: params.reverseSessionId,
  }), signal);

  let rollbackControlId: string | null = null;
  let historySessionId: string | null = null;
  if (definition?.history?.createConversationRollbackCallbackId) {
    historySessionId = randomUUID();
    const result = await callback({
      kind: 'acp.callback.history.createConversationRollback',
      callbackId: definition.history.createConversationRollbackCallbackId,
      historySessionId,
    });
    rollbackControlId = (
      result as Readonly<{ controlId: string }>
    ).controlId;
  }

  const runtimeOptions: AgentAcpRuntimeOptions = {
    transport: encoded.transport,
    ...(definition
      ? {
          definition: {
            ...(definition.auth?.kind === 'method'
              ? { auth: { methodId: definition.auth.methodId } }
              : definition.auth
                ? {
                    auth: {
                      selectMethod: () => null,
                    },
                  }
                : {}),
            ...(definition.parameterizedModelPicker === undefined
              ? {}
              : { parameterizedModelPicker: definition.parameterizedModelPicker }),
            ...(definition.modelConfigOptionId
              ? { modelConfigOptionId: definition.modelConfigOptionId }
              : {}),
            ...(definition.models
              ? {
                  models: {
                    projectModel: (_rawModel, normalizedModel) => normalizedModel,
                    ...(definition.models.projectUpdateCallbackId
                      ? { projectUpdate: () => undefined }
                      : {}),
                    ...(definition.models.projectSetModelResponseCallbackId
                      ? { projectSetModelResponse: () => null }
                      : {}),
                  },
                }
              : {}),
            ...(definition.acceptsVerifiedImageInput
              ? { acceptsVerifiedImageInput: true as const }
              : {}),
            ...(definition.generatedMedia
              ? {
                  generatedMedia: {
                    projectTerminalOutput: () => null,
                  },
                }
              : {}),
            ...(definition.timeouts ? { timeouts: definition.timeouts } : {}),
            ...(definition.toolNameInference
              ? { toolNameInference: definition.toolNameInference }
              : {}),
            ...(definition.stderrRules ? { stderrRules: definition.stderrRules } : {}),
            ...(definition.history
              ? {
                  history: {
                    projectUserMessageProviderCheckpoint: () => null,
                    ...(definition.history.fork
                      ? {
                          fork: {
                            methods: [
                              definition.history.fork.methods[0],
                              ...definition.history.fork.methods.slice(1),
                            ],
                            buildParams: () => ({}),
                            readProviderSessionId: () => null,
                          },
                        }
                      : {}),
                    ...(rollbackControlId
                      ? {
                          createConversationRollback: (historySession) => {
                            historySessionsById.set(historySessionId!, historySession);
                            return Object.freeze({
                            async rollback(
                              request: Parameters<NonNullable<
                                AgentSessionRuntime['conversationRollback']
                              >['rollback']>[0],
                              options?: Parameters<NonNullable<
                                AgentSessionRuntime['conversationRollback']
                              >['rollback']>[1],
                            ) {
                              return await callback({
                                kind: 'acp.callback.history.rollback',
                                controlId: rollbackControlId!,
                                request,
                              }, options?.signal) as Awaited<ReturnType<
                                NonNullable<AgentSessionRuntime['conversationRollback']>['rollback']
                              >>;
                            },
                            async reconcile(
                              request: Parameters<NonNullable<
                                NonNullable<
                                  AgentSessionRuntime['conversationRollback']
                                >['reconcile']
                              >>[0],
                              options?: Parameters<NonNullable<
                                NonNullable<
                                  AgentSessionRuntime['conversationRollback']
                                >['reconcile']
                              >>[1],
                            ) {
                              return await callback({
                                kind: 'acp.callback.history.reconcile',
                                controlId: rollbackControlId!,
                                request,
                              }, options?.signal) as Awaited<ReturnType<NonNullable<
                                NonNullable<
                                  AgentSessionRuntime['conversationRollback']
                                >['reconcile']
                              >>>;
                            },
                            });
                          },
                        }
                      : {}),
                  },
                }
              : {}),
            mcp: definition.mcp,
          },
        }
      : {}),
    ...(encoded.extensions
      ? {
          extensions: {
            requests: Object.freeze(Object.fromEntries(
              encoded.extensions
                .filter((entry) => entry.kind === 'request')
                .map((entry) => [
                  entry.method,
                  async (
                    requestParams: Parameters<NonNullable<
                      AgentAcpRuntimeExtensions['requests']
                    >[string]>[0],
                    context: Parameters<NonNullable<
                      AgentAcpRuntimeExtensions['requests']
                    >[string]>[1],
                  ) => {
                    const wireContext = buildExtensionContext(
                      context,
                      completionEvidence,
                    );
                    const response =
                      await resolveChildAcpExtensionCallbackResponse({
                      wireContext,
                      signal: context.signal,
                      completionEvidence,
                      readRuntime: () => runtime,
                      isCurrent: params.isCurrent,
                      request: async () => await callback({
                        kind: 'acp.callback.extension.request',
                        callbackId: entry.callbackId,
                        params: requestParams,
                        context: wireContext,
                      }, context.signal),
                      parse: (value) => z.object({
                        value: AgentRuntimeJsonValueV1Schema,
                        completionEvidence:
                          AgentRuntimeDaemonAcpCompletionEvidenceV1Schema.nullable(),
                      }).strict().parse(value),
                    });
                    return response.value;
                  },
                ]),
            )),
            notifications: Object.freeze(Object.fromEntries(
              encoded.extensions
                .filter((entry) => entry.kind === 'notification')
                .map((entry) => [
                  entry.method,
                  async (
                    requestParams: Parameters<NonNullable<
                      AgentAcpRuntimeExtensions['notifications']
                    >[string]>[0],
                    context: Parameters<NonNullable<
                      AgentAcpRuntimeExtensions['notifications']
                    >[string]>[1],
                  ) => {
                    const wireContext = buildExtensionContext(
                      context,
                      completionEvidence,
                    );
                    await resolveChildAcpExtensionCallbackResponse({
                      wireContext,
                      signal: context.signal,
                      completionEvidence,
                      readRuntime: () => runtime,
                      isCurrent: params.isCurrent,
                      request: async () => await callback({
                        kind: 'acp.callback.extension.notification',
                        callbackId: entry.callbackId,
                        params: requestParams,
                        context: wireContext,
                      }, context.signal),
                      parse: (value) => z.object({
                        completionEvidence:
                          AgentRuntimeDaemonAcpCompletionEvidenceV1Schema.nullable(),
                      }).strict().parse(value),
                    });
                  },
                ]),
            )),
          },
        }
      : {}),
  };

  runtime = await createPublicAcpSessionFromAwaitableAdapter(
    params.request as AgentSessionOpenRequest,
    runtimeOptions,
    {
      pluginId: params.pluginId,
      agentId: params.agentId,
      signal: params.runtimeContext.signal,
      isCurrent: params.isCurrent,
      systemTools: Object.freeze({
        async resolve(request) {
          if (
            resolvedExecutable?.kind !== 'systemTool'
            || resolvedExecutable.toolId !== request.toolId
          ) {
            throw new Error(
              `ACP system tool '${request.toolId}' was not resolved by the daemon`,
            );
          }
          return Object.freeze({
            toolId: request.toolId,
            launch: Object.freeze({
              kind: 'binary',
              executablePath: resolvedExecutable.command,
              ...(resolvedExecutable.args
                ? { args: resolvedExecutable.args }
                : {}),
              ...(resolvedExecutable.env
                ? { env: resolvedExecutable.env }
                : {}),
            }),
          });
        },
      }),
      managedDependencies: Object.freeze({
        async resolve(request) {
          if (request.pluginId !== params.pluginId) {
            throw new Error('ACP managed-dependency resolution cannot cross plugin identity');
          }
          if (
            resolvedExecutable?.kind !== 'managedDependency'
            || resolvedExecutable.dependencyId !== request.dependencyId
          ) {
            throw new Error(
              `ACP managed dependency '${request.dependencyId}' was not resolved by the daemon`,
            );
          }
          return Object.freeze({
            command: resolvedExecutable.command,
            ...(resolvedExecutable.args
              ? { args: resolvedExecutable.args }
              : {}),
            ...(resolvedExecutable.env
              ? { env: resolvedExecutable.env }
              : {}),
            release() {},
          });
        },
      }),
      interactions: (
        params.runtimeContext.services.sessions.current as typeof params.runtimeContext
          .services.sessions.current & Readonly<{
            interactions: HostCurrentSessionInteractionsService;
          }>
      ).interactions,
      media: params.runtimeContext.services.sessions.current.media,
      models: params.runtimeContext.session.services.models,
      ...(params.request.mcpServers ? { mcpServers: params.request.mcpServers } : {}),
    },
    {
      ...(callbackAuth
        ? {
            selectAuthMethod: async (context) => await callback({
              kind: 'acp.callback.auth.selectMethod',
              callbackId: callbackAuth.callbackId,
              context,
            }) as Awaited<ReturnType<NonNullable<
              Extract<
                NonNullable<AgentAcpRuntimeOptions['definition']>['auth'],
                { selectMethod: unknown }
              >['selectMethod']
            >>>,
          }
        : {}),
      ...(definition?.models
        ? {
            projectModel: async (rawModel, normalizedModel) => await callback({
              kind: 'acp.callback.model.project',
              callbackId: definition.models!.projectModelCallbackId,
              rawModel,
              normalizedModel,
            }) as typeof normalizedModel,
            ...(definition.models.projectUpdateCallbackId
              ? {
                  projectUpdate: async (input) => await callback({
                    kind: 'acp.callback.model.projectUpdate',
                    callbackId: definition.models!.projectUpdateCallbackId!,
                    input,
                  }) as Readonly<{ modelId: string; requestMeta?: Readonly<Record<string, z.infer<typeof AgentRuntimeJsonValueV1Schema>>> }> | null,
                }
              : {}),
            ...(definition.models.projectSetModelResponseCallbackId
              ? {
                  projectSetModelResponse: async (input) => await callback({
                    kind: 'acp.callback.model.projectSetModelResponse',
                    callbackId: definition.models!
                      .projectSetModelResponseCallbackId!,
                    input,
                  }) as typeof input.targetModel | null,
                }
              : {}),
          }
        : {}),
      ...(definition?.toolNameResolverCallbackId
        ? {
            resolveToolName: async (request) => await callback({
              kind: 'acp.callback.tool.resolveName',
              callbackId: definition.toolNameResolverCallbackId!,
              request,
            }) as string | null,
          }
        : {}),
      ...(definition?.sanitizeToolUpdateContentCallbackId
        ? {
            sanitizeToolUpdate: async (update) => await callback({
              kind: 'acp.callback.tool.sanitizeUpdate',
              callbackId: definition.sanitizeToolUpdateContentCallbackId!,
              update,
            }) as Readonly<Record<string, unknown>>,
          }
        : {}),
      ...(definition?.generatedMedia
        ? {
            projectGeneratedMedia: async (input) => await callback({
              kind: 'acp.callback.generatedMedia.projectTerminalOutput',
              callbackId: definition.generatedMedia!
                .projectTerminalOutputCallbackId,
              input,
            }) as readonly Readonly<{ rootPath: string; path: string }>[] | null,
          }
        : {}),
      ...(definition?.history
        ? {
            projectUserMessageProviderCheckpoint: async (input) => (
              AgentRuntimeJsonValueV1Schema.nullable().parse(await callback({
                kind: 'acp.callback.history.projectUserMessageProviderCheckpoint',
                callbackId: definition.history!
                  .projectUserMessageProviderCheckpointCallbackId,
                input,
              }))
            ),
            ...(definition.history.fork
              ? {
                  buildForkParams: async (input) => (
                    AgentRuntimeJsonValueV1Schema.parse(await callback({
                      kind: 'acp.callback.history.fork.buildParams',
                      callbackId: definition.history!.fork!.buildParamsCallbackId,
                      input,
                    }))
                  ),
                  readForkProviderSessionId: async (response) => await callback({
                    kind: 'acp.callback.history.fork.readProviderSessionId',
                    callbackId: definition.history!.fork!
                      .readProviderSessionIdCallbackId,
                    response,
                  }) as string | null,
                }
              : {}),
          }
        : {}),
    },
  );
  const methods = new Set<
    z.infer<typeof AgentRuntimeDaemonAcpOpenResultV1Schema>['methods'][number]
  >([
    ...(runtime.cancel ? ['cancel' as const] : []),
    ...(runtime.updateConfiguration ? ['updateConfiguration' as const] : []),
    ...(runtime.compact ? ['compact' as const] : []),
    ...(runtime.conversationRollback?.rollback ? ['rollback' as const] : []),
    ...(runtime.conversationRollback?.reconcile
      ? ['reconcileRollback' as const]
      : []),
  ]);
  const eventForwardAbort = new AbortController();
  const eventForwardSignal = AbortSignal.any([
    params.runtimeContext.signal,
    eventForwardAbort.signal,
  ]);
  const subscription = runtime.watch(async (event) => {
    await params.requestDaemon({
      kind: 'acp.session.event',
      requestId: randomUUID(),
      reverseSessionId: params.reverseSessionId,
      event: AgentSessionRuntimeEventV1Schema.parse(event),
    }, eventForwardSignal);
  });
  const drainForwardedEvents = async (): Promise<void> =>
    await runtime.drainPendingPublications();
  let disposed = false;
  return Object.freeze({
      runtime,
    methods,
    completionEvidence,
    historySessionsById,
    drainForwardedEvents,
    async dispose(reason = 'session_closed') {
      if (disposed) return;
      disposed = true;
      eventForwardAbort.abort(reason);
      subscription.dispose();
      completionEvidence.current = null;
      historySessionsById.clear();
      await runtime.dispose(reason);
    },
  });
}

export async function applyChildAcpReverseOperation(
  session: ChildAcpReverseSession,
  operation: AgentRuntimeDaemonAcpChildOperationV1,
  signal?: AbortSignal,
): Promise<unknown> {
  let result: unknown;
  switch (operation.kind) {
    case 'acp.session.send':
      result = await session.runtime.send(operation.request, { signal });
      await session.drainForwardedEvents();
      break;
    case 'acp.session.cancel':
      result = session.runtime.cancel
        ? await session.runtime.cancel({
            turnId: operation.turnId,
            reason: operation.reason,
          }, { signal })
        : { status: 'unsupported' };
      break;
    case 'acp.session.updateConfiguration':
      result = session.runtime.updateConfiguration
        ? await session.runtime.updateConfiguration(operation.request, { signal })
        : {
            status: 'unsupported',
            diagnostic: {
              code: 'acp_configuration_unsupported',
              severity: 'info',
            },
          };
      break;
    case 'acp.session.compact':
      result = session.runtime.compact
        ? await session.runtime.compact(operation.request, { signal })
        : {
            status: 'unsupported',
            diagnostic: {
              code: 'acp_compaction_unsupported',
              severity: 'info',
            },
            retryable: false,
          };
      break;
    case 'acp.session.rollback':
      result = session.runtime.conversationRollback?.rollback
        ? await session.runtime.conversationRollback.rollback(
            operation.request,
            { signal },
          )
        : {
            status: 'unsupported',
            diagnostic: {
              code: 'acp_rollback_unsupported',
              severity: 'info',
            },
          };
      break;
    case 'acp.session.reconcileRollback':
      result = session.runtime.conversationRollback?.reconcile
        ? await session.runtime.conversationRollback.reconcile(
            operation.request,
            { signal },
          )
        : {
            status: 'unsupported',
            diagnostic: {
              code: 'acp_rollback_reconcile_unsupported',
              severity: 'info',
            },
          };
      break;
    case 'acp.historySession.requestExtension': {
      const history = session.historySessionsById.get(operation.historySessionId);
      if (!history) throw new Error('ACP history session is unavailable');
      result = await history.requestExtension(
        operation.methods,
        operation.params,
        operation.timeoutMs === undefined && signal === undefined
          ? undefined
          : {
              ...(operation.timeoutMs === undefined
                ? {}
                : { timeoutMs: operation.timeoutMs }),
              ...(signal === undefined ? {} : { signal }),
            },
      );
      break;
    }
    case 'acp.session.dispose':
      await session.dispose(operation.reason);
      result = null;
      break;
  }
  return parseAgentRuntimeDaemonAcpChildOperationResultV1(operation, result);
}
