import { join } from 'node:path';

import type { CatalogAgentId } from '@/backends/types';
import { normalizeMaterializationKeyForPath } from './normalizeMaterializationKeyForPath';

/**
 * Compute the DETERMINISTIC final materialized root directory for a connected-service spawn:
 * `<baseDir>/<sha256(materializationKey)>/<agentId>` — the SAME layout
 * `materializeConnectedServicesForSpawn` commits the materialized env into (it derives its root via
 * `normalizeMaterializationKeyForPath(materializationKey)`).
 *
 * This is a pure path computation — NO filesystem side effects. It is factored out so callers that
 * need the target root WITHOUT materializing (e.g. the inactive-session auth-switch continuity check,
 * which must reconstruct the target the NEXT spawn will read) use one source of truth instead of
 * re-deriving the layout. For connected-service spawns the `materializationKey` is the connected-service
 * materialization identity id, so passing that id reconstructs the exact root the next spawn will use.
 * Provider-agnostic: `agentId` is a typed value, no provider branching.
 */
export function resolveConnectedServiceMaterializedRootDir(input: Readonly<{
  baseDir: string;
  agentId: CatalogAgentId;
  materializationKey: string;
}>): string {
  return join(input.baseDir, normalizeMaterializationKeyForPath(input.materializationKey), input.agentId);
}
