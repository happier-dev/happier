import { randomUUID } from 'node:crypto';

import type {
  AgentAcpRuntimeOptions,
} from '@happier-dev/plugin-sdk/agent-runtime';

import {
  AgentRuntimeDaemonAcpOptionsV1Schema,
  type AgentRuntimeDaemonAcpResolvedExecutableV1,
  type AgentRuntimeDaemonAcpOptionsV1,
} from './agentRuntimeDaemonAcpReverseSessionProtocol';

export type AgentRuntimeDaemonAcpCallbackKind =
  | 'auth.selectMethod'
  | 'model.project'
  | 'model.projectUpdate'
  | 'model.projectSetModelResponse'
  | 'tool.resolveName'
  | 'tool.sanitizeUpdate'
  | 'generatedMedia.projectTerminalOutput'
  | 'history.projectUserMessageProviderCheckpoint'
  | 'history.fork.buildParams'
  | 'history.fork.readProviderSessionId'
  | 'history.createConversationRollback'
  | 'extension.request'
  | 'extension.notification';

type CallbackEntry = Readonly<{
  kind: AgentRuntimeDaemonAcpCallbackKind;
  callback: unknown;
}>;

export type AgentRuntimeDaemonAcpCallbackRegistry = Readonly<{
  get size(): number;
  register(kind: AgentRuntimeDaemonAcpCallbackKind, callback: unknown): string;
  get(kind: AgentRuntimeDaemonAcpCallbackKind, callbackId: string): unknown;
  dispose(): void;
}>;

export function createAgentRuntimeDaemonAcpCallbackRegistry():
AgentRuntimeDaemonAcpCallbackRegistry {
  const callbacks = new Map<string, CallbackEntry>();
  let disposed = false;
  return Object.freeze({
    get size() {
      return callbacks.size;
    },
    register(kind, callback) {
      if (disposed) {
        throw new Error('ACP reverse-session callback registry is disposed');
      }
      const callbackId = randomUUID();
      callbacks.set(callbackId, Object.freeze({ kind, callback }));
      return callbackId;
    },
    get(kind, callbackId) {
      if (disposed) {
        throw new Error('ACP reverse-session callback registry is disposed');
      }
      const entry = callbacks.get(callbackId);
      if (!entry) {
        throw new Error('ACP reverse-session callback is unavailable or stale');
      }
      if (entry.kind !== kind) {
        throw new Error(
          `ACP reverse-session callback kind mismatch: expected ${entry.kind}, received ${kind}`,
        );
      }
      return entry.callback;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      callbacks.clear();
    },
  });
}

export function encodeAgentRuntimeDaemonAcpOptionsV1(
  options: AgentAcpRuntimeOptions,
  callbacks: AgentRuntimeDaemonAcpCallbackRegistry,
  resolvedExecutable?: AgentRuntimeDaemonAcpResolvedExecutableV1,
): AgentRuntimeDaemonAcpOptionsV1 {
  const definition = options.definition;
  const auth = definition?.auth;
  const models = definition?.models;
  const history = definition?.history;
  const fork = history?.fork;
  const encoded = {
    transport: options.transport,
    ...(resolvedExecutable ? { resolvedExecutable } : {}),
    ...(definition
      ? {
          definition: {
            ...(auth
              ? 'methodId' in auth
                ? { auth: { kind: 'method' as const, methodId: auth.methodId } }
                : {
                    auth: {
                      kind: 'callback' as const,
                      callbackId: callbacks.register(
                        'auth.selectMethod',
                        auth.selectMethod,
                      ),
                    },
                  }
              : {}),
            ...(definition.parameterizedModelPicker === undefined
              ? {}
              : { parameterizedModelPicker: definition.parameterizedModelPicker }),
            ...(definition.modelConfigOptionId === undefined
              ? {}
              : { modelConfigOptionId: definition.modelConfigOptionId }),
            ...(models
              ? {
                  models: {
                    projectModelCallbackId: callbacks.register(
                      'model.project',
                      models.projectModel,
                    ),
                    ...(models.projectUpdate
                      ? {
                          projectUpdateCallbackId: callbacks.register(
                            'model.projectUpdate',
                            models.projectUpdate,
                          ),
                        }
                      : {}),
                    ...(models.projectSetModelResponse
                      ? {
                          projectSetModelResponseCallbackId: callbacks.register(
                            'model.projectSetModelResponse',
                            models.projectSetModelResponse,
                          ),
                        }
                      : {}),
                  },
                }
              : {}),
            ...(definition.acceptsVerifiedImageInput
              ? { acceptsVerifiedImageInput: true as const }
              : {}),
            ...(definition.timeouts ? { timeouts: definition.timeouts } : {}),
            ...(definition.toolNameInference
              ? { toolNameInference: definition.toolNameInference }
              : {}),
            ...(definition.stderrRules ? { stderrRules: definition.stderrRules } : {}),
            ...(definition.toolNameResolver
              ? {
                  toolNameResolverCallbackId: callbacks.register(
                    'tool.resolveName',
                    definition.toolNameResolver,
                  ),
                }
              : {}),
            ...(definition.sanitizeToolUpdateContent
              ? {
                  sanitizeToolUpdateContentCallbackId: callbacks.register(
                    'tool.sanitizeUpdate',
                    definition.sanitizeToolUpdateContent,
                  ),
                }
              : {}),
            ...(definition.generatedMedia
              ? {
                  generatedMedia: {
                    projectTerminalOutputCallbackId: callbacks.register(
                      'generatedMedia.projectTerminalOutput',
                      definition.generatedMedia.projectTerminalOutput,
                    ),
                  },
                }
              : {}),
            ...(history
              ? {
                  history: {
                    projectUserMessageProviderCheckpointCallbackId: callbacks.register(
                      'history.projectUserMessageProviderCheckpoint',
                      history.projectUserMessageProviderCheckpoint,
                    ),
                    ...(fork
                      ? {
                          fork: {
                            methods: [...fork.methods],
                            buildParamsCallbackId: callbacks.register(
                              'history.fork.buildParams',
                              fork.buildParams,
                            ),
                            readProviderSessionIdCallbackId: callbacks.register(
                              'history.fork.readProviderSessionId',
                              fork.readProviderSessionId,
                            ),
                          },
                        }
                      : {}),
                    ...(history.createConversationRollback
                      ? {
                          createConversationRollbackCallbackId: callbacks.register(
                            'history.createConversationRollback',
                            history.createConversationRollback,
                          ),
                        }
                      : {}),
                  },
                }
              : {}),
            mcp: definition.mcp,
          },
        }
      : {}),
    ...(!options.extensions
      ? {}
      : {
          extensions: [
            ...Object.entries(options.extensions.requests ?? {}).map(
              ([method, callback]) => ({
                kind: 'request' as const,
                method,
                callbackId: callbacks.register('extension.request', callback),
              }),
            ),
            ...Object.entries(options.extensions.notifications ?? {}).map(
              ([method, callback]) => ({
                kind: 'notification' as const,
                method,
                callbackId: callbacks.register('extension.notification', callback),
              }),
            ),
          ],
        }),
  };
  return AgentRuntimeDaemonAcpOptionsV1Schema.parse(encoded);
}
