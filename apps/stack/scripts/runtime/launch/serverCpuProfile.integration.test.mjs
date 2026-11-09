import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolveServerRuntimeLaunchSpec } from './resolveServerRuntimeLaunchSpec.mjs';
import { buildRemoteStackCommand, resolveRemoteServerRuntimeConfig } from '../../utils/dev_targets/remote_commands.mjs';

test('server CPU profile activation is transient on remote starts and absent from daemon-only starts', () => {
  // SSH target paths are an OS boundary. Run the real remote command producer for each shell.
  for (const platform of ['posix', 'windows']) {
    const target = { name: 'profile-target', platform, ssh: 'profile-target',
      repoDir: platform === 'windows' ? 'C:/dev/Happier repo' : '/dev/Happier repo',
      cliHomeDir: platform === 'windows' ? 'C:/state/cli' : '/state/cli' };
    const options = { stackName: 'agent-qa', runtimeMode: 'source-snapshot',
      services: { server: true, daemon: true }, remoteServerPort: 43001,
      publicServerUrl: 'http://127.0.0.1:3005',
      remoteServerRuntimeConfig: resolveRemoteServerRuntimeConfig({ serverComponentName: 'happier-server-light', env: {} }) };
    const decode = command => platform === 'windows'
      ? Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le') : command;
    const profiled = decode(buildRemoteStackCommand(target, { ...options, env: { HAPPIER_STACK_SERVER_CPU_PROF: '1' } }));
    assert.match(profiled, /--server-cpu-prof/);
    assert.doesNotMatch(profiled, /HAPPIER_STACK_SERVER_CPU_PROF|NODE_OPTIONS|--cpu-prof-dir/,
      'activation must not be persisted in the remote env or use the controller log path');
    assert.doesNotMatch(decode(buildRemoteStackCommand(target, { ...options, env: {} })), /--server-cpu-prof/);
    assert.doesNotMatch(decode(buildRemoteStackCommand(target, { ...options,
      services: { daemon: true }, serverUrl: 'http://127.0.0.1:43001', env: { HAPPIER_STACK_SERVER_CPU_PROF: '1' } })), /--server-cpu-prof/);
  }
});

test('server CPU profiling applies only to the source server Node process for this start', async t => {
  const stackBaseDir = await mkdtemp(join(tmpdir(), 'hstack-server-profile-'));
  t.after(() => rm(stackBaseDir, { recursive: true, force: true }));
  const entrypoint = join(stackBaseDir, 'server.mjs');
  await writeFile(entrypoint, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  const sourceRuntimeLaunch = { entrypoint, serverDir: stackBaseDir, args: ['server-input'] };
  const env = { HAPPIER_STACK_SERVER_CPU_PROF: '1' };
  const launch = resolveServerRuntimeLaunchSpec({ sourceRuntimeLaunch, env, stackBaseDir });
  const profileDir = join(stackBaseDir, 'logs', 'server-cpu-prof');
  const child = spawnSync(launch.command, launch.args, { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
  assert.equal(child.status, 0, child.error?.message ?? child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), ['server-input']);
  const profiles = (await readdir(profileDir)).filter(name => name.endsWith('.cpuprofile'));
  assert.equal(profiles.length, 1);
  assert.ok(Array.isArray(JSON.parse(await readFile(join(profileDir, profiles[0]), 'utf8')).nodes));
});
