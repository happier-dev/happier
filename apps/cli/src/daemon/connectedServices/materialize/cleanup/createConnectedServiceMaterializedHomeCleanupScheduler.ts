import type { ConnectedServiceMaterializationIdentityV1 } from '@happier-dev/protocol';

import type { TrackedSession } from '../../../types';
import { isExecutionRunHomeRetained, readRetainedExecutionRunHomeKeys } from '../../../executionRunRegistry';
import { hasLocalConnectedServiceResumeState } from '../../stateSharing/connectedServiceStateSharingManifest';
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

/** Exit cannot query server Session absence. The incumbent sweep owns that decision. */
export async function isConnectedServiceMaterializedHomeRetainedOnExit(input: Readonly<{
  materializationKey: string;
  homeRoot: string;
}>): Promise<boolean> {
  return input.materializationKey.startsWith('csm_')
    || await isExecutionRunHomeRetained(input.materializationKey)
    || await hasLocalConnectedServiceResumeState(input.homeRoot);
}

export function createConnectedServiceMaterializedHomeCleanupScheduler(params: Readonly<{
  baseDir: string;
  isolationBaseDir?: string;
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
    ...(params.isolationBaseDir ? { isolationBaseDir: params.isolationBaseDir } : {}),
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
    getRetainedMaterializationKeys: async () => {
      const [retained, runKeys] = await Promise.all([
        params.getRetainedMaterializationKeys?.() ?? [],
        readRetainedExecutionRunHomeKeys(),
      ]);
      if (typeof retained === 'object' && retained !== null && 'status' in retained) {
        if (retained.status === 'unavailable') return retained;
        return [...retained.keys, ...runKeys];
      }
      return [...retained, ...runKeys];
    },
    ...(params.orphanTtlMs === undefined ? {} : { orphanTtlMs: params.orphanTtlMs }),
    ...(params.attemptTtlMs === undefined ? {} : { attemptTtlMs: params.attemptTtlMs }),
    ...(params.maxCleanupRetries === undefined ? {} : { maxCleanupRetries: params.maxCleanupRetries }),
  });
}
