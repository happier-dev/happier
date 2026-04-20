import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { collectMigrationGovernanceSourceFiles } from '../validateMigrationInventory.ts';

test('collectMigrationGovernanceSourceFiles includes scripts/testing governance sources', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-migration-governance-'));
  mkdirSync(join(rootDir, 'apps/cli/src'), { recursive: true });
  mkdirSync(join(rootDir, 'scripts/testing/migrations'), { recursive: true });

  writeFileSync(join(rootDir, 'apps/cli/src/runtimeOwner.ts'), 'export const runtimeOwner = true;\n', 'utf8');
  writeFileSync(join(rootDir, 'scripts/testing/migrations/proofGuard.ts'), 'export const proofGuard = true;\n', 'utf8');

  const files = collectMigrationGovernanceSourceFiles(rootDir).map((file) => file.filePath).sort((left, right) => left.localeCompare(right));

  assert.deepEqual(files, [
    'apps/cli/src/runtimeOwner.ts',
    'scripts/testing/migrations/proofGuard.ts',
  ]);
});
