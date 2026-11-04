import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { writeFakeBin } from '../../testkit/core/fake_bin_harness.mjs';

const control = resolve(import.meta.dirname, '../../../bin/hstack-dev-target-control');

for (const problem of [null, 'hashed size mismatch: 12 != 13', 'permission denied']) {
  test(`causal flush settles during alpha churn: ${problem ?? 'completed transfer'}`, { skip: process.platform === 'win32' }, async t => {
    const fixture = await createTempFixture(t, { prefix: 'hstack-sync-barrier-' });
    const dataDir = fixture.path('mutagen/data');
    t.after(() => rm(`/tmp/happier-sync-control-${process.getuid()}${dirname(dataDir)}`, { recursive: true, force: true }));
    await writeFile(fixture.path('source'), 'requested source\n');
    // Mutagen is the external process boundary. Its cycle acknowledges the
    // requested bytes while subsequent alpha writes keep its state Scanning.
    const { binDir } = writeFakeBin({ root: fixture.root, name: 'mutagen', content: `#!/bin/sh
case "$2" in
  flush)
    cp "$SYNC_FIXTURE/source" "$SYNC_FIXTURE/mirror"
    printf 'cycle\\n' >> "$SYNC_FIXTURE/cycles"
    printf 'later change\\n' >> "$SYNC_FIXTURE/churn"
    ;;
  list)
    scan=0/0
    [ -z "$SYNC_FIXTURE_PROBLEM" ] || scan=1/0
    printf '%s|Scanning|false|true|1|%s|0/0|true|1|0/0|0/0|active|2|ok|0|0\\n' "$3" "$scan"
    [ -z "$SYNC_FIXTURE_PROBLEM" ] || printf 'source/churn.mjs|%s\\n' "$SYNC_FIXTURE_PROBLEM"
    ;;
esac
exit 0
` });
    const result = spawnSync('/bin/sh', [control, '--sync-flush', 'happier-churn', '--', 'mutagen', 'sync', 'flush', 'happier-churn'], {
      env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin`, DBUS_SESSION_BUS_ADDRESS: '', MUTAGEN_DATA_DIRECTORY: dataDir,
        SYNC_FIXTURE: fixture.root, SYNC_FIXTURE_PROBLEM: problem ?? '' },
      encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.error, undefined, `barrier must settle after the acknowledged cycle: ${result.error?.code}`);
    assert.equal(result.status, problem ? 1 : 0, result.stderr);
    assert.equal(result.stdout, '', 'synchronization must preserve the payload output stream');
    assert.equal(await readFile(fixture.path('cycles'), 'utf8'), 'cycle\n', 'later alpha churn must not restart the caller’s cycle');
    assert.equal(await readFile(fixture.path('mirror'), 'utf8'), 'requested source\n');
    if (problem) assert.match(result.stderr, /HSTACK_SYNC_PROBLEM:.*source\/churn\.mjs/);
  });
}
