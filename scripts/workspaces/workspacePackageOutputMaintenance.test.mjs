import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import * as owner from './ensureWorkspacePackagesBuilt.mjs';
import { withWorkspaceBundleLock } from './workspaceBundleLock.mjs';
import { createTempFixture } from '../../apps/stack/scripts/testkit/core/temp_fixture.mjs';

test('workspace output maintenance reuses expiry and preserves publishing, recent and leased outputs', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-output-retention-maintenance-' });
  const store = fixture.path('cache');
  mkdirSync(store);
  const current = join(store, 'a'.repeat(64));
  const expired = join(store, 'b'.repeat(64));
  const recent = join(store, 'c'.repeat(64));
  const leased = join(store, 'd'.repeat(64));
  const foreign = join(store, 'operator-data');
  for (const dir of [current, expired, recent, leased, foreign]) {
    mkdirSync(dir);
    writeFileSync(join(dir, 'output'), 'preserve valid output');
  }
  for (const dir of [current, expired, leased, foreign]) {
    utimesSync(dir, new Date(0), new Date(0));
  }
  await withWorkspaceBundleLock(async () => {
    for (const name of readdirSync(store)) {
      await owner.reclaimRetiredPackageOutput(current, name);
    }
    assert.equal(existsSync(expired), false, 'expired unleased output is retired without building');
    for (const dir of [current, recent, leased, foreign]) {
      assert.equal(existsSync(dir), true, 'publication, recent, active or unowned data stays');
    }
  }, { lockPath: leased + '.lock' });
  await owner.reclaimRetiredPackageOutput(current, 'd'.repeat(64));
  assert.equal(existsSync(leased), false, 'released expired output becomes reclaimable');
});
