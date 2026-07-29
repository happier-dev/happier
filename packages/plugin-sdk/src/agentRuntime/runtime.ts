import type { AgentSessionRuntimeFactory } from './controls.js';
import type { AgentExecutionRunRuntimeFactory } from './executionRun.js';
import type { AgentRuntimeMessages, AgentRuntimeSurfaces } from './surfaces.js';

export type AgentRuntimeBase = Readonly<{
  surfaces?: AgentRuntimeSurfaces;
  messages?: AgentRuntimeMessages;
}>;

export type AgentRuntime = AgentRuntimeBase & (
  | Readonly<{
      sessions: AgentSessionRuntimeFactory;
      executionRuns?: AgentExecutionRunRuntimeFactory;
    }>
  | Readonly<{
      sessions?: AgentSessionRuntimeFactory;
      executionRuns: AgentExecutionRunRuntimeFactory;
    }>
);
