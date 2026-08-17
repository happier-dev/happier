import type { AgentLaunchEnvironment } from './session.js';
import type {
  AgentTerminalSessionStateUpdate,
  AttachSurface,
  CheckpointSurface,
} from './projections.js';
import type { ProviderBoundModelRef } from '@happier-dev/protocol';

export type {
  AgentTerminalSessionIdentityFieldId,
  AgentTerminalSessionStateUpdate,
  AttachSurface,
  CheckpointSurface,
} from './projections.js';

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
  readonly attach?: AttachSurface;
  readonly checkpoint?: CheckpointSurface;
}
