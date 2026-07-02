import type { MaybePromise } from '../engine/contracts.js';
import type { SessionScopedServicesV1 } from '../session/scopedServices.js';
import type {
  BackendSurfaceAvailabilityV1,
  ExternalSessionTranscriptRawMessageV1,
  ExternalSessionsProviderId,
  ExternalSessionsSource,
  RuntimeDescriptorV1,
  SubagentLifecycleDetailV1,
  SubagentStatusV1,
} from '@happier-dev/protocol';
import type { SessionStateUpdateV1 } from './primitives.js';
import type { SubscriptionV1 } from '../session/scopedServices.js';

export type TerminalRuntimeAvailabilityOperationV1 =
  | 'launch'
  | 'discoverIdentity'
  | 'resolveTranscriptBinding';

export type TerminalRuntimeAvailabilityRequestV1 = Readonly<{
  operation: TerminalRuntimeAvailabilityOperationV1;
  sessionId?: string;
  metadata?: Readonly<Record<string, unknown>>;
  directory?: string;
}>;

export type TerminalRuntimeLaunchRequestV1 = Readonly<{
  sessionId: string;
  metadata: Readonly<Record<string, unknown>>;
  directory: string;
  services?: SessionScopedServicesV1;
  signal?: AbortSignal;
  host?: TerminalRuntimeHostOrchestrationV1;
}>;

export type TerminalRuntimeInputTriggerV1 = Readonly<{
  sequence: number;
}>;

export type TerminalRuntimeInputTriggerHandlerV1 = (
  trigger: TerminalRuntimeInputTriggerV1,
) => MaybePromise<void>;

export type TerminalRuntimeInputTriggerServiceV1 = Readonly<{
  subscribe(handler: TerminalRuntimeInputTriggerHandlerV1): SubscriptionV1;
}>;

export type TerminalRuntimeSwitchTargetV1 = 'local' | 'remote' | 'unknown';

export type TerminalRuntimeSwitchRequestV1 = Readonly<{
  target: TerminalRuntimeSwitchTargetV1;
}>;

export type TerminalRuntimeSwitchHandlerV1 = (
  request: TerminalRuntimeSwitchRequestV1,
) => MaybePromise<boolean>;

export type TerminalRuntimeSwitchHandlerServiceV1 = Readonly<{
  register(handler: TerminalRuntimeSwitchHandlerV1): SubscriptionV1;
}>;

export type TerminalRuntimeProcessExecutableGrantKindV1 = 'system-tool' | 'agent-cli';

export type TerminalRuntimeProcessExecutableHostGrantV1 = Readonly<{
  kind: TerminalRuntimeProcessExecutableGrantKindV1;
  grantId: string;
}>;

export type TerminalRuntimeProcessExecutableV1 = Readonly<{
  path: string;
  hostGrant: TerminalRuntimeProcessExecutableHostGrantV1;
}>;

export type TerminalRuntimeProcessStdioV1 = 'inherit' | 'pipe';

export type TerminalRuntimeProcessLaunchRequestV1 = Readonly<{
  executable: TerminalRuntimeProcessExecutableV1;
  args?: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string | undefined>>;
  stdio?: TerminalRuntimeProcessStdioV1;
  windowsHide?: boolean;
  windowsVerbatimArguments?: boolean;
  signal?: AbortSignal;
}>;

export type TerminalRuntimeAgentCliExecutableResolutionRequestV1 = Readonly<{
  agentId: string;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}>;

export type TerminalRuntimeAgentCliExecutableResolutionV1 = Readonly<{
  executable: TerminalRuntimeProcessExecutableV1;
  args: readonly string[];
  source: string;
  resolvedPath: string;
}>;

export type TerminalRuntimeProcessTerminationV1 =
  | Readonly<{ type: 'exited'; code: number }>
  | Readonly<{ type: 'signaled'; signal: string }>
  | Readonly<{ type: 'spawn_error'; errorName: string; errorMessage: string }>
  | Readonly<{ type: 'missing' }>;

export type TerminalRuntimeProcessHandleV1 = Readonly<{
  pid: number | null;
  waitForTermination(): Promise<TerminalRuntimeProcessTerminationV1>;
  stop(options?: Readonly<{ graceMs?: number }>): Promise<void>;
  readBufferedStderr?(): string;
}>;

export type TerminalRuntimeProcessServiceV1 = Readonly<{
  resolveAgentCliExecutable?(
    request: TerminalRuntimeAgentCliExecutableResolutionRequestV1
  ): Promise<TerminalRuntimeAgentCliExecutableResolutionV1>;
  launch(request: TerminalRuntimeProcessLaunchRequestV1): Promise<TerminalRuntimeProcessHandleV1>;
}>;

export type TerminalRuntimeDirectTranscriptBindingV1 = Readonly<{
  providerId: ExternalSessionsProviderId;
  source: ExternalSessionsSource;
  remoteSessionId: string;
}>;

export type TerminalRuntimeDirectTranscriptMirrorHandleV1 = Readonly<{
  stop(): Promise<void>;
}>;

export type TerminalRuntimeTranscriptBindingHostServiceV1 = Readonly<{
  openDirectMirror(request: Readonly<{
    binding: TerminalRuntimeDirectTranscriptBindingV1;
    onItems: (items: readonly ExternalSessionTranscriptRawMessageV1[]) => MaybePromise<void>;
  }>): Promise<TerminalRuntimeDirectTranscriptMirrorHandleV1>;
}>;

export type TerminalRuntimeControlProjectionV1 = Readonly<{
  target: TerminalRuntimeSwitchTargetV1;
  reason?: string;
  providerSessionId?: string;
  sessionStateUpdates?: readonly SessionStateUpdateV1[];
}>;

export type TerminalRuntimeProviderSessionProjectionV1 = Readonly<{
  providerSessionId: string;
  metadataKey: string;
  source?: ExternalSessionsSource;
  sessionStateUpdates?: readonly SessionStateUpdateV1[];
  providerEvidence?: Readonly<Record<string, unknown>>;
}>;

export type TerminalRuntimeSubagentProjectionV1 = Readonly<{
  providerId?: string;
  providerKind?: string;
  providerSessionId?: string;
  subagentId: string;
  label?: string;
  role?: string;
  sidechainId?: string;
  status?: SubagentStatusV1;
  lifecycleDetail?: SubagentLifecycleDetailV1;
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type TerminalRuntimeProjectionHostServiceV1 = Readonly<{
  openDirectTranscriptMirror: TerminalRuntimeTranscriptBindingHostServiceV1['openDirectMirror'];
  publishControlState(projection: TerminalRuntimeControlProjectionV1): MaybePromise<void>;
  publishProviderSessionId(projection: TerminalRuntimeProviderSessionProjectionV1): MaybePromise<boolean>;
  publishSubagentStarted(projection: TerminalRuntimeSubagentProjectionV1): MaybePromise<void>;
  publishSubagentCompleted(projection: TerminalRuntimeSubagentProjectionV1): MaybePromise<void>;
}>;

export type TerminalRuntimeHostOrchestrationV1 = Readonly<{
  input: TerminalRuntimeInputTriggerServiceV1;
  switching: TerminalRuntimeSwitchHandlerServiceV1;
  process: TerminalRuntimeProcessServiceV1;
  transcripts: TerminalRuntimeTranscriptBindingHostServiceV1;
  projection: TerminalRuntimeProjectionHostServiceV1;
}>;

export type TerminalRuntimeControlReturnReasonV1 =
  | 'switch_requested'
  | 'pending_input'
  | 'terminal_recovery';

export type TerminalRuntimeTranscriptBindingV1 = Readonly<{
  providerSessionId?: string;
  source?: ExternalSessionsSource;
  sessionStateUpdates?: readonly SessionStateUpdateV1[];
  providerEvidence?: Readonly<Record<string, unknown>>;
}>;

export type TerminalRuntimeRunResultV1 =
  | Readonly<{
      type: 'process_exited';
      exitCode: number;
      sessionStateUpdates?: readonly SessionStateUpdateV1[];
    }>
  | Readonly<{
      type: 'control_returned';
      reason: TerminalRuntimeControlReturnReasonV1;
      providerSessionId?: string;
      transcriptBinding?: TerminalRuntimeTranscriptBindingV1;
      sessionStateUpdates?: readonly SessionStateUpdateV1[];
    }>;

export type TerminalRuntimeIdentityRequestV1 = Readonly<{
  sessionId: string;
  metadata: Readonly<Record<string, unknown>>;
}>;

export type TerminalRuntimeIdentityResultV1 = Readonly<{
  providerSessionId: string;
  runtimeDescriptor?: RuntimeDescriptorV1 | null;
  sessionStateUpdates?: readonly SessionStateUpdateV1[];
}>;

export type TerminalRuntimeTranscriptBindingRequestV1 = Readonly<{
  sessionId: string;
  metadata: Readonly<Record<string, unknown>>;
  providerSessionId?: string | null;
}>;

export type TerminalRuntimeSurfaceV1 = Readonly<{
  evaluateAvailability?: (request: TerminalRuntimeAvailabilityRequestV1) => MaybePromise<BackendSurfaceAvailabilityV1>;
  launch?: (request: TerminalRuntimeLaunchRequestV1) => MaybePromise<TerminalRuntimeRunResultV1>;
  discoverIdentity?: (request: TerminalRuntimeIdentityRequestV1) => MaybePromise<TerminalRuntimeIdentityResultV1 | null>;
  resolveTranscriptBinding?: (
    request: TerminalRuntimeTranscriptBindingRequestV1
  ) => MaybePromise<TerminalRuntimeTranscriptBindingV1 | null>;
}>;
