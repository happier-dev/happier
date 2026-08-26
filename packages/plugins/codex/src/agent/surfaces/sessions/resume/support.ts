import type { AgentExperimentalVendorResumeSupportInputV1 } from '@happier-dev/plugin-sdk/agents/runtime';

import { resolveCanonicalCodexBackendMode } from '../../../lifecycle/backendMode.js';

export type CodexProviderResumeSupportInput = AgentExperimentalVendorResumeSupportInputV1;

export function supportsCodexProviderResume(params: CodexProviderResumeSupportInput = {}): boolean {
  return resolveCanonicalCodexBackendMode({
    codexBackendMode: params.agentRuntimeSelection?.codexBackendMode,
    runtimeDescriptorV1: params.runtimeDescriptorV1,
  }) !== undefined;
}

export const supportsCodexVendorResume = supportsCodexProviderResume;
