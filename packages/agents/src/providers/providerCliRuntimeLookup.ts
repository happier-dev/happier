import {
  getLegacyConfiguredBackendProviderCliRuntimeSpec,
  LEGACY_CONFIGURED_BACKEND_SENTINEL_ID,
  type LegacyConfiguredBackendLookupId,
  type LegacyConfiguredBackendProviderCliRuntimeSpec,
} from '../compat/legacyConfiguredBackend.js';

import { getProviderCliRuntimeSpec, type ProviderCliRuntimeSpec } from './providerCliRuntime.js';

export function getProviderCliRuntimeSpecForLookupId(
  id: LegacyConfiguredBackendLookupId,
): ProviderCliRuntimeSpec | LegacyConfiguredBackendProviderCliRuntimeSpec {
  if (id === LEGACY_CONFIGURED_BACKEND_SENTINEL_ID) {
    return getLegacyConfiguredBackendProviderCliRuntimeSpec();
  }

  return getProviderCliRuntimeSpec(id);
}
