import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { repoRootDir } from '../paths';

import { shapeOf, stableStringifyShape } from './shape';

export type ProviderBaselineV1 = {
  v: 1;
  providerId: string;
  scenarioId: string;
  createdAt: string;
  fixtureKeys: string[];
  shapesByKey: Record<string, string>;
};

export function computeProviderBaselineV1(params: {
  providerId: string;
  scenarioId: string;
  fixtureKeys: string[];
  fixturesExamples: Record<string, unknown>;
  existing?: ProviderBaselineV1 | null;
  nowIso?: string;
}): ProviderBaselineV1 {
  const shapesByKey: Record<string, string> = {};
  const existing = params.existing ?? null;

  for (const [k, v] of Object.entries(existing?.shapesByKey ?? {})) shapesByKey[k] = v;

  const keys = [...new Set(params.fixtureKeys)].sort();
  for (const key of keys) {
    const arr = (params.fixturesExamples[key] ?? []) as any[];
    if (Array.isArray(arr) && arr.length > 0) {
      shapesByKey[key] = stableStringifyShape(shapeOf(arr[0]?.payload));
    } else {
      // If we don't have an example for a baselined key, keep any existing shape (if present)
      // so partial fixture sets don't destroy historical expectations.
      if (typeof shapesByKey[key] !== 'string') {
        // Leave empty; diff will fail if key is required and observed is missing.
      }
    }
  }

  // Drop shapes for keys that are no longer part of this baseline keyset (avoid sticky unions).
  const shapesPruned: Record<string, string> = {};
  for (const key of keys) {
    const shape = shapesByKey[key];
    if (typeof shape === 'string') shapesPruned[key] = shape;
  }

  return {
    v: 1,
    providerId: params.providerId,
    scenarioId: params.scenarioId,
    createdAt: params.nowIso ?? new Date().toISOString(),
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
  return json;
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

export function diffProviderBaseline(params: {
  baseline: ProviderBaselineV1;
  observedFixtureKeys: string[];
  observedExamples: Record<string, unknown>;
  allowExtraKeys?: boolean;
}): { ok: true } | { ok: false; reason: string } {
  const baselineKeys = [...params.baseline.fixtureKeys].sort();
  const observedKeys = [...params.observedFixtureKeys].sort();
  const baselineSet = new Set(baselineKeys);
  const allowExtraKeys = params.allowExtraKeys ?? true;

  const missing = baselineKeys.filter((k) => !observedKeys.includes(k));
  if (missing.length > 0) {
    return { ok: false, reason: `Fixture keys drifted (missing keys): ${missing.join(', ')}` };
  }

  const extra = observedKeys.filter((k) => !baselineSet.has(k));
  if (!allowExtraKeys && extra.length > 0) {
    return { ok: false, reason: `Fixture keys drifted (unexpected keys): ${extra.join(', ')}` };
  }

  for (const key of baselineKeys) {
    const expectedShape = params.baseline.shapesByKey[key];
    if (!expectedShape) continue;
    const arr = (params.observedExamples[key] ?? []) as any[];
    if (!Array.isArray(arr) || arr.length === 0) {
      return { ok: false, reason: `Missing fixtures array for baseline key: ${key}` };
    }
    const observedShape = stableStringifyShape(shapeOf(arr[0]?.payload));
    if (observedShape !== expectedShape) {
      return { ok: false, reason: `Payload shape drifted for ${key}` };
    }
  }

  return { ok: true };
}
