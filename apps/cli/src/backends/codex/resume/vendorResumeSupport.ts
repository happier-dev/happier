import type { VendorResumeSupportFn } from '@/backends/types';

import { resolveCodexBackendModeForRun } from '../utils/resolveCodexBackendModeForRun';

export const supportsCodexVendorResume: VendorResumeSupportFn = (params) => {
  const codexBackendMode =
    params.codexBackendMode
    ?? (params.experimentalCodexAcp === true ? 'acp' : undefined);

  return resolveCodexBackendModeForRun({
    codexBackendMode,
    experimentalCodexAcpEnabledByDefault: false,
  }) !== 'mcp';
};
