import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { writeFakeBin } from './testkit/core/fake_bin_harness.mjs';

// Execute the real payload owner; only the external SSH process is replaced.
// The transport boundary models a dead shared master and a healthy fresh link.
test('native SSH payload succeeds independently of a dead shared master', { skip: process.platform === 'win32' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-ssh-payload-' });
  const launcher = await readFile(process.env.HAPPIER_TEST_NATIVE_ADMISSION_LAUNCHER || new URL('../bin/hstack-exec', import.meta.url), 'utf8');
  const start = launcher.indexOf('run_selected_ssh() {');
  const end = launcher.indexOf('\ncustody_pipe=', start);
  assert.ok(start > 0 && end > start);
  const program = fixture.path('payload.sh');
  await writeFile(program, `${await readFile(new URL('./utils/dev_targets/native_command_policy.sh', import.meta.url), 'utf8')}\n${launcher.slice(start, end)}\nrun_selected_ssh\n`);
  const { binDir } = writeFakeBin({ root: fixture.root, name: 'ssh', content: `#!/bin/sh
case " $* " in
  *" ControlPath=none "*) ;;
  *) printf 'shared master is dead\\n' >&2; exit 255 ;;
esac
for argument in "$@"; do remote_command=$argument; done
exec /bin/sh -c "$remote_command"
` });
  for (const sshConfig of ['', fixture.path('ssh.config')]) {
    for (const tty of ['0', '1']) {
      const result = spawnSync('/bin/sh', [program], { encoding: 'utf8', env: {
        ...process.env, PATH: `${binDir}:/usr/bin:/bin`, ssh_config: sshConfig,
        ssh_target: 'fixture', remote_command: 'printf "payload-completed\\n"',
        authoritative_ssh_error_log: fixture.path('ssh-errors'), explicit_tty: tty,
        use_control_connection: '1', control_path: fixture.path('dead-master'),
      } });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'payload-completed\n');
    }
  }
});


test('admitted native payloads do not expire on the configured SSH liveness timer',
  { skip: process.platform === 'win32' }, async t => {
    const fixture = await createTempFixture(t, { prefix: 'hstack-payload-liveness-' });
    const config = fixture.path('ssh.config');
    await writeFile(config, 'Host *\n  ServerAliveInterval 15\n  ServerAliveCountMax 3\n');
    const launcherSource = await readFile(process.env.HAPPIER_TEST_NATIVE_ADMISSION_LAUNCHER || new URL('../bin/hstack-exec', import.meta.url), 'utf8');
    const start = launcherSource.indexOf('run_selected_ssh() {');
    const end = launcherSource.indexOf('\ncustody_pipe=', start);
    assert.ok(start >= 0 && end > start);
    const { binDir } = writeFakeBin({ root: fixture.root, name: 'ssh', content: '#!/bin/sh\nexec /usr/bin/ssh -G "$@"\n' });
    const result = spawnSync('/bin/sh', ['-c', (await readFile(new URL('./utils/dev_targets/native_command_policy.sh', import.meta.url), 'utf8')) + '\n' + launcherSource.slice(start, end) + '\nrun_selected_ssh'], {
      encoding: 'utf8', env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin`,
        ssh_config: config, ssh_target: 'worker.fixture', remote_command: 'unused', explicit_tty: '0',
        authoritative_ssh_error_log: '',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^serveraliveinterval 0$/m);
  });
