import { openCodePreflightModelsProbeAdapter } from './openCodePreflightModelsProbeAdapter';

// OpenCode currently exposes only a models probe. This wrapper makes the intent explicit now that
// the backend catalog expects a "session controls probe adapter" (models/modes/config options).
export const openCodePreflightSessionControlsProbeAdapter = openCodePreflightModelsProbeAdapter;
