import type { AgentLaunchEnvironment } from './session.js';
import type {
  AgentTerminalSessionStateUpdate,
  AttachSurface,
  CheckpointSurface,
  ForkSurfaceV1,
  HandoffSurfaceV1,
} from './projections.js';
import type { PluginInvocationContext } from '../invocation.js';
import type { ProviderBoundModelRef } from '@happier-dev/protocol';

export type {
  AgentTerminalSessionIdentityFieldId,
  AgentTerminalSessionStateUpdate,
  AttachSurface,
  CheckpointSurface,
} from './projections.js';

/**
 * Agent-authored fork operations execute only after the host creates a
 * current, operation-scoped invocation context. The factory itself receives
 * no services.
 */
export type AgentRuntimeForkSurface = Readonly<{
  evaluateAvailability?: (
    request: Parameters<NonNullable<ForkSurfaceV1['evaluateAvailability']>>[0],
    context: PluginInvocationContext,
  ) => ReturnType<NonNullable<ForkSurfaceV1['evaluateAvailability']>>;
  fork?: (
    request: Parameters<NonNullable<ForkSurfaceV1['fork']>>[0],
    context: PluginInvocationContext,
  ) => ReturnType<NonNullable<ForkSurfaceV1['fork']>>;
  resolveReplayChildLaunch?: (
    request: Parameters<NonNullable<ForkSurfaceV1['resolveReplayChildLaunch']>>[0],
    context: PluginInvocationContext,
  ) => ReturnType<NonNullable<ForkSurfaceV1['resolveReplayChildLaunch']>>;
}>;

/**
 * Agent-authored handoff operations execute only after the host creates a
 * current, operation-scoped invocation context. The factory itself receives
 * no services.
 */
export type AgentRuntimeHandoffSurface = Readonly<{
  evaluateAvailability?: (
    request: Parameters<NonNullable<HandoffSurfaceV1['evaluateAvailability']>>[0],
    context: PluginInvocationContext,
  ) => ReturnType<NonNullable<HandoffSurfaceV1['evaluateAvailability']>>;
  exportBundle: (
    request: Parameters<HandoffSurfaceV1['exportBundle']>[0],
    context: PluginInvocationContext,
  ) => ReturnType<HandoffSurfaceV1['exportBundle']>;
  importBundle: (
    request: Parameters<HandoffSurfaceV1['importBundle']>[0],
    context: PluginInvocationContext,
  ) => ReturnType<HandoffSurfaceV1['importBundle']>;
}>;

export type AgentTerminalLaunchMetadata = Readonly<Partial<{
  terminalRuntime: Readonly<Partial<{
    claudeArgs: readonly string[];
    codexArgs: readonly string[];
    promptInteractive: boolean;
    conversationId: string;
    continueLatest: boolean;
    sandbox: boolean;
    logFile: string;
    print: boolean;
    unsafeSkipPermissions: boolean;
  }>>;
  antigravity: Readonly<Partial<{
    promptInteractive: boolean;
    conversationId: string;
    continueLatest: boolean;
    sandbox: boolean;
    logFile: string;
    print: boolean;
    unsafeSkipPermissions: boolean;
  }>>;
  providerSessionId: string;
  codexSessionId: string;
  resumeId: string;
  permissionMode: string;
  codexArgs: readonly string[];
  claudeArgs: readonly string[];
  fallbackModel: string;
  customSystemPrompt: string;
  appendSystemPrompt: string;
}>>;

export type AgentTerminalControlPresentation = Readonly<{
  target: 'local' | 'remote';
  reason?: string;
}>;

export type AgentTerminalLaunchPlan = Readonly<{
  argv: readonly string[];
  environment?: AgentLaunchEnvironment;
  process?: Readonly<{
    stdio?: 'inherit' | 'pipe';
    windowsHide?: boolean;
    windowsVerbatimArguments?: boolean;
  }>;
  presentation?: Readonly<{
    onLaunch?: AgentTerminalControlPresentation;
    onExit?: AgentTerminalControlPresentation;
  }>;
  resultMetadata?: Readonly<{
    sessionStateUpdates?: readonly AgentTerminalSessionStateUpdate[];
  }>;
}>;

export type AgentTerminalLaunchRequest = Readonly<{
  sessionId: string;
  cwd: string;
  metadata: AgentTerminalLaunchMetadata;
  modelSelection: ProviderBoundModelRef | null;
}>;

export interface AgentTerminalSurface {
  resolveLaunch(
    request: AgentTerminalLaunchRequest,
  ): AgentTerminalLaunchPlan | Promise<AgentTerminalLaunchPlan>;
}

export interface AgentRuntimeSurfaces {
  readonly terminal?: AgentTerminalSurface;
  readonly fork?: AgentRuntimeForkSurface;
  readonly handoff?: AgentRuntimeHandoffSurface;
  readonly attach?: AttachSurface;
  readonly checkpoint?: CheckpointSurface;
}
