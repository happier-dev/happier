import { startLocalDaemonWithAuth } from '../daemon.mjs';

// The passthrough owns stdout. Isolate lifecycle diagnostics on its stderr while
// retaining the canonical daemon starter and its complete selected launch context.
process.stdin.setEncoding('utf8');
let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
  await startLocalDaemonWithAuth({ ...JSON.parse(input), env: process.env, isShuttingDown: () => false });
} catch (error) {
  const code = typeof error?.code === 'string' ? error.code : 'daemon_start_failed';
  console.error(`[stack] Local daemon preflight failed (${code}).`);
  process.exitCode = 1;
}
