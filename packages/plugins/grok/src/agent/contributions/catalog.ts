import { GROK_PREFLIGHT_SESSION_CONTROLS } from '../preflight/models.js';

export const GROK_AGENT_RUNTIME_CONTRIBUTION = Object.freeze({
  agentId: 'grok',
  preflightSessionControls: GROK_PREFLIGHT_SESSION_CONTROLS,
} as const);
