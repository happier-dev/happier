import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { repoRootDir } from '../paths';

import { normalizeShapeForBaseline, shapeOf, stableStringifyShape, type Shape } from './shape';
import type { ProviderScenario } from './types';

export type ProviderBaselineShapeEntry = string | Shape;

export type ProviderBaselineV1 = {
  v: 1;
  providerId: string;
  scenarioId: string;
  createdAt: string;
  fixtureKeys: string[];
  shapesByKey: Record<string, ProviderBaselineShapeEntry>;
};

function isShape(value: unknown): value is Shape {
  if (!value || typeof value !== 'object') return false;
  const tag = (value as { t?: unknown }).t;
  return tag === 'null' || tag === 'boolean' || tag === 'number' || tag === 'string' || tag === 'array' || tag === 'object';
}

export function parseBaselineShapeEntry(entry: ProviderBaselineShapeEntry | undefined): Shape | null {
  if (!entry) return null;
  if (typeof entry === 'string') {
    try {
      const parsed = JSON.parse(entry) as unknown;
      if (!isShape(parsed)) return null;
      return normalizeShapeForBaseline(parsed);
    } catch {
      return null;
    }
  }
  if (!isShape(entry)) return null;
  return normalizeShapeForBaseline(entry);
}

export function stableStringifyBaselineShapeEntry(entry: ProviderBaselineShapeEntry | undefined): string | null {
  const parsed = parseBaselineShapeEntry(entry);
  if (!parsed) return null;
  return stableStringifyShape(parsed);
}

function scoreShape(shape: Shape): number {
  // Higher score => "more informative" fixture payload (more structure/keys).
  if (!shape || typeof shape !== 'object') return 0;

  switch (shape.t) {
    case 'null':
    case 'boolean':
    case 'number':
    case 'string':
      return 1;
    case 'array': {
      return 1 + (shape.item ? scoreShape(shape.item) : 0);
    }
    case 'object': {
      const keys = shape.keys ?? {};
      const entries = Object.entries(keys);
      return 1 + entries.length + entries.reduce((acc, [, v]) => acc + scoreShape(v), 0);
    }
    default:
      return 1;
  }
}

function pickMostInformativeFixtureExample(arr: any[]): any | null {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  if (arr.length === 1) return arr[0] ?? null;

  let best: any | null = null;
  let bestScore = -1;

  for (const item of arr) {
    const payload = item?.payload;
    const normalized = normalizeShapeForBaseline(shapeOf(payload));
    const score = scoreShape(normalized);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  return best;
}

export function computeProviderBaselineV1(params: {
  providerId: string;
  scenarioId: string;
  fixtureKeys: string[];
  fixturesExamples: Record<string, unknown>;
  existing?: ProviderBaselineV1 | null;
  nowIso?: string;
}): ProviderBaselineV1 {
  const shapesByKey: Record<string, ProviderBaselineShapeEntry> = {};
  const existing = params.existing ?? null;

  for (const [k, v] of Object.entries(existing?.shapesByKey ?? {})) shapesByKey[k] = v;

  const keys = [...new Set(params.fixtureKeys)].sort();
  for (const key of keys) {
    const arr = (params.fixturesExamples[key] ?? []) as any[];
    if (Array.isArray(arr) && arr.length > 0) {
      const best = pickMostInformativeFixtureExample(arr);
      shapesByKey[key] = normalizeShapeForBaseline(shapeOf(best?.payload));
    } else {
      // If we don't have an example for a baselined key, keep any existing shape (if present)
      // so partial fixture sets don't destroy historical expectations.
      if (!parseBaselineShapeEntry(shapesByKey[key])) {
        // Leave empty; diff will fail if key is required and observed is missing.
      }
    }
  }

  // Drop shapes for keys that are no longer part of this baseline keyset (avoid sticky unions).
  const shapesPruned: Record<string, ProviderBaselineShapeEntry> = {};
  for (const key of keys) {
    const shape = parseBaselineShapeEntry(shapesByKey[key]);
    if (shape) shapesPruned[key] = shape;
  }

  return {
    v: 1,
    providerId: params.providerId,
    scenarioId: params.scenarioId,
    createdAt: params.nowIso ?? existing?.createdAt ?? new Date().toISOString(),
    fixtureKeys: keys,
    shapesByKey: shapesPruned,
  };
}

export function providerBaselinePath(providerId: string, scenarioId: string): string {
  return join(repoRootDir(), 'packages', 'tests', 'baselines', 'providers', providerId, `${scenarioId}.json`);
}

export async function loadProviderBaseline(providerId: string, scenarioId: string): Promise<ProviderBaselineV1 | null> {
  const path = providerBaselinePath(providerId, scenarioId);
  if (!existsSync(path)) return null;
  const raw = await readFile(path, 'utf8');
  const json = JSON.parse(raw) as ProviderBaselineV1;
  if (!json || json.v !== 1) throw new Error(`Invalid provider baseline (expected v=1): ${path}`);

  const normalizedShapesByKey: Record<string, ProviderBaselineShapeEntry> = {};
  for (const [fixtureKey, shapeEntry] of Object.entries(json.shapesByKey ?? {})) {
    const parsed = parseBaselineShapeEntry(shapeEntry);
    if (!parsed) throw new Error(`Invalid provider baseline shape for key ${fixtureKey}: ${path}`);
    normalizedShapesByKey[fixtureKey] = parsed;
  }

  return {
    ...json,
    shapesByKey: normalizedShapesByKey,
  };
}

export async function writeProviderBaseline(params: {
  providerId: string;
  scenarioId: string;
  fixtureKeys: string[];
  fixturesExamples: Record<string, unknown>;
}): Promise<{ path: string }> {
  const { providerId, scenarioId } = params;
  const path = providerBaselinePath(providerId, scenarioId);
  const existing = await loadProviderBaseline(providerId, scenarioId).catch(() => null);
  const baseline = computeProviderBaselineV1({
    providerId,
    scenarioId,
    fixtureKeys: params.fixtureKeys,
    fixturesExamples: params.fixturesExamples,
    existing,
  });

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  return { path };
}

/**
 * Selects a stable subset of observed fixture keys to "lock" in a baseline.
 *
 * Rationale:
 * - Some scenarios intentionally allow providers to pick between multiple tool names/shapes
 *   (e.g. `Edit` OR `Write`).
 * - If we baseline *all* observed keys, the baseline can become a sticky union and later fail
 *   when a provider legitimately chooses a different option (even though the scenario still passes).
 *
 * Strategy:
 * - Always include `requiredFixtureKeys`.
 * - For each `requiredAnyFixtureKeys` bucket, include the *first* observed key in bucket order.
 * - Ignore any other observed keys (they are still validated by schema parsing, but won't be baselined).
 */
export function selectBaselineFixtureKeysFromScenario(params: {
  scenario: Pick<ProviderScenario, 'requiredFixtureKeys' | 'requiredAnyFixtureKeys'>;
  observedFixtureKeys: string[];
}): string[] {
  const out = new Set<string>();

  for (const key of params.scenario.requiredFixtureKeys ?? []) {
    out.add(key);
  }

  const buckets = params.scenario.requiredAnyFixtureKeys ?? [];

  const isUniformBucketKind = (bucket: string[], kindToken: '/tool-call/' | '/tool-result/') =>
    bucket.length > 0 && bucket.every((k) => k.includes(kindToken));

  const getToolName = (k: string) => {
    const parts = k.split('/');
    return parts.length ? parts[parts.length - 1] ?? '' : '';
  };

  const callBucketIndex = buckets.findIndex((b) => isUniformBucketKind(b, '/tool-call/'));
  const resultBucketIndex = buckets.findIndex((b) => isUniformBucketKind(b, '/tool-result/'));

  const usedBucketIndices = new Set<number>();

  if (callBucketIndex >= 0 && resultBucketIndex >= 0) {
    const callBucket = buckets[callBucketIndex]!;
    const resultBucket = buckets[resultBucketIndex]!;

    const observedCall = callBucket.filter((k) => params.observedFixtureKeys.includes(k));
    const observedResult = resultBucket.filter((k) => params.observedFixtureKeys.includes(k));
    const callNames = new Set(observedCall.map(getToolName).filter(Boolean));
    const resultNames = new Set(observedResult.map(getToolName).filter(Boolean));

    const intersection = new Set<string>();
    for (const n of callNames) {
      if (resultNames.has(n)) intersection.add(n);
    }

    if (intersection.size > 0) {
      // Prefer the earliest tool option by bucket order, but only if we observed both call+result.
      const preferredName =
        callBucket.map(getToolName).find((n) => n && intersection.has(n) && callNames.has(n) && resultNames.has(n)) ?? null;
      if (preferredName) {
        const callKey = callBucket.find((k) => params.observedFixtureKeys.includes(k) && getToolName(k) === preferredName);
        const resultKey = resultBucket.find((k) => params.observedFixtureKeys.includes(k) && getToolName(k) === preferredName);
        if (callKey) out.add(callKey);
        if (resultKey) out.add(resultKey);
        usedBucketIndices.add(callBucketIndex);
        usedBucketIndices.add(resultBucketIndex);
      }
    }
  }

  for (const [i, bucket] of buckets.entries()) {
    if (usedBucketIndices.has(i)) continue;
    const selected = bucket.find((k) => params.observedFixtureKeys.includes(k));
    if (selected) out.add(selected);
  }

  return [...out].sort();
}

function isShapeCompatible(expected: Shape, observed: Shape): boolean {
  if (expected.t !== observed.t) return false;

  if (expected.t === 'array' && observed.t === 'array') {
    // If the baseline didn't specify an item shape, accept any array contents.
    if (expected.item === null) return true;
    // If the observed array is empty we can't infer its item shape; accept to avoid brittleness.
    if (observed.item === null) return true;
    return isShapeCompatible(expected.item, observed.item);
  }

  if (expected.t === 'object' && observed.t === 'object') {
    const expectedKeys = expected.keys ?? {};
    const observedKeys = observed.keys ?? {};
    for (const [k, expectedChild] of Object.entries(expectedKeys)) {
      const observedChild = observedKeys[k];
      if (!observedChild) return false;
      if (!isShapeCompatible(expectedChild, observedChild)) return false;
    }
    return true;
  }

  // Primitive shape: t matched.
  return true;
}

export function diffProviderBaseline(params: {
  baseline: ProviderBaselineV1;
  observedFixtureKeys: string[];
  observedExamples: Record<string, unknown>;
  allowExtraKeys?: boolean;
  scenario?: Pick<ProviderScenario, 'requiredAnyFixtureKeys'> | null;
}): { ok: true } | { ok: false; reason: string } {
  const baselineKeys = [...params.baseline.fixtureKeys].sort();
  const observedKeys = [...params.observedFixtureKeys].sort();
  const baselineSet = new Set(baselineKeys);
  const allowExtraKeys = params.allowExtraKeys ?? true;
  const anyBuckets = params.scenario?.requiredAnyFixtureKeys ?? [];

  const isMissingAllowedByAnyBucket = (missingKey: string): boolean => {
    const bucket = anyBuckets.find((b) => Array.isArray(b) && b.includes(missingKey));
    if (!bucket) return false;
    return bucket.some((alt) => observedKeys.includes(alt));
  };

  const missing = baselineKeys.filter((k) => !observedKeys.includes(k));
  const missingHard = missing.filter((k) => !isMissingAllowedByAnyBucket(k));
  if (missingHard.length > 0) {
    return { ok: false, reason: `Fixture keys drifted (missing keys): ${missingHard.join(', ')}` };
  }

  const extra = observedKeys.filter((k) => !baselineSet.has(k));
  if (!allowExtraKeys && extra.length > 0) {
    return { ok: false, reason: `Fixture keys drifted (unexpected keys): ${extra.join(', ')}` };
  }

  for (const key of baselineKeys) {
    const expectedShapeEntry = params.baseline.shapesByKey[key];
    if (!expectedShapeEntry) continue;
    if (!observedKeys.includes(key) && isMissingAllowedByAnyBucket(key)) {
      // This key is optional in practice (a valid any-of alternative was observed).
      // Skip shape drift checks for this key to avoid brittle baselines.
      continue;
    }
    const arr = (params.observedExamples[key] ?? []) as any[];
    if (!Array.isArray(arr) || arr.length === 0) {
      return { ok: false, reason: `Missing fixtures array for baseline key: ${key}` };
    }
    const expectedParsed = parseBaselineShapeEntry(expectedShapeEntry);
    if (!expectedParsed) {
      return { ok: false, reason: `Invalid baseline shape for key: ${key}` };
    }

    // Back-compat: observed fixtures often include an initial "minimal" payload for a tool call
    // followed by a later, more informative update (same callId). Older baselines may have
    // captured either; accept any observed example compatible with the baselined shape.
    let anyMatch = false;
    for (const item of arr) {
      const observedParsed = normalizeShapeForBaseline(shapeOf(item?.payload));
      if (isShapeCompatible(expectedParsed, observedParsed)) {
        anyMatch = true;
        break;
      }
    }

    if (!anyMatch) {
      return { ok: false, reason: `Payload shape drifted for ${key}` };
    }
  }

  return { ok: true };
}
