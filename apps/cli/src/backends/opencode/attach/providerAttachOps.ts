import type { ProviderAttachOps } from '@/backends/types';

import {
  evaluateOpenCodeProviderAttachEligibility,
  resolveOpenCodeProviderAttachTargetWithManagedServerFallback,
} from './evaluateOpenCodeProviderAttachEligibility';
import { probeOpenCodeProviderAttachReachability } from './probeOpenCodeProviderAttachReachability';
import { runOpenCodeProviderAttach } from './runOpenCodeProviderAttach';

export const openCodeProviderAttachOps: ProviderAttachOps = {
  evaluateEligibility: async ({ metadata, currentMachineId, sessionMachineId, hasLocalAttachmentInfo }) => {
    const scope =
      hasLocalAttachmentInfo || (sessionMachineId && currentMachineId && sessionMachineId === currentMachineId)
        ? 'local'
        : 'remote';
    const resolved = scope === 'local'
      ? await resolveOpenCodeProviderAttachTargetWithManagedServerFallback({ metadata })
      : evaluateOpenCodeProviderAttachEligibility(metadata);
    if (!resolved.eligible) {
      return {
        eligible: false,
        reason: resolved.reason,
      };
    }

    return {
      eligible: true,
      scope,
      metadata,
    };
  },
  probeReachability: async ({ metadata }) => await probeOpenCodeProviderAttachReachability({ metadata }),
  runAttach: async ({ sessionId, metadata }) => await runOpenCodeProviderAttach({ sessionId, metadata }),
};
