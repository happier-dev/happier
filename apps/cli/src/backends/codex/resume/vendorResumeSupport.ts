import type { VendorResumeSupportFn } from '@/backends/types';

import { resolveCodexBackendModeForRun } from '../utils/resolveCodexBackendModeForRun';

export const supportsCodexVendorResume: VendorResumeSupportFn = (params) => {
  return resolveCodexBackendModeForRun({
    codexBackendMode: params.codexBackendMode,
    experimentalCodexAcp: params.experimentalCodexAcp,
    experimentalCodexAcpEnabledByDefault: false,
  }) !== 'mcp';
};
