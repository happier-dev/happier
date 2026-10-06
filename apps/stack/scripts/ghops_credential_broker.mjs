import { startGhopsCredentialBroker } from './utils/execution_host/ghops_credential_broker.mjs';

if (process.argv.includes('--status')) {
  const { inspectExecutionHostGhopsBroker } = await import('./utils/execution_host/recovery.mjs');
  process.stdout.write(`${JSON.stringify(await inspectExecutionHostGhopsBroker())}\n`);
} else {
  // launchd starts this in the user's GUI login session. Read Keychain per request;
  // credentials never enter the plist, environment, or logs.
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  let finish;
  const stopped = new Promise((resolve) => { finish = resolve; });
  for (const signal of signals) process.on(signal, finish);
  let broker;
  try {
    broker = await startGhopsCredentialBroker();
    process.stdout.write(`[execution-host] ghops credential broker ready: ${broker.socketPath}\n`);
    await stopped;
  } catch {
    process.stderr.write('[execution-host] ghops credential broker failed\n');
    process.exitCode = 1;
  } finally {
    await broker?.close();
    for (const signal of signals) process.off(signal, finish);
  }
}
