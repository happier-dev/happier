// A physical source-layout runner in the same checkout as first-party Agents.
// Tests own its process lifetime. The explicit composed mode runs the real
// in-process daemon/host test composition; ordinary users get an idle process.
if (process.argv.includes('--template-agent-composed')) {
  // A thread retains this actual source-runner PID for the SDK loop, witness,
  // and foreground claim. Ordinary fixture users remain idle OS processes.
  const { fileURLToPath } = await import('node:url');
  const { startVitest } = await import('vitest/node');
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  process.env.HAPPIER_COMPOSED_SOURCE_RUNNER = '1';
  const runner = await startVitest('test', [
    'src/daemon/externalActions/managedCatalogAccountRoundTrip.composed.test.ts',
  ], { root, config: fileURLToPath(new URL('../../../../../vitest.config.ts', import.meta.url)),
    watch: false, pool: 'threads', maxWorkers: 1, minWorkers: 1, testNamePattern: 'realRunner' });
  if (!runner) process.exitCode = 1;
  else {
    if (runner.state.getFiles().some(file => file.result?.state === 'fail')
      || runner.state.getUnhandledErrors().length) process.exitCode = 1;
    await runner.close();
  }
} else {
  setInterval(() => {}, 1000);
}
