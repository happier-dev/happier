/**
 * Public entry for OpenCode connected-service auth materialization.
 *
 * The implementation is split per-provider under `materialize/` (a real domain split — the file is
 * the hottest shared surface across the broker/config-isolation/Claude lanes). This module re-exports
 * the stable public API consumed by the runtime contribution and tests.
 */
export {
  buildOpenCodeAuthContent,
  materializeOpenCodeAuthEnvironment,
  type OpenCodeAuthMaterializationInput,
  type OpenCodeAuthEnvironmentInput,
} from './materialize/index.js';
