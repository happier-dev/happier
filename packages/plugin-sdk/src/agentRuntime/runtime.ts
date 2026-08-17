import type { AgentSessionRuntimeFactory } from './controls.js';
import type { AgentExecutionRunRuntimeFactory } from './executionRun.js';
import type { AgentRuntimeSurfaces } from './surfaces.js';
import type { PluginExecutionInterceptionCapability } from '../hooks.js';

export type AgentToolExecutionLifecycle = Readonly<{
  /**
   * `interceptable` means the host owns a real pre-effect proposal boundary.
   * `observable` means the provider effect can only be reported afterwards.
   */
  capability: PluginExecutionInterceptionCapability;
}>;

export type AgentRuntimeBase = Readonly<{
  surfaces?: AgentRuntimeSurfaces;
  toolExecution?: AgentToolExecutionLifecycle;
}>;

export type AgentRuntime = Readonly<{
  surfaces?: AgentRuntimeSurfaces;
  toolExecution?: AgentToolExecutionLifecycle;
}> & (
  | Readonly<{
      sessions: AgentSessionRuntimeFactory;
      executionRuns?: AgentExecutionRunRuntimeFactory;
    }>
  | Readonly<{
      sessions?: AgentSessionRuntimeFactory;
      executionRuns: AgentExecutionRunRuntimeFactory;
    }>
);
