import { normalizeCursorApiEndpoint } from '@happier-dev/agents';

import { AcpBackend, type AcpBackendOptions, type AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type {
  AgentBackend,
  AgentFactoryOptions,
  AgentMessage,
  AgentMessageHandler,
  McpServerConfig,
  SessionId,
  StartSessionResult,
} from '@/agent/core';
import type { PermissionMode } from '@/api/types';
import { buildCursorExtensionHandlers } from '@/backends/cursor/acp/extensions';
import {
  CursorAvailableModelsContribution,
  projectCursorAvailableModels,
  type CursorAvailableModel,
} from '@/backends/cursor/acp/models';
import { buildCursorSessionModelsFromConfigOptions } from '@/backends/cursor/acp/cursorModelConfig';
import { cursorTransport } from '@/backends/cursor/acp/transport';
import { requireProviderCliLaunchSpec } from '@/runtime/managedTools/requireProviderCliLaunchSpec';

export interface CursorBackendOptions extends AgentFactoryOptions {
  mcpServers?: Record<string, McpServerConfig>;
  permissionHandler?: AcpPermissionHandler;
  permissionMode?: PermissionMode;
}

export class CursorAcpBackend extends AcpBackend {
  private readonly cursorListeners: AgentMessageHandler[] = [];
  private readonly availableModelsContribution = new CursorAvailableModelsContribution({
    onChange: () => this.emitProjectedModels(),
  });

  constructor(options: CursorBackendOptions) {
    const extensionMessageRelay: { emit: (message: AgentMessage) => void } = {
      emit: () => undefined,
    };
    super(buildCursorAcpBackendOptions(options, extensionMessageRelay));
    extensionMessageRelay.emit = (message) => this.emitCursorMessage(message);
    super.onMessage(this.forwardBaseMessage);
  }

  override onMessage(handler: AgentMessageHandler): void {
    this.cursorListeners.push(handler);
  }

  override offMessage(handler: AgentMessageHandler): void {
    const index = this.cursorListeners.indexOf(handler);
    if (index >= 0) this.cursorListeners.splice(index, 1);
  }

  override async startSession(initialPrompt?: string): Promise<StartSessionResult> {
    const generation = this.availableModelsContribution.beginGeneration();
    const result = await super.startSession(initialPrompt);
    await this.discoverAvailableModels(generation);
    return result;
  }

  override async loadSession(sessionId: SessionId): Promise<StartSessionResult> {
    const generation = this.availableModelsContribution.beginGeneration();
    const result = await super.loadSession(sessionId);
    await this.discoverAvailableModels(generation);
    return result;
  }

  override async dispose(): Promise<void> {
    this.availableModelsContribution.invalidate();
    await super.dispose();
    this.cursorListeners.length = 0;
  }

  getCursorAvailableModelsContribution(): ReadonlyArray<CursorAvailableModel> | null {
    return this.availableModelsContribution.current();
  }

  private readonly forwardBaseMessage = (message: AgentMessage): void => {
    this.emitCursorMessage(message);
    if (message.type === 'event'
      && (message.name === 'config_options_state' || message.name === 'config_options_update')) {
      this.emitProjectedModels();
    }
  };

  private async discoverAvailableModels(generation: number): Promise<void> {
    await this.availableModelsContribution.discover(
      generation,
      this.requestExtension.bind(this),
    );
  }

  private emitProjectedModels(): void {
    const standardProjection = buildCursorSessionModelsFromConfigOptions(
      super.getSessionConfigOptionsState(),
    );
    const projected = projectCursorAvailableModels({
      proprietaryModels: this.availableModelsContribution.current() ?? [],
      standardProjection,
    });
    if (!projected) return;
    this.emitCursorMessage({ type: 'event', name: 'session_models_state', payload: projected });
  }

  private emitCursorMessage(message: AgentMessage): void {
    for (const listener of this.cursorListeners) listener(message);
  }
}

function buildCursorAcpArgs(
  baseArgs: readonly string[],
  processEnv: NodeJS.ProcessEnv,
  permissionMode: PermissionMode | undefined,
): string[] {
  const cursorApiEndpoint = normalizeCursorApiEndpoint(processEnv.HAPPIER_CURSOR_API_ENDPOINT);
  return [
    ...baseArgs,
    ...(cursorApiEndpoint ? ['-e', cursorApiEndpoint] : []),
    ...buildCursorPermissionModeArgs(permissionMode),
    'acp',
  ];
}

function buildCursorPermissionModeArgs(permissionMode: PermissionMode | undefined): string[] {
  switch (permissionMode) {
    case 'safe-yolo':
      return ['--force', '--sandbox', 'enabled'];
    case 'yolo':
    case 'bypassPermissions':
      return ['--force'];
    default:
      return [];
  }
}

export function buildCursorAcpBackendOptions(
  options: CursorBackendOptions,
  extensionMessageRelay?: Readonly<{ emit: (message: AgentMessage) => void }>,
): AcpBackendOptions {
  const processEnv = { ...process.env, ...options.env };
  const launch = requireProviderCliLaunchSpec('cursor', { processEnv });

  return {
    agentName: 'cursor',
    cwd: options.cwd,
    command: launch.command,
    args: buildCursorAcpArgs(launch.args, processEnv, options.permissionMode),
    env: {
      ...options.env,
    },
    authentication: { kind: 'static', methodId: 'cursor_login' },
    // Cursor otherwise exposes only its default variant, which can force Fast on.
    initializeClientCapabilitiesMeta: { parameterizedModelPicker: true },
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: cursorTransport,
    ...(options.permissionHandler
      ? {
          extensionHandlers: buildCursorExtensionHandlers({
            permissionHandler: options.permissionHandler,
            emitAgentMessage: extensionMessageRelay
              ? (message) => extensionMessageRelay.emit(message)
              : undefined,
          }),
        }
      : {}),
  };
}

export function createCursorBackend(options: CursorBackendOptions): AgentBackend {
  return new CursorAcpBackend(options);
}
