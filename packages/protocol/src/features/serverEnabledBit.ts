import type { FeatureId } from './featureIds.js';
import type { FeaturesResponse } from '../features.js';
import { getCanonicalFeatureId, getFeatureAliases } from './catalog.js';

export function resolveServerEnabledBitPath(featureId: FeatureId): readonly string[] {
  const segments = getCanonicalFeatureId(featureId).split('.').filter(Boolean);
  return Object.freeze(['features', ...segments, 'enabled']);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

export function readServerEnabledBit(response: Pick<FeaturesResponse, 'features'>, featureId: FeatureId): boolean | null {
  const path = resolveServerEnabledBitPath(featureId);
  let cursor: unknown = response as unknown;
  for (const segment of path) {
    if (!isRecord(cursor)) return null;
    cursor = cursor[segment];
  }
  return typeof cursor === 'boolean' ? cursor : null;
}


export function tryWriteServerEnabledBitInPlace(
  response: FeaturesResponse,
  featureId: FeatureId,
  enabled: boolean,
): boolean {
  const path = resolveServerEnabledBitPath(featureId);
  const written = writeEnabledBitAtPath(response, path, enabled);
  for (const alias of getFeatureAliases(featureId)) {
    writeEnabledBitAtPath(response, ['features', ...alias.split('.'), 'enabled'], enabled);
  }
  return written;
}

function writeEnabledBitAtPath(response: FeaturesResponse, path: readonly string[], enabled: boolean): boolean {
  if (path.length === 0) return false;

  let cursor: unknown = response as unknown;
  for (let i = 0; i < path.length - 1; i += 1) {
    const segment = path[i]!;
    if (!isRecord(cursor)) return false;
    cursor = cursor[segment];
  }

  const last = path[path.length - 1]!;
  if (!isRecord(cursor)) return false;
  if (typeof cursor[last] !== 'boolean') return false;
  cursor[last] = enabled;
  return true;
}
