// @happier-test-preparation source
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

await import('../../../bin/localSourceRuntimeBootstrap.mjs');
const { prepareStackDevTargetSourceReload } = await import('./supervisor.mjs');
const { spawnProc } = await import('../proc/proc.mjs');
const { resolveDevTargetMutagenRuntime } = await import('./mutagen_runtime.mjs');
const { renderMutagenProject, resolveMutagenSessionName } = await import('./mutagen_project.mjs');
const { createTempFixture } = await import('../../testkit/core/temp_fixture.mjs');

test('source reload supplies guest payload input to its daemon worker', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-source-guest-input-' });
  const repoDir = fileURLToPath(new URL('../../../../../', import.meta.url));
  const guestPayloadRoot = join(root, 'configured-guest-payload');
  const targets = ['server', 'daemon'].map(name => ({ name, platform: 'posix', ssh: `${name}-ssh`,
    repoDir: `/remote/${name}/repo`, cliHomeDir: join(root, name) }));
  const producerStackBaseDir = join(root, 'producer');
  const env = { ...process.env, HAPPIER_STACK_STORAGE_DIR: join(root, 'storage'), HAPPIER_STACK_DAEMON: '1',
    HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light', HAPPIER_DB_PROVIDER: 'sqlite',
    HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: guestPayloadRoot };
  const mutagen = resolveDevTargetMutagenRuntime({ stackBaseDir: producerStackBaseDir, sourceDir: repoDir, env });
  await mkdir(dirname(mutagen.projectFile), { recursive: true });
  await writeFile(mutagen.projectFile, renderMutagenProject({ sourceDir: repoDir, targets, ownerId: 'producer' }));
  const syncReady = { code: 0, out: JSON.stringify(targets.map(target => ({
    name: resolveMutagenSessionName(target.name), paused: false, status: 'watching', conflicts: [],
    excludedConflicts: 0, successfulCycles: 1,
    alpha: { connected: true, scanned: true }, beta: { connected: true, scanned: true },
  }))) };
  // SSH and Mutagen are system boundaries; preparation, environment projection,
  // worker lifecycle and the command renderer beneath them remain real.
  const prepared = await prepareStackDevTargetSourceReload({
    stackName: 'agent-qa', stackBaseDir: join(root, 'consumer'), repoDir,
    placement: { authority: { producerStackBaseDir }, config: { targets }, targetPlans: targets.map(target =>
      ({ target, services: { server: target.name === 'server', daemon: target.name === 'daemon', expo: false } })) },
    args: ['--ui=export'], env, signal: new AbortController().signal, serverRequested: true,
    sourceStartRequestId: 'guest-input',
  }, { runProcess: async () => syncReady, executorDependencies: {
    runCaptureResult: async () => ({ ok: true, out: syncReady.out, err: '', exitCode: 0 }),
    spawnProcess: input => {
      const component = input.args.includes('server-ssh') ? 'server' : 'daemon';
      assert.equal(input.args.at(-1).includes(guestPayloadRoot), component === 'daemon',
        'the daemon build must receive the configured payload input');
      return spawnProc(input.label, process.execPath, ['-e',
        'console.log("HSTACK_SOURCE_RELOAD_PREPARED"); process.stdin.on("data", () => process.exit(0));'], input.env,
      { onLine: input.onLine, stdio: ['pipe', 'pipe', 'pipe'], ownedProcessGroup: true, silent: true });
    },
  } });
  try { await prepared.activate(); } finally { await prepared.close(); }
});
