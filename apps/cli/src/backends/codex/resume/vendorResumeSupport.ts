import type { VendorResumeSupportFn } from '@/backends/types';

export const supportsCodexVendorResume: VendorResumeSupportFn = (params) => {
  return params.experimentalCodexAcp === true;
};
