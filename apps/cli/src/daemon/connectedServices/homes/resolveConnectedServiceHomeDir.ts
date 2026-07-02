import { join } from 'node:path';

import type { ConnectedServiceId, ConnectedServiceProfileId } from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/backends/types';
import { normalizeMaterializationKeyForPath } from '../materialize/normalizeMaterializationKeyForPath';

type JoinPath = (...paths: string[]) => string;

const CONNECTED_SERVICE_GROUPS_HOME_SEGMENT = '__groups';

export function resolveConnectedServiceHomeDir(params: Readonly<{
  activeServerDir: string;
  serviceId: ConnectedServiceId;
  profileId: ConnectedServiceProfileId;
  agentId: CatalogAgentId;
  providerScopedKey?: string | null;
  pathJoin?: JoinPath;
}>): string {
  const pathJoin = params.pathJoin ?? join;
  const base = pathJoin(
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
  return pathJoin(base, normalizeMaterializationKeyForPath(providerScopedKey));
}

export function resolveConnectedServiceGroupHomeDir(params: Readonly<{
  activeServerDir: string;
  serviceId: ConnectedServiceId;
  groupId: string;
  agentId: CatalogAgentId;
  providerScopedKey?: string | null;
  pathJoin?: JoinPath;
}>): string {
  const pathJoin = params.pathJoin ?? join;
  const base = pathJoin(
    params.activeServerDir,
    'daemon',
    'connected-services',
    'homes',
    params.serviceId,
    CONNECTED_SERVICE_GROUPS_HOME_SEGMENT,
    params.groupId,
    params.agentId,
  );
  const providerScopedKey = typeof params.providerScopedKey === 'string' ? params.providerScopedKey.trim() : '';
  if (!providerScopedKey) return base;
  return pathJoin(base, normalizeMaterializationKeyForPath(providerScopedKey));
}
