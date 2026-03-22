import type { TransferEndpointCandidate } from '@happier-dev/protocol';
import {
  createMachineTransferRouteCache as createSharedMachineTransferRouteCache,
  DEFAULT_MACHINE_TRANSFER_ROUTE_CACHE_NEGATIVE_TTL_MS,
  DEFAULT_MACHINE_TRANSFER_ROUTE_CACHE_POSITIVE_TTL_MS,
  type MachineTransferRouteCache,
} from '@happier-dev/transfers';

import { readPositiveIntEnv } from '@/utils/readPositiveIntEnv';

function readTransferRouteCachePositiveTtlMs(): number {
  return readPositiveIntEnv(
    'HAPPIER_MACHINE_TRANSFER_ROUTE_CACHE_POSITIVE_TTL_MS',
    DEFAULT_MACHINE_TRANSFER_ROUTE_CACHE_POSITIVE_TTL_MS,
  );
}

function readTransferRouteCacheNegativeTtlMs(): number {
  return readPositiveIntEnv(
    'HAPPIER_MACHINE_TRANSFER_ROUTE_CACHE_NEGATIVE_TTL_MS',
    DEFAULT_MACHINE_TRANSFER_ROUTE_CACHE_NEGATIVE_TTL_MS,
  );
}

export function createMachineTransferRouteCache(params: Readonly<{
  serverId: string;
  now?: () => number;
}>): MachineTransferRouteCache {
  return createSharedMachineTransferRouteCache({
    serverId: params.serverId,
    now: params.now,
    positiveTtlMs: readTransferRouteCachePositiveTtlMs(),
    negativeTtlMs: readTransferRouteCacheNegativeTtlMs(),
  });
}
