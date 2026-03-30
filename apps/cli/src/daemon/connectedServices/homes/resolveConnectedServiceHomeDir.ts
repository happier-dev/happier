import { join } from 'node:path';

import type { ConnectedServiceId, ConnectedServiceProfileId } from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/backends/types';
import { normalizeMaterializationKeyForPath } from '../materialize/normalizeMaterializationKeyForPath';

export function resolveConnectedServiceHomeDir(params: Readonly<{
  activeServerDir: string;
  serviceId: ConnectedServiceId;
  profileId: ConnectedServiceProfileId;
  agentId: CatalogAgentId;
  providerScopedKey?: string | null;
}>): string {
  const base = join(
    params.activeServerDir,
    'daemon',
    'connected-services',
    'homes',
    params.serviceId,
    params.profileId,
    params.agentId,
  );
  const providerScopedKey = typeof params.providerScopedKey === 'string' ? params.providerScopedKey.trim() : '';
  if (!providerScopedKey) return base;
  return join(base, normalizeMaterializationKeyForPath(providerScopedKey));
}

