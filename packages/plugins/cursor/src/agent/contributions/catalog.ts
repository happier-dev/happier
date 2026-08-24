import { CURSOR_PREFLIGHT_SESSION_CONTROLS } from '../preflight/models.js';

export const CURSOR_AGENT_RUNTIME_CONTRIBUTION = Object.freeze({
  agentId: 'cursor',
  preflightSessionControls: CURSOR_PREFLIGHT_SESSION_CONTROLS,
} as const);
