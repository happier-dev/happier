import { resolveKimiSessionRuntimePreferences } from '../preferences/session.js';

export const KIMI_PROVIDER_RUNTIME_CONTRIBUTION = Object.freeze({
  agentId: 'kimi',
  builtInAcpCatalog: true,
  sessionRuntimePreferences: {
    resolve: resolveKimiSessionRuntimePreferences,
  },
} as const);
