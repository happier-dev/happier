import type { ConnectedServiceMaterializationIdentityV1 } from '@happier-dev/protocol';

import type { TrackedSession } from '../../../types';
import {
  readConnectedServiceMaterializationIdentityFromEnvironment,
  readConnectedServiceMaterializationIdentityFromSpawnOptions,
} from '../../materialization/identity';
import {
  ConnectedServiceMaterializedHomeCleanupScheduler,
  type ConnectedServiceRetainedMaterializationKeysResult,
  type ConnectedServiceRetainedMaterializedHomeSanitizer,
} from './ConnectedServiceMaterializedHomeCleanupScheduler';

function readIdentityId(identity: ConnectedServiceMaterializationIdentityV1 | null): string | null {
  const id = typeof identity?.id === 'string' ? identity.id.trim() : '';
  return id || null;
}

function readTrackedMaterializationKey(tracked: TrackedSession): string | null {
  return readIdentityId(readConnectedServiceMaterializationIdentityFromSpawnOptions(tracked.spawnOptions))
    ?? readIdentityId(readConnectedServiceMaterializationIdentityFromEnvironment(tracked.spawnOptions?.environmentVariables));
}

export function createConnectedServiceMaterializedHomeCleanupScheduler(params: Readonly<{
  baseDir: string;
  pidToTrackedSession: ReadonlyMap<number, TrackedSession>;
  nowMs?: () => number;
  getRetainedMaterializationKeys?: () => Promise<ConnectedServiceRetainedMaterializationKeysResult> | ConnectedServiceRetainedMaterializationKeysResult;
  sanitizeRetainedMaterializedHome?: ConnectedServiceRetainedMaterializedHomeSanitizer;
  orphanTtlMs?: number;
  attemptTtlMs?: number;
  maxCleanupRetries?: number;
}>): ConnectedServiceMaterializedHomeCleanupScheduler {
  return new ConnectedServiceMaterializedHomeCleanupScheduler({
    baseDir: params.baseDir,
    nowMs: params.nowMs ?? (() => Date.now()),
    ...(params.sanitizeRetainedMaterializedHome
      ? { sanitizeRetainedMaterializedHome: params.sanitizeRetainedMaterializedHome }
      : {}),
    getLiveMaterializationKeys: () => {
      const keys: string[] = [];
      for (const tracked of params.pidToTrackedSession.values()) {
        const key = readTrackedMaterializationKey(tracked);
        if (key) keys.push(key);
      }
      return keys;
    },
    ...(params.getRetainedMaterializationKeys
      ? { getRetainedMaterializationKeys: params.getRetainedMaterializationKeys }
      : {}),
    ...(params.orphanTtlMs === undefined ? {} : { orphanTtlMs: params.orphanTtlMs }),
    ...(params.attemptTtlMs === undefined ? {} : { attemptTtlMs: params.attemptTtlMs }),
    ...(params.maxCleanupRetries === undefined ? {} : { maxCleanupRetries: params.maxCleanupRetries }),
  });
}
