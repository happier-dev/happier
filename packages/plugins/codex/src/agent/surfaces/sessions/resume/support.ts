import { resolveCanonicalCodexBackendModeFromCompatInput } from '../../../lifecycle/backendMode.js';

export type CodexProviderResumeSupportInput = Readonly<{
  codexBackendMode?: unknown;
  experimentalCodexAcp?: boolean;
  runtimeDescriptorV1?: unknown;
}>;

export function supportsCodexProviderResume(params: CodexProviderResumeSupportInput = {}): boolean {
  return resolveCanonicalCodexBackendModeFromCompatInput(params) !== undefined;
}

export const supportsCodexVendorResume = supportsCodexProviderResume;
