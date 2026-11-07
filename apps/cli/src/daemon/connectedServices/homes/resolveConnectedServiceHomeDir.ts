import { join } from 'node:path';

import type { ConnectedServiceId, ConnectedServiceProfileId } from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/backends/types';
import { normalizeMaterializationKeyForPath } from '../materialize/normalizeMaterializationKeyForPath';

type JoinPath = (...paths: string[]) => string;

const CONNECTED_SERVICE_GROUPS_HOME_SEGMENT = '__groups';

export type ConnectedServiceHomeSelection =
  | Readonly<{ kind: 'profile'; profileId: string }>
  | Readonly<{ kind: 'group'; groupId: string }>;

export function resolveConnectedServiceHomesDir(params: Readonly<{
  activeServerDir: string;
  pathJoin?: JoinPath;
}>): string {
  return (params.pathJoin ?? join)(params.activeServerDir, 'daemon', 'connected-services', 'homes');
}

export function resolveConnectedServiceSelectionHomeDir(params: Readonly<{
  activeServerDir: string;
  serviceId: ConnectedServiceId;
  agentId: CatalogAgentId;
  fallbackProfileId: ConnectedServiceProfileId;
  selection?: ConnectedServiceHomeSelection | null;
}>): string {
  return params.selection?.kind === 'group'
    ? resolveConnectedServiceGroupHomeDir({ ...params, groupId: params.selection.groupId })
    : resolveConnectedServiceHomeDir({
        ...params,
        profileId: params.selection?.kind === 'profile' ? params.selection.profileId : params.fallbackProfileId,
      });
}

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
    resolveConnectedServiceHomesDir(params),
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
    resolveConnectedServiceGroupsHomesDir(params),
    params.groupId,
    params.agentId,
  );
  const providerScopedKey = typeof params.providerScopedKey === 'string' ? params.providerScopedKey.trim() : '';
  if (!providerScopedKey) return base;
  return pathJoin(base, normalizeMaterializationKeyForPath(providerScopedKey));
}

export function resolveConnectedServiceGroupsHomesDir(params: Readonly<{
  activeServerDir: string;
  serviceId: ConnectedServiceId;
  pathJoin?: JoinPath;
}>): string {
  return (params.pathJoin ?? join)(resolveConnectedServiceHomesDir(params), params.serviceId, CONNECTED_SERVICE_GROUPS_HOME_SEGMENT);
}
