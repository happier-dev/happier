import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { validateFinalCanonicalLayoutClosure } from './finalCanonicalLayoutClosure.ts';

function createRepo(): string {
  return mkdtempSync(join(tmpdir(), 'happier-final-canonical-layout-'));
}

function writeRepoFile(rootDir: string, filePath: string, content = ''): void {
  const absolutePath = join(rootDir, filePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, 'utf8');
}

function writeAcceptedF7Layout(rootDir: string): void {
  writeRepoFile(rootDir, 'apps/cli/src/agent/permissions/permissionRequestCoordinator.ts');
  writeRepoFile(rootDir, 'apps/cli/src/capabilities/systemTasks/liveSystemTasksRunner.ts');
  writeRepoFile(rootDir, 'apps/cli/src/capabilities/registry/toolSystemTasks.ts');
  writeRepoFile(rootDir, 'packages/protocol/src/runtime/events/v1.ts');
}

test('validateFinalCanonicalLayoutClosure accepts the adjudicated F.7 owner paths', () => {
  const rootDir = createRepo();
  writeAcceptedF7Layout(rootDir);

  const result = validateFinalCanonicalLayoutClosure({ rootDir });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('validateFinalCanonicalLayoutClosure rejects stale F.7 source paths', () => {
  const rootDir = createRepo();
  writeAcceptedF7Layout(rootDir);
  writeRepoFile(rootDir, 'apps/cli/src/agent/systemTasks/legacy.ts');
  writeRepoFile(rootDir, 'packages/protocol/src/runtimeEvents/index.ts');

  const result = validateFinalCanonicalLayoutClosure({ rootDir });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('apps/cli/src/agent/systemTasks')));
  assert.ok(result.errors.some((error) => error.includes('packages/protocol/src/runtimeEvents')));
});

test('validateFinalCanonicalLayoutClosure rejects missing canonical F.7 owner files', () => {
  const rootDir = createRepo();

  const result = validateFinalCanonicalLayoutClosure({ rootDir });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('permissionRequestCoordinator.ts')));
  assert.ok(result.errors.some((error) => error.includes('apps/cli/src/capabilities/systemTasks')));
  assert.ok(result.errors.some((error) => error.includes('toolSystemTasks.ts')));
  assert.ok(result.errors.some((error) => error.includes('packages/protocol/src/runtime/events/v1.ts')));
});
