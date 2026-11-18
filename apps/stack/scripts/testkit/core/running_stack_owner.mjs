import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { readProcessInstanceFingerprintSync } from '../../../../../packages/cli-common/processInstance.mjs';
import { spawnTestProcess } from './spawn_test_process.mjs';

/** A running Stack is a real process launched with that Stack's identity. Returns
 * its runtime state as the runtime owner records it; the process stops after the test. */
export async function startRunningStackOwner(t, stackBaseDir) {
  const stackName = basename(stackBaseDir);
  await mkdir(stackBaseDir, { recursive: true });
  await writeFile(join(stackBaseDir, 'env'), '');
  const owner = spawnTestProcess(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {
    env: { ...process.env, HAPPIER_STACK_STACK: stackName, HAPPIER_STACK_ENV_FILE: join(stackBaseDir, 'env') } });
  t.after(() => owner.kill('SIGKILL'));
  let fingerprint = null;
  for (let attempt = 0; attempt < 200 && !fingerprint; attempt++) {
    fingerprint = readProcessInstanceFingerprintSync(owner.pid);
    if (!fingerprint) await new Promise(resolve => setTimeout(resolve, 10));
  }
  return { stackName, ownerPid: owner.pid, processes: {},
    processInstances: { owner: { pid: owner.pid, fingerprint } }, startedAt: new Date().toISOString() };
}

export async function writeRunningStackState(t, stackBaseDir) {
  const state = await startRunningStackOwner(t, stackBaseDir);
  await writeFile(join(stackBaseDir, 'stack.runtime.json'), JSON.stringify(state));
  return state;
}
