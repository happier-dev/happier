import type { CatalogAgentLookupId } from '@/agent/catalog/ids';

import {
  buildMissingAgentCliCommandErrorMessage,
  resolveAgentCliRuntimeSpecForLookupId,
} from './requireAgentCliCommand';
import { resolveAgentCliCommandForRuntime } from './agentCliResolution';

export async function validateAgentCliSpawn(params: Readonly<{ agentId: CatalogAgentLookupId }>): Promise<
  | { ok: true }
  | { ok: false; errorMessage: string }
> {
  const resolved = resolveAgentCliCommandForRuntime(resolveAgentCliRuntimeSpecForLookupId(params.agentId));
  if (resolved) return { ok: true };

  return {
    ok: false,
    errorMessage: buildMissingAgentCliCommandErrorMessage(params.agentId),
  };
}
