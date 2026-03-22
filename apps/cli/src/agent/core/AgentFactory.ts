import type { AgentBackend } from './AgentBackend';

export interface AgentFactoryOptions {
  /** Working directory for the agent */
  cwd: string;

  /** Environment variables to pass to the agent */
  env?: NodeJS.ProcessEnv;
}

export type AgentFactory<TBackend extends AgentBackend = AgentBackend> = (opts: AgentFactoryOptions) => TBackend;
