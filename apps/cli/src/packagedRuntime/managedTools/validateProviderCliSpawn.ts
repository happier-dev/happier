import type { CatalogAgentLookupId } from '@/backends/types';

import {
  buildMissingProviderCliCommandErrorMessage,
  resolveAgentCliRuntimeSpecForLookupId,
} from './requireProviderCliCommand';
import { resolveProviderCliCommandForRuntime } from './providerCliResolution';

export async function validateProviderCliSpawn(params: Readonly<{ agentId: CatalogAgentLookupId }>): Promise<
  | { ok: true }
  | { ok: false; errorMessage: string }
> {
  const resolved = resolveProviderCliCommandForRuntime(resolveAgentCliRuntimeSpecForLookupId(params.agentId));
  if (resolved) return { ok: true };

  return {
    ok: false,
    errorMessage: buildMissingProviderCliCommandErrorMessage(params.agentId),
  };
}
