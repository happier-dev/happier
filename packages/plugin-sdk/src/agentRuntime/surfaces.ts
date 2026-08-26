import type {
  AgentLaunchEnvironment,
  AgentSessionConfigurationSnapshot,
} from './session.js';
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
  extractMediaScannableRecords?: (
    request: Parameters<NonNullable<HandoffSurfaceV1['extractMediaScannableRecords']>>[0],
    context: PluginInvocationContext,
  ) => ReturnType<NonNullable<HandoffSurfaceV1['extractMediaScannableRecords']>>;
  buildRuntimeLocalMetadata?: (
    request: Parameters<NonNullable<HandoffSurfaceV1['buildRuntimeLocalMetadata']>>[0],
    context: PluginInvocationContext,
  ) => ReturnType<NonNullable<HandoffSurfaceV1['buildRuntimeLocalMetadata']>>;
  resolveNativeTranscriptPathCandidate?: (
    request: Parameters<NonNullable<HandoffSurfaceV1['resolveNativeTranscriptPathCandidate']>>[0],
    context: PluginInvocationContext,
  ) => ReturnType<NonNullable<HandoffSurfaceV1['resolveNativeTranscriptPathCandidate']>>;
}>;

/** Agent-owned runtime identity, interpreted only by the target Agent. */
export type AgentTerminalLaunchMetadata = Readonly<Partial<{
  runtimeDescriptorV1: Readonly<{
    v: 1;
    agentId: string;
    agent: Readonly<Record<string, unknown>>;
  } & Record<string, unknown>>;
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
  /** Host-owned current Session configuration, shared with Session open. */
  configuration?: AgentSessionConfigurationSnapshot;
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
