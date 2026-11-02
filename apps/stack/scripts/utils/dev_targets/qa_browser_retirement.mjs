import { fileURLToPath } from 'node:url';

export function requireSessionName(name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name ?? '')) throw new Error('[dev-targets] browser requires a simple lane session name');
  return name;
}

/** Retire only browsers carrying this Stack's exact existing ownership bindings. */
export async function stopQaBrowsers({ stackName, envPath }) {
  requireSessionName(stackName);
  if (!envPath) throw new Error('[dev-targets] browser retirement requires the Stack env path');
  const { killPidOwnedByStack, listPsPidsForEnvQueries, observePsEnvLine } = await import('../proc/ownership.mjs');
  const inventory = async () => (await listPsPidsForEnvQueries([{ needles: [
    `HAPPIER_STACK_STACK=${stackName}`, `HAPPIER_STACK_ENV_FILE=${envPath}`, 'HAPPIER_STACK_PROCESS_KIND=browser',
  ] }]))[0].filter(pid => pid !== process.pid);
  const pids = [];
  const stop = async (pid, worker) => {
    const result = await killPidOwnedByStack(pid, { stackName, envPath, json: true,
      signal: 'SIGTERM', ...(worker ? { graceMs: Infinity } : {}) });
    if (!result.killed) throw new Error(`[dev-targets] browser pid ${pid} cleanup unconfirmed: ${result.reason}`);
    pids.push(pid);
  };
  // The worker must close detached Chromium before any sweep can signal its
  // close subprocess. Wait for that lifecycle rather than adding a deadline.
  for (const pid of await inventory()) {
    const observed = await observePsEnvLine(pid);
    if (observed.status === 'ok' && /qa_browser\.mjs\s+--worker(?:\s|$)/.test(observed.line)) await stop(pid, true);
  }
  // Older orphaned browser/agent-browser processes can have lost their worker.
  // Re-enumerate after graceful close and use the same ownership/identity owner.
  for (const pid of await inventory()) await stop(pid, false);
  if ((await inventory()).length) throw new Error('[dev-targets] Stack browser cleanup is incomplete');
  return { stackName, pids };
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--stop-stack') {
  try {
    process.stdout.write(JSON.stringify(await stopQaBrowsers({ stackName: process.argv[3], envPath: process.argv[4] })) + '\n');
  } catch (error) {
    // An incomplete mirror cannot supply the OS helper. It is unavailable,
    // never positive cleanup confirmation; ownership/termination failures throw.
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    process.stderr.write('[dev-targets] browser cleanup helper unavailable: source module missing\n');
    process.exitCode = 127;
  }
}
