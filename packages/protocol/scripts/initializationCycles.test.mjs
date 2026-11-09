import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, vi } from 'vitest';
import {
  analyzeRuntimeImportCycles, compareCyclesToBaseline, formatGuardFailure, readBaselineCycles,
} from '../../../apps/cli/scripts/importCycleGuard.mjs';

// Share the entry-load guard's graph, evaluation semantics and dated debt baseline.
const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
const fs = createRequire(import.meta.url)('node:fs');
const originalRead = fs.readFileSync;
const reads = new Map();
// Observe the real filesystem boundary; never replace parsing or graph logic.
const observer = vi.spyOn(fs, 'readFileSync').mockImplementation((path, ...args) => {
  if (typeof path === 'string' && path.startsWith(sourceRoot)) reads.set(path, (reads.get(path) ?? 0) + 1);
  return originalRead(path, ...args);
});
syncBuiltinESMExports();
let result;
try {
  result = analyzeRuntimeImportCycles({
    sourceRoot,
    tsconfigPath: fileURLToPath(new URL('../tsconfig.json', import.meta.url)),
    evaluationOnly: true,
  });
} finally {
  observer.mockRestore();
  syncBuiltinESMExports();
}
const comparison = compareCyclesToBaseline({
  baselineCycles: readBaselineCycles(fileURLToPath(new URL(
    '../../../apps/cli/scripts/importCycleGuard.protocol.baseline.json', import.meta.url))),
  currentCycles: result.cycles,
});
test('Protocol module evaluation introduces no new eager cyclic reads', () => {
  assert.equal(comparison.newCycles.length, 0, formatGuardFailure(comparison.newCycles));
  // Exercise today's complete source inventory: one content read per module,
  // rather than re-reading source for each imported binding or cycle walk.
  for (const file of Object.keys(result.graph)) {
    assert.equal(reads.get(resolve(sourceRoot, file)), 1, `source reads for ${file}`);
  }
});
