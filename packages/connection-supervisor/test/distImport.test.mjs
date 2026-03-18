import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

test('built dist entrypoint is importable via Node ESM', async () => {
  const mod = await import('../dist/index.js');
  assert.equal(typeof mod.createManagedConnectionSupervisor, 'function');
  assert.equal(typeof mod.computeManagedConnectionBackoffMs, 'function');
  assert.equal(typeof mod.deriveManagedConnectionReason, 'function');
});

test('build output excludes test artifacts', () => {
  assert.equal(existsSync(new URL('../dist/createManagedConnectionSupervisor.test.js', import.meta.url)), false);
});

test('build output excludes incremental build metadata', () => {
  assert.equal(existsSync(new URL('../dist/.tsbuildinfo', import.meta.url)), false);
});
