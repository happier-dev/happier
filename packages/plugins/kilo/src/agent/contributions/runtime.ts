export const KILO_AGENT_RUNTIME_CONTRIBUTION = Object.freeze({
  agentId: 'kilo',
  builtInAcpCatalog: true,
  preflightSessionControls: {
    failureCacheStrategy: 'cooldown',
    cliModelsCommandArgs: ['models'],
  },
} as const);
