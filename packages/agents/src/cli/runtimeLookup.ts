import {
  getLegacyConfiguredBackendAgentCliRuntimeSpec,
  LEGACY_CONFIGURED_BACKEND_SENTINEL_ID,
  type LegacyConfiguredBackendLookupId,
  type LegacyConfiguredBackendAgentCliRuntimeSpec,
} from '../compat/legacyConfiguredBackend.js';

import { getAgentCliRuntimeSpec, type AgentCliRuntimeSpec } from './runtime.js';

/** Released configured-backend lookup only; current ids use the Agent CLI catalog. */
export function getAgentCliRuntimeSpecForLookupId(
  id: LegacyConfiguredBackendLookupId,
): AgentCliRuntimeSpec | LegacyConfiguredBackendAgentCliRuntimeSpec | null {
  if (id === LEGACY_CONFIGURED_BACKEND_SENTINEL_ID) {
    return getLegacyConfiguredBackendAgentCliRuntimeSpec();
  }

  return getAgentCliRuntimeSpec(id);
}
