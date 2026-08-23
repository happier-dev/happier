import type { PluginDiagnosticData } from '../diagnostics.js';
import type { PluginContributionRef } from '../identity.js';
import type { Disposable } from '../lifecycle.js';
import type { ProviderBoundModelRef } from '@happier-dev/protocol';
import type { AgentRuntimeContext } from './context.js';
import type {
  AgentLaunchEnvironment,
  AgentSessionConfigurationSnapshot,
  AgentSessionInput,
  AgentSessionOpenRequest,
  AgentSessionProviderBinding,
} from './session.js';

export type AgentExecutionRunOpenRequest =
  Readonly<{
    runId: string;
    cwd: string;
    profile: PluginContributionRef;
    launchEnvironment?: AgentLaunchEnvironment;
    modelSelection?: ProviderBoundModelRef;
    configuration?: AgentSessionConfigurationSnapshot;
    providerBinding?: AgentSessionProviderBinding;
    /** Same host-resolved policy an Agent session open carries. */
    stateSharing?: AgentSessionOpenRequest['stateSharing'];
  }> & (
    | Readonly<{
        kind: 'create';
        input: AgentSessionInput;
      }>
    | Readonly<{
        kind: 'resume';
        checkpointId: string;
      }>
    | Readonly<{
        kind: 'fork';
        sourceRunId: string;
        checkpointId?: string;
      }>
  );

export type AgentExecutionRunEvent =
  | Readonly<{
      sequence: number;
      runId: string;
      emittedAtMs: number;
      kind: 'run-start' | 'run-progress';
    }>
  | Readonly<{
      sequence: number;
      runId: string;
      emittedAtMs: number;
      kind: 'output-delta';
      channel: 'assistant' | 'reasoning';
      text: string;
    }>
  | Readonly<{
      sequence: number;
      runId: string;
      emittedAtMs: number;
      kind: 'checkpoint';
      checkpointId: string;
    }>
  | Readonly<{
      sequence: number;
      runId: string;
      emittedAtMs: number;
      kind: 'run-complete';
    }>
  | Readonly<{
      sequence: number;
      runId: string;
      emittedAtMs: number;
      kind: 'run-failed' | 'run-cancelled';
      diagnostic?: PluginDiagnosticData;
    }>;

export type AgentExecutionRunSendResult = Readonly<{
  status: 'admitted' | 'rejected' | 'unavailable' | 'unsupported';
  diagnostic?: PluginDiagnosticData;
}>;

export type AgentExecutionRunStopResult = Readonly<{
  status: 'requested' | 'notRunning' | 'unavailable' | 'unsupported';
}>;

export interface AgentExecutionRunRuntime extends Disposable {
  send(
    input: AgentSessionInput,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<AgentExecutionRunSendResult>;
  stop(options?: Readonly<{ signal?: AbortSignal }>): Promise<AgentExecutionRunStopResult>;
  watch(listener: (event: AgentExecutionRunEvent) => void): Disposable;
}

export interface AgentExecutionRunRuntimeFactory {
  open(
    request: AgentExecutionRunOpenRequest,
    context: AgentRuntimeContext,
  ): AgentExecutionRunRuntime | Promise<AgentExecutionRunRuntime>;
}
