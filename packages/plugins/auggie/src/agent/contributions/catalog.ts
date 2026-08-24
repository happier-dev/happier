import { AUGGIE_PREFLIGHT_SESSION_CONTROLS } from '../preflight/models.js';

export const AUGGIE_AGENT_RUNTIME_CONTRIBUTION = Object.freeze({
  agentId: 'auggie',
  preflightSessionControls: AUGGIE_PREFLIGHT_SESSION_CONTROLS,
} as const);
