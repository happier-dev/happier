import { resolveKimiSessionRuntimePreferences } from '../preferences/session.js';

export const KIMI_AGENT_RUNTIME_CONTRIBUTION = Object.freeze({
  agentId: 'kimi',
  builtInAcpCatalog: true,
  sessionRuntimePreferences: {
    resolve: resolveKimiSessionRuntimePreferences,
  },
} as const);
