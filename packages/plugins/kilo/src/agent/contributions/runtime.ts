export const KILO_AGENT_RUNTIME_CONTRIBUTION = Object.freeze({
  agentId: 'kilo',
  preflightSessionControls: {
    failureCacheStrategy: 'cooldown',
    cliModelsCommandArgs: ['models'],
  },
} as const);
