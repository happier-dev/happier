// Compatibility entrypoint for existing first-party and third-party imports.
// Cold bundled catalog projection imports `./catalog` directly so it never
// evaluates this legacy module's non-catalog descriptor exports.
export * from './catalog.js';
export {
  buildCodexAgentRuntimeDescriptorV1,
  readCanonicalCodexAgentRuntimeDescriptorV1,
} from '../../protocol/runtimeDescriptorV1.js';
