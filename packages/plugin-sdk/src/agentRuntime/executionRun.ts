import type { PluginDiagnosticData } from '../diagnostics.js';
import type { PluginContributionRef } from '../identity.js';
import type { Disposable } from '../lifecycle.js';
import type { AgentRuntimeContext } from './context.js';
import type { AgentLaunchEnvironment, AgentSessionInput } from './session.js';

type AgentExecutionRunOpenBase = Readonly<{
  runId: string;
  cwd: string;
  profile: PluginContributionRef;
  launchEnvironment?: AgentLaunchEnvironment;
}>;

export type AgentExecutionRunOpenRequest =
  | (AgentExecutionRunOpenBase & Readonly<{
      kind: 'create';
      input: AgentSessionInput;
    }>)
  | (AgentExecutionRunOpenBase & Readonly<{
      kind: 'resume';
      checkpointId: string;
    }>)
  | (AgentExecutionRunOpenBase & Readonly<{
      kind: 'fork';
      sourceRunId: string;
      checkpointId?: string;
    }>);

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
