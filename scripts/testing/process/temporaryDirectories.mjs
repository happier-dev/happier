import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const roots = new Set();
const inheritedRoots = String(process.env.HAPPIER_TEST_TEMP_ROOTS ?? '').split('\n').filter(Boolean);
const nativeIdentity = fileURLToPath(new URL('../../../apps/stack/scripts/utils/proc/native_process_identity.sh', import.meta.url));
const custody = fileURLToPath(new URL('../../../apps/stack/scripts/utils/dev_targets/remote_execution_custody.sh', import.meta.url));
let owner;

function publishRoots() {
  const owned = [...roots].map(fixture => fixture.root).filter(root => !/[\r\n]/.test(root));
  const bindings = [...new Set([...inheritedRoots, ...owned])];
  if (bindings.length) process.env.HAPPIER_TEST_TEMP_ROOTS = bindings.join('\n');
  else delete process.env.HAPPIER_TEST_TEMP_ROOTS;
}

function cleanupFixtures(fixtures) {
  let retained = new Set();
  if (process.platform === 'linux' && fixtures.length) {
    const removing = new Set(fixtures.map(fixture => fixture.root));
    // The probe itself must not inherit the roots it is checking: it is an
    // observer, not a root consumer. Other descendants retain their binding.
    const probeRoots = String(process.env.HAPPIER_TEST_TEMP_ROOTS ?? '').split('\n').filter(root => root && !removing.has(root));
    const users = spawnSync('/bin/bash', [custody, 'test-temp-users', fixtures[0].root, 'test-temp-cleanup'], {
      env: { ...process.env, HAPPIER_TEST_TEMP_ROOTS: probeRoots.join('\n') },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    // Unknown observation retains all roots. Batch exit cleanup observes once,
    // even when a failed teardown left several fixtures registered.
    if (users.status !== 0) return;
    retained = new Set(users.stdout.split('\n'));
  }
  for (const fixture of fixtures) {
    if (retained.has(fixture.root)) continue;
    rmSync(fixture.root, { recursive: true, force: true });
    roots.delete(fixture);
  }
  publishRoots();
  if (!roots.size) process.off('exit', cleanupOnExit);
}

function ownerMarker() {
  if (owner !== undefined) return owner;
  owner = null;
  if (process.platform !== 'linux') return owner;
  // The same kernel identity owner is used by native admission and custody;
  // test tooling must not introduce another /proc start-token parser.
  const identity = spawnSync('/bin/bash', ['-c', '. "$1"; printf "%s\\n" "$(heavyweight_process_token "$2")"; ps -p "$2" -o pgid=', 'test-temp-owner', nativeIdentity, String(process.pid)], { encoding: 'utf8' });
  const [token, group] = String(identity.stdout ?? '').trim().split(/\s+/);
  if (identity.status !== 0 || !/^\d+$/.test(token ?? '') || !/^\d+$/.test(group ?? '') || Number(group) <= 1) return owner;
  const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  owner = `happier-test-temp-v1\n${bootId}\n${process.pid}\n${token}\n${group}\n`;
  return owner;
}

function cleanupOnExit() {
  try { cleanupFixtures([...roots]); }
  catch (error) {
    process.stderr.write(`[test-temp] cleanup failed: ${String(error)}\n`);
    process.exitCode = 1;
  }
}

export function createTestTempDirectory(prefix, parentDirectory = tmpdir()) {
  const root = mkdtempSync(join(parentDirectory, prefix));
  const fixture = {
    root,
    cleanup() {
      cleanupFixtures([fixture]);
    },
  };
  if (!roots.size) process.once('exit', cleanupOnExit);
  roots.add(fixture);
  // A root's creator has a kernel identity; detached children inherit this
  // explicit binding even after that creator and its process group are gone.
  // Line breaks cannot be represented in the binding, so do not grant orphan
  // reclamation authority for such an unusual parent/prefix.
  publishRoots();
  const marker = /[\r\n]/.test(root) ? null : ownerMarker();
  if (marker) writeFileSync(join(root, '.happier-test-temp-owner'), marker, { flag: 'wx', mode: 0o600 });
  return fixture;
}
