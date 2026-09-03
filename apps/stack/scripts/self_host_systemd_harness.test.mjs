import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const harnessPath = new URL('./self_host_systemd.real.integration.test.mjs', import.meta.url);

test('systemd release harness preflights system mode and keeps every lifecycle command in that mode', async () => {
  const source = await readFile(harnessPath, 'utf8');

  const systemManagerPreflight = source.indexOf("['is-system-running']");
  const firstBinaryBuild = source.indexOf("'scripts/pipeline/release/build-hstack-binaries.mjs'");
  assert.ok(systemManagerPreflight >= 0, 'expected an explicit systemd system-manager prerequisite check');
  assert.ok(
    systemManagerPreflight < firstBinaryBuild,
    'expected systemd prerequisites to fail before the expensive release binary builds',
  );

  assert.equal(
    source.match(/'self-host', 'install', '--channel=preview', '--mode=system'/g)?.length ?? 0,
    1,
    'expected the systemd install to select system mode explicitly',
  );
  assert.equal(
    source.match(/'self-host', 'status', '--channel=preview', '--mode=system'/g)?.length ?? 0,
    1,
    'expected systemd status to inspect the same system-mode installation',
  );
  assert.equal(
    source.match(/'self-host', 'uninstall', '--channel=preview', '--mode=system'/g)?.length ?? 0,
    2,
    'expected normal and cleanup uninstalls to target the same system-mode installation',
  );
});
