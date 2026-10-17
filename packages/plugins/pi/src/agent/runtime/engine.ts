import {
  type AgentExecutionRunOpenRequest,
  type AgentExecutionRunRuntime,
  type AgentExecutionRunRuntimeContextV1,
  type AgentRuntimeFactory,
  type AgentSessionOpenRequest,
  type AgentSessionRuntime,
  type AgentSessionRuntimeContext,
  createExecutionRunHostBackendFromConversationRuntime,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { PluginError } from '@happier-dev/plugin-sdk';
import { SESSION_CAPABILITY_NOTICE_SIDECAR_KEY } from '@happier-dev/plugin-sdk/sessions';

import {
  createPiRuntimeOperations,
  createPiExecutionRunConversation,
  createPiSessionOpenLifecycle,
} from './rpc/operations.js';
import {
  preparePiQualifiedConnectedAccounts,
  type PreparedPiQualifiedConnectedAccounts,
} from './qualifiedConnectedAccounts.js';
import {
  preparePiHappierToolsExtension,
  type PreparedPiHappierToolsExtension,
} from '../tools/assets.js';
import { readStrictCanonicalPiAgentRuntimeDescriptorV1 } from '../../protocol/runtimeDescriptorV1.js';

export {
  piExternalSessionsContribution,
} from '../externalSessions/contribution.js';

function readPermissionMode(request: AgentSessionOpenRequest): string | undefined {
  return request.configuration?.permissionIntent.value ?? undefined;
}

function readEnvironment(request: AgentSessionOpenRequest): Readonly<{
  values: Readonly<Record<string, string>>;
  unset: readonly string[];
}> {
  return request.launchEnvironment ?? { values: {}, unset: [] };
}

function resolvePiResumeSessionSelector(request: AgentSessionOpenRequest): string | null {
  if (request.kind !== 'resume') return null;
  const descriptor = readStrictCanonicalPiAgentRuntimeDescriptorV1(
    request.runtimeDescriptorV1,
  );
  if (
    descriptor?.resumeStrategy === 'sessionFileAbsolutePreferred'
    && descriptor.providerSessionId === request.providerSessionId
    && descriptor.sessionFile
  ) {
    return descriptor.sessionFile;
  }
  return request.providerSessionId;
}

async function openPiSession(
  request: AgentSessionOpenRequest,
  context: AgentSessionRuntimeContext,
): Promise<AgentSessionRuntime> {
  if (request.kind === 'fork') {
    throw new Error('Pi does not support native session fork');
  }
  if (request.startupInstructions && !context.session.services.happierTools) {
    throw new PluginError({
      code: 'agent_session_startup_instructions_unsupported',
      retryable: false,
    });
  }
  const lifecycle = createPiSessionOpenLifecycle({
    signal: context.signal,
    onLateCleanupError: (error) => {
      context.services.logger.warn('[PiRuntime] Late session-open resource cleanup failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
  try {
    let prepared: PreparedPiQualifiedConnectedAccounts | null = null;
    let preparedTools: PreparedPiHappierToolsExtension | null = null;
    let runtime: AgentSessionRuntime | null = null;
    try {
      const preparedConnectedAccounts = preparePiQualifiedConnectedAccounts({
        launchEnvironment: readEnvironment(request),
        context: { ...context, signal: lifecycle.signal },
      });
      prepared = await lifecycle.waitFor(
        preparedConnectedAccounts,
        'qualified Connected Account preparation',
        async (latePreparation) => await latePreparation.dispose(),
      );
      const { models, happierTools } = context.session.services;
      if (happierTools || Object.keys(request.mcpServers ?? {}).length > 0) {
        const nativeBridgeResolution = happierTools?.resolveNativeBridge({
          systemPrompt: request.startupInstructions?.instructions,
        }, { signal: lifecycle.signal });
        const config = nativeBridgeResolution ? await lifecycle.waitFor(
          nativeBridgeResolution, 'Happier tools bridge resolution',
        ) : undefined;
        const toolPreparation = preparePiHappierToolsExtension({
          ...(config ? { config } : { directory: request.cwd }),
          mcpServersStrictMode: request.mcpServersStrictMode,
          mcpServers: request.mcpServers, mcpToolPolicy: request.mcpToolPolicy });
        preparedTools = await lifecycle.waitFor(
          toolPreparation,
          'Happier tools extension preparation',
          async (lateTools) => await lateTools.dispose(),
        );
      }
      if (prepared.isInvalidated()) {
        throw new Error('Pi qualified Connected Account launch was invalidated before opening the runtime.');
      }
      runtime = await lifecycle.waitFor(
        createPiRuntimeOperations({
          skills: request.skills,
          services: context.services,
          models,
          logger: context.services.logger,
          cwd: request.cwd,
          env: prepared.launchEnvironment.values,
          unsetEnvKeys: prepared.launchEnvironment.unset,
          permissionMode: readPermissionMode(request),
          resumeSessionSelector: resolvePiResumeSessionSelector(request),
          resumeProviderSessionId: request.kind === 'resume' ? request.providerSessionId : null,
          sessionId: request.sessionId,
          eagerStart: true,
          sessionOpenLifecycle: lifecycle,
          mcpServersStrictMode: request.mcpServersStrictMode,
          async publishCapabilityNotice(notice) {
            await context.session.services.transcripts.publishSessionEvent({
              type: 'message',
              message: notice.items.map(item => `${item.name} couldn't start · ${item.detail ?? item.code}`).join('\n'),
              [SESSION_CAPABILITY_NOTICE_SIDECAR_KEY]: notice,
            });
          },
          ...(preparedTools ? { happierToolsExtension: preparedTools } : {}),
        }),
        'provider runtime startup',
        async (lateRuntime) => await lateRuntime.dispose('runtime_recovery'),
      );
      if (preparedTools) {
        const inner = runtime;
        const tools = preparedTools;
        runtime = {
          ...inner,
          async dispose(reason) {
            try {
              await inner.dispose(reason);
            } finally {
              await tools.dispose();
            }
          },
        };
      }
      runtime = prepared.bind(runtime);
    } catch (error) {
      try {
        await Promise.all([
          runtime?.dispose('runtime_recovery'),
          prepared?.dispose(),
          runtime ? undefined : preparedTools?.dispose(),
        ]);
      } catch (disposeError) {
        throw new AggregateError([error, disposeError], 'Pi session preparation failed');
      }
      throw error;
    }

    if (request.configuration === undefined) {
      lifecycle.remainingMs('session open completion');
      return runtime;
    }
    const configurationUpdate = runtime.updateConfiguration!(request.configuration, { signal: lifecycle.signal });
    let result: Awaited<typeof configurationUpdate>;
    try {
      result = await lifecycle.waitFor(configurationUpdate, 'initial session configuration');
    } catch (error) {
      try {
        await runtime.dispose('runtime_recovery');
      } catch (disposeError) {
        throw new AggregateError([error, disposeError], 'Pi initial session configuration failed');
      }
      throw error;
    }
    if (result.status === 'applied') {
      lifecycle.remainingMs('session open completion');
      return runtime;
    }
    const failureCode = 'diagnostic' in result
      ? result.diagnostic.code
      : result.status;
    const failure = new Error(
      `Pi rejected its initial session configuration (${failureCode})`,
    );
    try {
      await runtime.dispose();
    } catch (disposeError) {
      throw new AggregateError([failure, disposeError], failure.message);
    }
    throw failure;
  } finally {
    lifecycle.dispose();
  }
}

async function openPiExecutionRun(
  request: AgentExecutionRunOpenRequest,
  context: AgentExecutionRunRuntimeContextV1,
): Promise<AgentExecutionRunRuntime> {
  if (request.kind === 'fork') {
    throw new Error('Pi does not support native execution-run fork');
  }
  return await createExecutionRunHostBackendFromConversationRuntime({
    request,
    async openConversation() {
      const lifecycle = createPiSessionOpenLifecycle({
        signal: context.signal,
        onLateCleanupError: (error) => {
          context.services.logger.warn('[PiRuntime] Late execution-run resource cleanup failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        },
      });
      let prepared: PreparedPiQualifiedConnectedAccounts | null = null;
      let preparedTools: PreparedPiHappierToolsExtension | null = null;
      let conversation: Awaited<ReturnType<typeof createPiExecutionRunConversation>> | null = null;
      try {
        prepared = await lifecycle.waitFor(
          preparePiQualifiedConnectedAccounts({
            launchEnvironment: request.launchEnvironment,
            context: { ...context, signal: lifecycle.signal },
          }),
          'qualified Connected Account preparation',
          async (latePreparation) => await latePreparation.dispose(),
        );
        if (prepared.isInvalidated()) {
          throw new Error('Pi qualified Connected Account launch was invalidated before opening the runtime.');
        }
        if (Object.keys(request.mcpServers ?? {}).length > 0) {
          preparedTools = await lifecycle.waitFor(preparePiHappierToolsExtension({
            directory: request.cwd,
            mcpServersStrictMode: request.mcpServersStrictMode,
            mcpServers: request.mcpServers, mcpToolPolicy: request.mcpToolPolicy,
          }), 'MCP tools extension preparation', async lateTools => await lateTools.dispose());
        }
        conversation = await lifecycle.waitFor(
          createPiExecutionRunConversation({
            skills: request.skills,
            services: context.services,
            logger: context.services.logger,
            cwd: request.cwd,
            env: prepared.launchEnvironment.values,
            unsetEnvKeys: prepared.launchEnvironment.unset,
            permissionMode: request.configuration?.permissionIntent.value ?? undefined,
            resumeSessionSelector: request.kind === 'resume' ? request.checkpointId : null,
            resumeProviderSessionId: request.kind === 'resume' ? request.checkpointId : null,
            eagerStart: true,
            sessionOpenLifecycle: lifecycle,
            mcpServersStrictMode: request.mcpServersStrictMode,
            ...(preparedTools ? { happierToolsExtension: preparedTools } : {}),
          }),
          'provider runtime startup',
          async (lateRuntime) => await lateRuntime.dispose(),
        );
        if (preparedTools) {
          const inner = conversation;
          const tools = preparedTools;
          conversation = { ...inner, async dispose() {
            try { await inner.dispose(); }
            finally { await tools.dispose(); }
          } };
        }
        conversation = prepared.bindExecutionRun(conversation);
        if (request.configuration !== undefined) {
          const result = await lifecycle.waitFor(
            conversation.updateConfiguration!(request.configuration, { signal: lifecycle.signal }),
            'initial execution-run configuration',
          );
          if (result.status !== 'applied') {
            await conversation.dispose();
            const failureCode = 'diagnostic' in result ? result.diagnostic.code : result.status;
            throw new Error(`Pi rejected its initial execution-run configuration (${failureCode})`);
          }
        }
        return conversation;
      } catch (error) {
        try {
          await Promise.all([
            conversation?.dispose(),
            prepared?.dispose(),
            conversation ? undefined : preparedTools?.dispose(),
          ]);
        } catch (disposeError) {
          throw new AggregateError([error, disposeError], 'Pi execution-run preparation failed');
        }
        throw error;
      } finally {
        lifecycle.dispose();
      }
    },
    readCheckpointId(event) {
      return event.kind === 'provider-session-id' ? event.providerSessionId : null;
    },
  });
}

export const createPiAgentRuntime: AgentRuntimeFactory = () => ({
  sessions: {
    open: openPiSession,
    executionRunContextV1: { open: openPiExecutionRun },
  },
});
