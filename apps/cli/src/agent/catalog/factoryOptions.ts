export interface AgentFactoryOptions {
  /** Working directory for the agent */
  cwd: string;

  /** Environment variables to pass to the agent */
  env?: NodeJS.ProcessEnv;
}
