import type { ConnectedServiceMaterializationIdentityV1 } from '@happier-dev/protocol';

import type { TrackedSession } from '../../../types';
import { isExecutionRunHomeRetained, readRetainedExecutionRunHomeKeys } from '../../../executionRunRegistry';
import { hasLocalConnectedServiceResumeState } from '../../stateSharing/connectedServiceStateSharingManifest';
import { listConnectedServiceRetainedMaterializedHomeSanitizers } from '../../catalogHooks';
import { logger } from '@/utils/logger';
import {
  readConnectedServiceMaterializationIdentityFromEnvironment,
  readConnectedServiceMaterializationIdentityFromSpawnOptions,
} from '../../materialization/identity';
import {
  ConnectedServiceMaterializedHomeCleanupScheduler,
  isContainedMaterializedHomeDirectory,
  type ConnectedServiceRetainedMaterializationKeysResult,
  type ConnectedServiceRetainedMaterializedHomeSanitizer,
} from './ConnectedServiceMaterializedHomeCleanupScheduler';
import type { ReadonlyTrackedSessionMap } from '@/daemon/sessions/sessionTrackingKey';

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

/** Each Agent plugin's hygiene for a home that is kept but no longer running. */
export async function sanitizeStoppedConnectedServiceMaterializedHome(identityRoot: string): Promise<void> {
  for (const sanitize of listConnectedServiceRetainedMaterializedHomeSanitizers()) {
    try { await sanitize(identityRoot); }
    catch (error) { logger.debug('[CONNECTED SERVICES] Retained-home hygiene failed (non-fatal)', { identityRoot, error }); }
  }
}

/** Runner exit: an unretained home is removed; a retained one is sanitized once, now that it stopped. */
export async function settleStoppedConnectedServiceMaterializedHome(input: Readonly<{
  materializationKey: string;
  homeRoot: string;
  identityRoot: string;
  /** The materialized store root the identity root must sit physically inside. */
  containmentRoot: string;
  probe: boolean;
  remove(): Promise<void>;
}>): Promise<void> {
  if (input.probe || !await isConnectedServiceMaterializedHomeRetainedOnExit(input)) {
    await input.remove();
    return;
  }
  if (!await isContainedMaterializedHomeDirectory(input.identityRoot, input.containmentRoot).catch(() => false)) return;
  await sanitizeStoppedConnectedServiceMaterializedHome(input.identityRoot);
}

export function createConnectedServiceMaterializedHomeCleanupScheduler(params: Readonly<{
  baseDir: string;
  isolationBaseDir?: string;
  trackedSessionsByKey: ReadonlyTrackedSessionMap;
  nowMs?: () => number;
  getRetainedMaterializationKeys?: () => Promise<ConnectedServiceRetainedMaterializationKeysResult> | ConnectedServiceRetainedMaterializationKeysResult;
  sanitizeRetainedMaterializedHome?: ConnectedServiceRetainedMaterializedHomeSanitizer;
  orphanTtlMs?: number;
  attemptTtlMs?: number;
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
      for (const tracked of params.trackedSessionsByKey.values()) {
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
  });
}
