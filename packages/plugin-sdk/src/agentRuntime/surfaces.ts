import type { AgentRuntimeContext } from './context.js';
import type { AgentLaunchEnvironment, AgentSessionInput } from './session.js';
import type {
  SessionStateFieldId,
  SessionStateFieldValue,
} from '@happier-dev/protocol';

type AgentTerminalSessionStateUpdate<
  TField extends SessionStateFieldId = SessionStateFieldId,
> = Readonly<{
  fieldId: TField;
  value: SessionStateFieldValue<TField>;
  updatedAt?: number;
}>;

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
  metadata: Readonly<Record<string, unknown>>;
}>;

export interface AgentTerminalSurface {
  resolveLaunch(
    request: AgentTerminalLaunchRequest,
  ): AgentTerminalLaunchPlan | Promise<AgentTerminalLaunchPlan>;
}

export interface AgentRuntimeSurfaces {
  readonly terminal?: AgentTerminalSurface;
}

export interface AgentRuntimeMessages {
  augmentOutgoing(
    message: AgentSessionInput,
    context: AgentRuntimeContext,
  ): AgentSessionInput | Promise<AgentSessionInput>;
}
