import {
  getLegacyConfiguredBackendAgentCliRuntimeSpec,
  LEGACY_CONFIGURED_BACKEND_SENTINEL_ID,
  type LegacyConfiguredBackendLookupId,
  type LegacyConfiguredBackendAgentCliRuntimeSpec,
} from '../compat/legacyConfiguredBackend.js';

import { getAgentCliRuntimeSpec, type AgentCliRuntimeSpec } from './runtime.js';

export function getAgentCliRuntimeSpecForLookupId(
  id: LegacyConfiguredBackendLookupId,
): AgentCliRuntimeSpec | LegacyConfiguredBackendAgentCliRuntimeSpec {
  if (id === LEGACY_CONFIGURED_BACKEND_SENTINEL_ID) {
    return getLegacyConfiguredBackendAgentCliRuntimeSpec();
  }

  return getAgentCliRuntimeSpec(id);
}
