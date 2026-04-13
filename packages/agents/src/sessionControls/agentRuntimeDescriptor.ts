// Compatibility-only module: canonical implementations now live in `src/providers/**`.
export {
  buildCodexAgentRuntimeDescriptor,
  type BuildCodexAgentRuntimeDescriptorParams,
  type CodexAgentRuntimeDescriptorV1,
} from '../providers/codex/buildAgentRuntimeDescriptor.js';
export {
  buildOpenCodeAgentRuntimeDescriptor,
  type BuildOpenCodeAgentRuntimeDescriptorParams,
  type OpenCodeAgentRuntimeDescriptorV1,
} from '../providers/opencode/buildAgentRuntimeDescriptor.js';
export { readSessionMetadataRuntimeDescriptor } from '../providers/readSessionMetadataRuntimeDescriptor.js';
