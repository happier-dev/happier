/**
 * Public entry for OpenCode connected-service auth materialization.
 *
 * This module re-exports the canonical config-isolation/request-auth materializer consumed by the
 * runtime contribution and tests.
 */
export {
  buildOpenCodeAuthContent,
  materializeOpenCodeAuthEnvironment,
  type OpenCodeAuthMaterializationInput,
  type OpenCodeAuthEnvironmentInput,
} from './materialize/index.js';
