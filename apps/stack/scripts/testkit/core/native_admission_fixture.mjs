import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const sourceRoot = resolve(import.meta.dirname, '../../../../..');

/** Remap only the fixed OS-state filesystem boundary, never a production flag.
 * Real admission, kernel identity, locking and class policy remain unchanged.
 */
export async function installNativeAdmissionFixture({ root, admissionRoot = join(root, 'host-admission'), observedPidsPath = null }) {
  const checkout = join(root, 'native-owner');
  const bin = join(checkout, 'apps/stack/bin');
  const proc = join(checkout, 'apps/stack/scripts/utils/proc');
  const targets = join(checkout, 'apps/stack/scripts/utils/dev_targets');
  await Promise.all([mkdir(bin, { recursive: true }), mkdir(proc, { recursive: true }), mkdir(targets, { recursive: true })]);
  const launcher = join(bin, 'hstack-exec');
  await Promise.all([
    copyFile(join(sourceRoot, 'apps/stack/bin/hstack-exec'), launcher),
    copyFile(join(sourceRoot, 'apps/stack/bin/hstack-dev-target-control'), join(bin, 'hstack-dev-target-control')),
    copyFile(join(sourceRoot, 'apps/stack/scripts/utils/proc/native_process_identity.sh'), join(proc, 'native_process_identity.sh')),
    copyFile(join(sourceRoot, 'apps/stack/scripts/utils/dev_targets/native_command_policy.sh'), join(targets, 'native_command_policy.sh')),
    copyFile(join(sourceRoot, 'apps/stack/scripts/utils/dev_targets/native_sync_readiness.sh'), join(targets, 'native_sync_readiness.sh')),
    copyFile(join(sourceRoot, 'apps/stack/scripts/utils/dev_targets/remote_execution_custody.sh'), join(targets, 'remote_execution_custody.sh')),
  ]);
  const state = await readFile(join(sourceRoot, 'apps/stack/scripts/utils/proc/native_host_admission_state.sh'), 'utf8');
  const quoted = `'${admissionRoot.replaceAll("'", "'\\''")}'`;
  await writeFile(join(proc, 'native_host_admission_state.sh'), state.replace("'/tmp/happier-heavyweight-admission-v1'", quoted));
  // This fixture is an isolated physical worker, not the test runner's host.
  // Replace only OS enumeration; real RSS/ancestry for explicitly included
  // fixture processes and the production observer's domain logic stay real.
  const observer = pathToFileURL(join(sourceRoot, 'apps/stack/scripts/utils/proc/service_memory.mjs')).href;
  // Disk admission shares the same physical worker's process observation.
  // Keep the real disk owner, remapping only its adjacent modules and the
  // existing isolated OS process boundary rather than observing the runner.
  const diskObserver = await readFile(join(sourceRoot, 'apps/stack/scripts/utils/dev_targets/worker_disk_budget.mjs'), 'utf8');
  await writeFile(join(targets, 'worker_disk_budget.mjs'), diskObserver
    .replace("'./historical_temp_roots.mjs'", JSON.stringify(pathToFileURL(join(sourceRoot, 'apps/stack/scripts/utils/dev_targets/historical_temp_roots.mjs')).href))
    .replace("'../proc/package_manager_cache.mjs'", JSON.stringify(pathToFileURL(join(sourceRoot, 'apps/stack/scripts/utils/proc/package_manager_cache.mjs')).href)));
  await writeFile(join(proc, 'service_memory.mjs'), `
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readLinuxWorkerProcesses, readWorkerMemoryReservations as readReservations, renderWorkerMemoryReservationRows } from ${JSON.stringify(observer)};
const observedPidsPath = ${JSON.stringify(observedPidsPath)};
const selected = observedPidsPath ? new Set(JSON.parse(readFileSync(observedPidsPath, 'utf8'))) : new Set();
const processes = selected.size ? new Map([...readLinuxWorkerProcesses()].filter(([pid]) => selected.has(pid))) : new Map();
export function readWorkerMemoryReservations(options) {
  return readReservations({ ...options, readProcesses: () => processes });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argument = process.argv.slice(2).find(value => value.startsWith('--admission-root='));
  let previousProgress = null;
  if (process.argv.includes('--include-owner-progress')) {
    try { previousProgress = JSON.parse(readFileSync(0, 'utf8')); } catch {}
  }
  const sample = readWorkerMemoryReservations({ admissionRoot: argument?.slice('--admission-root='.length), includeAdmittedRss: process.argv.includes('--include-admitted-rss'), includeOwnerProgress: process.argv.includes('--include-owner-progress'), previousProgress });
  process.stdout.write(renderWorkerMemoryReservationRows(sample));
}
`);
  return { launcher, admissionRoot };
}
