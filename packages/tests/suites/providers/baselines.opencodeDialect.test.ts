import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

type ShapeNode = {
  t?: unknown;
  item?: ShapeNode | null;
  keys?: Record<string, ShapeNode>;
};

async function readOpencodeBaselineFiles(): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const dir = join(process.cwd(), 'baselines', 'providers', 'opencode');
  const entries = await readdir(dir);
  return entries.filter((name) => name.endsWith('.json')).sort().map((name) => join(dir, name));
}

function parseShape(value: unknown): ShapeNode | null {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as ShapeNode;
    } catch {
      return null;
    }
  }
  if (value && typeof value === 'object') return value as ShapeNode;
  return null;
}

function collectOpaqueMetaViolations(shape: ShapeNode | null, path: string, out: string[]): void {
  if (!shape || typeof shape !== 'object') return;
  if (shape.t === 'array') {
    collectOpaqueMetaViolations(shape.item ?? null, `${path}[]`, out);
    return;
  }
  if (shape.t !== 'object' || !shape.keys || typeof shape.keys !== 'object') return;

  for (const [key, child] of Object.entries(shape.keys)) {
    const childPath = `${path}.${key}`;
    if ((key === '_acp' || key === '_raw') && child?.t !== 'string') {
      out.push(childPath);
    }
    collectOpaqueMetaViolations(child, childPath, out);
  }
}

describe('providers: opencode baseline schema dialect', () => {
  it('keeps _acp/_raw as opaque string shape markers across all baseline files', async () => {
    const baselineFiles = await readOpencodeBaselineFiles();
    const violations: string[] = [];

    for (const filePath of baselineFiles) {
      const raw = await readFile(filePath, 'utf8');
      const baseline = JSON.parse(raw) as { shapesByKey?: Record<string, unknown> };
      for (const [fixtureKey, shapeValue] of Object.entries(baseline.shapesByKey ?? {})) {
        const parsed = parseShape(shapeValue);
        collectOpaqueMetaViolations(parsed, `${filePath}:${fixtureKey}`, violations);
      }
    }

    expect(violations).toEqual([]);
  });
});
