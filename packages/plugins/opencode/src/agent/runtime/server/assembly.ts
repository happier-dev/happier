import type { ManagedServerHandleV1, PluginContextV1 } from '@happier-dev/plugin-sdk';

import type { OpenCodeRuntimeTurnOperations } from './operations.js';
import { registerOpenCodeMcpServers } from './mcpRegistration.js';
import { createOpenCodeServerClient } from './openCodeServerClient.js';
import { createOpenCodeServerRuntime } from './runtime.js';
import { createOpenCodeTranscriptSourceDefinition } from './transcript/source.js';

type Disposable = Readonly<{ dispose?: () => void | Promise<void> }>;

export type OpenCodeServerRuntimeAssembly = Readonly<{
  runtime: OpenCodeRuntimeTurnOperations;
  dispose(): Promise<void>;
}>;

async function disposeBestEffort(ctx: PluginContextV1, label: string, disposable: Disposable | null): Promise<void> {
  if (typeof disposable?.dispose !== 'function') return;
  await Promise.resolve(disposable.dispose()).catch((error: unknown) => {
    ctx.logger.debug(`[OpenCodeServer] failed to dispose ${label}`, { error });
  });
}

export async function createOpenCodeServerRuntimeAssembly(params: Readonly<{
  ctx: PluginContextV1;
  directory: string;
  happierSessionId: string;
  baseUrl: string;
  mcpServers?: unknown;
  setThinking?: (thinking: boolean) => void;
}>): Promise<OpenCodeServerRuntimeAssembly> {
  let managedServer: ManagedServerHandleV1 | null = null;
  let transcriptSource: Disposable | null = null;
  let disposed = false;
  try {
    managedServer = await params.ctx.managedServer.supervise({
      id: 'opencode-server',
      launch: {
        kind: 'agent-cli',
        agentId: 'opencode',
        args: ['serve', '--hostname', '127.0.0.1'],
        cwd: params.directory,
      },
      healthCheck: {
        kind: 'http',
        url: `${params.baseUrl.replace(/\/+$/u, '')}/global/health`,
        timeoutMs: 5_000,
      },
      startupTimeoutMs: 30_000,
    });
    await managedServer.waitUntilHealthy({ timeoutMs: 30_000 });
    const client = createOpenCodeServerClient({
      fetch: params.ctx.fetch,
      baseUrl: params.baseUrl,
    });
    const resolvedMcpServers = await params.ctx.mcp.resolveForSession({
      sessionId: params.happierSessionId,
      directory: params.directory,
    });
    await registerOpenCodeMcpServers({
      ctx: params.ctx,
      client,
      directory: params.directory,
      mcpServers: params.mcpServers,
      resolvedMcpServers,
    });
    const runtime = createOpenCodeServerRuntime({
      ctx: params.ctx,
      directory: params.directory,
      happierSessionId: params.happierSessionId,
      baseUrl: params.baseUrl,
      client,
      setThinking: params.setThinking,
    });
    transcriptSource = await params.ctx.transcripts.defineSource({
      ...createOpenCodeTranscriptSourceDefinition({
        id: `opencode:${params.happierSessionId}:http-sse`,
        client: {
          mcpAdd: async () => undefined,
          sessionCreate: async () => {
            throw new Error('Transcript source does not create OpenCode sessions.');
          },
          sessionPromptAsync: async () => undefined,
          sessionAbort: async () => undefined,
          sessionStatus: async () => ({}),
          sessionMessages: async ({ sessionId }) => {
            const identity = runtime.readSessionIdentity().sessionId;
            if (!identity || identity !== sessionId) return [];
            const response = await params.ctx.fetch({
              url: `${params.baseUrl.replace(/\/+$/u, '')}/session/${encodeURIComponent(sessionId)}/message`,
              method: 'GET',
              headers: { 'content-type': 'application/json' },
            });
            if (!response.ok) {
              throw new Error(`OpenCode transcript source request failed: ${response.status} ${response.statusText ?? ''}`.trim());
            }
            const messages = await response.json();
            return Array.isArray(messages) ? messages : [];
          },
          sessionTodo: async () => [],
          subscribeGlobalEvents: async () => undefined,
          providersList: async () => [],
        },
        readProviderSessionId: () => runtime.readSessionIdentity().sessionId,
      }),
    });
    params.ctx.session.permissions.getMode();

    const dispose = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      await runtime.resetOrDisposeRuntime();
      await disposeBestEffort(params.ctx, 'transcript source', transcriptSource);
      await disposeBestEffort(params.ctx, 'managed server', managedServer);
    };

    return {
      runtime: {
        ...runtime,
        resetOrDisposeRuntime: dispose,
      },
      dispose,
    };
  } catch (error) {
    await disposeBestEffort(params.ctx, 'transcript source', transcriptSource);
    await disposeBestEffort(params.ctx, 'managed server', managedServer);
    throw error;
  }
}
