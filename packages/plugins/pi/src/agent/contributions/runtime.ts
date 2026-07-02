import { PI_PREFLIGHT_SESSION_CONTROLS } from '../preflight/models.js';

export const PI_PROVIDER_RUNTIME_CONTRIBUTION = Object.freeze({
  agentId: 'pi',
  preflightSessionControls: PI_PREFLIGHT_SESSION_CONTROLS,
} as const);
