import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';

import { inspectProvisionedPosixDevTarget, provisionPosixDevTarget, prepareDevTargetHost } from './provision.mjs';

test('QA provisioning refreshes the worker catalog before importing its installer dependencies', async t => {
  const { root } = await createTempFixture(t, { prefix: 'happier-qa-catalog-' });
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*', 'apps/*'] }));
  for (const component of ['cli', 'ui', 'server']) {
    const directory = join(root, 'apps', component);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: `fixture-${component}` }));
  }
  const directory = join(root, 'apps/stack/scripts/utils/dev_targets');
  await mkdir(directory, { recursive: true });
  await copyFile(new URL('./provision.mjs', import.meta.url), join(directory, 'provision.mjs'));
  for (const name of ['executor.mjs', 'worker_power.mjs', 'remote_commands.mjs', 'qa_browser.mjs']) {
    await symlink(fileURLToPath(new URL(name, import.meta.url)), join(directory, name));
  }
  await symlink(fileURLToPath(new URL('../proc', import.meta.url)), join(root, 'apps/stack/scripts/utils/proc'), 'dir');
  await symlink(fileURLToPath(new URL('../../provision', import.meta.url)), join(root, 'apps/stack/scripts/provision'), 'dir');
  const packageDir = join(root, 'packages/agents');
  await mkdir(join(packageDir, 'dist'), { recursive: true });
  await mkdir(join(packageDir, 'src'), { recursive: true });
  await mkdir(join(root, 'node_modules/@happier-dev'), { recursive: true });
  await symlink(packageDir, join(root, 'node_modules/@happier-dev/agents'), 'dir');
  const commonDir = join(root, 'packages/cli-common');
  await mkdir(join(commonDir, 'dist'), { recursive: true });
  await mkdir(join(commonDir, 'src'), { recursive: true });
  await writeFile(join(commonDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/cli-common', type: 'module', exports: './dist/index.js', scripts: { build: 'node build.mjs' },
  }));
  const buildScript = "import {copyFileSync,mkdirSync} from 'node:fs'; const out=process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR || 'dist'; mkdirSync(out,{recursive:true}); copyFileSync('src/index.js',out+'/index.js');\n";
  await writeFile(join(commonDir, 'build.mjs'), buildScript);
  await writeFile(join(commonDir, 'src/index.js'), 'export {};\n');
  // Real package-build/import boundaries: the deliberately throwing catalog
  // distinguishes which generation was loaded without installing vendor tools.
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/agents', type: 'module', exports: './dist/index.js', scripts: { build: 'node build.mjs' },
  }));
  await writeFile(join(packageDir, 'build.mjs'), buildScript);
  await writeFile(join(packageDir, 'dist/index.js'), "throw new Error('catalog-budget=402653184');\n");
  await writeFile(join(packageDir, 'src/index.js'), "throw new Error('catalog-budget=536870912');\n");
  const moduleUrl = pathToFileURL(join(directory, 'provision.mjs')).href;
  await assert.rejects(promisify(execFile)(process.execPath, ['--input-type=module', '-e',
    `const {provisionQaHostDependencies}=await import(${JSON.stringify(moduleUrl)}); await provisionQaHostDependencies();`],
  { cwd: root, env: { ...process.env, HAPPIER_HOME_DIR: join(root, 'qa-home') } }), error => {
    assert.match(error.stderr, /catalog-budget=536870912/);
    assert.doesNotMatch(error.stderr, /catalog-budget=402653184/);
    return true;
  });
});

for (const name of ['mac', `worker-${'a'.repeat(40)}-tail-host`]) {
test(`POSIX provisioning preserves ${name} in its dedicated identity and remote paths`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dev-target-provision-'));
  const calls = [];
  let keyAuthorized = false;
  let configuredHostKeyPinned = false;
  const configuredSshModes = [];
  try {
    const target = await provisionPosixDevTarget(
      {
        name,
        host: '100.98.30.76',
        user: 'leeroy',
        stackBaseDir: root,
        env: { PATH: '/test/bin' },
      },
      {
        runInteractive: async ({ command, args }) => {
          calls.push([command, ...args]);
          if (command === 'ssh-keygen') {
            const keyPath = args[args.indexOf('-f') + 1];
            await writeFile(keyPath, 'private-test-key');
            await writeFile(`${keyPath}.pub`, 'ssh-ed25519 AAAATEST happier-dev-target');
            return;
          }
          if (command === 'ssh-copy-id') {
            keyAuthorized = true;
            return;
          }
          throw new Error(`unexpected interactive command: ${command}`);
        },
        runCaptureResult: async ({ command, args }) => {
          calls.push([command, ...args]);
          const configFlagIndex = args.indexOf('-F');
          if (configFlagIndex >= 0) {
            const sshConfig = await readFile(args[configFlagIndex + 1], 'utf8');
            const strictMode = sshConfig.match(/StrictHostKeyChecking (\S+)/)?.[1];
            configuredSshModes.push(strictMode);
            if (strictMode === 'accept-new') configuredHostKeyPinned = true;
            if (!configuredHostKeyPinned) {
              return {
                ok: false,
                exitCode: 255,
                out: '',
                err: 'No ED25519 host key is known for 100.98.30.76 and you have requested strict checking.',
              };
            }
          }
          if (args.at(-1) === 'true') {
            // A pre-existing authenticated master cannot prove the newly
            // configured dedicated key. Only an independent auth handshake can.
            return keyAuthorized || !args.includes('ControlPath=none')
              ? { ok: true, exitCode: 0, out: '', err: '' }
              : { ok: false, exitCode: 255, out: '', err: 'permission denied' };
          }
          return {
            ok: true,
            exitCode: 0,
            out: [
              '__HAPPIER_UNAME__=Darwin',
              '__HAPPIER_HOME__=/Users/leeroy',
              '__HAPPIER_PATH__=/Users/leeroy/.nvm/versions/node/v22/bin:/opt/homebrew/bin:/usr/bin:/bin',
              '__HAPPIER_NODE__=/Users/leeroy/.nvm/versions/node/v22/bin/node',
              '__HAPPIER_COREPACK__=/Users/leeroy/.nvm/versions/node/v22/bin/corepack',
            ].join('\n'),
            err: '',
          };
        },
      },
    );

    assert.equal(target.platform, 'posix');
    assert.equal(target.ssh, `happier-dev-target-${name}`);
    assert.equal(target.repoDir, '/Users/leeroy/happier-dev');
    assert.equal(target.cliHomeDir, `/Users/leeroy/.happier/dev-targets/${name}`);
    assert.deepEqual(target.remotePath, [
      '/Users/leeroy/.nvm/versions/node/v22/bin',
      '/opt/homebrew/bin',
      '/usr/bin',
      '/bin',
    ]);
    assert.equal(calls.filter((call) => call[0] === 'ssh-keygen').length, 1);
    assert.equal(calls.filter((call) => call[0] === 'ssh-copy-id').length, 1);
    assert.deepEqual(configuredSshModes, ['accept-new', 'accept-new', 'accept-new', 'yes']);
    const copyIdCall = calls.find((call) => call[0] === 'ssh-copy-id');
    assert.deepEqual(copyIdCall?.slice(1, 9), [
      '-F', target.sshConfigFile,
      '-o', 'BatchMode=no',
      '-o', 'IdentitiesOnly=yes',
      '-o', 'IdentityAgent=none',
    ]);
    assert.equal(copyIdCall?.at(-1), target.ssh);
    assert.equal(existsSync(target.sshConfigFile), true);
    const sshConfig = await readFile(target.sshConfigFile, 'utf8');
    assert.match(sshConfig, new RegExp(`Host happier-dev-target-${name}`));
    assert.match(sshConfig, /HostName 100\.98\.30\.76/);
    assert.match(sshConfig, /User leeroy/);
    assert.match(sshConfig, /IdentitiesOnly yes/);
    assert.match(sshConfig, /BatchMode yes/);
    assert.match(sshConfig, /StrictHostKeyChecking yes/);
    const resolved = await promisify(execFile)('ssh', ['-G', '-F', target.sshConfigFile, target.ssh]);
    assert.match(resolved.stdout, /^controlmaster auto$/m);
    assert.match(resolved.stdout, /^controlpersist 600$/m);
    assert.match(resolved.stdout, /^controlpath .*happier-dev-target-/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
}

test('enrollment refuses a password-authenticated master when its dedicated key was not installed', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-enrollment-master-' });
  await assert.rejects(provisionPosixDevTarget({ name: 'worker', host: '100.84.248.35', user: 'root', stackBaseDir: root }, {
    runInteractive: async ({ command, args }) => {
      if (command === 'ssh-keygen') {
        const path = args[args.indexOf('-f') + 1];
        await writeFile(path, 'fixture-key');
        await writeFile(`${path}.pub`, 'ssh-ed25519 AAAATEST worker');
      }
      // Genuine external installer failure: it returned, but key auth is not
      // usable. A live password master would still satisfy a reused probe.
    },
    runCaptureResult: async ({ args }) => ({
      ok: !args.includes('ControlPath=none'),
      // Keep discovery valid so a reused master cannot be rejected later for
      // an unrelated missing-toolchain fixture error instead of key auth.
      out: '__HAPPIER_UNAME__=Linux\n__HAPPIER_HOME__=/root\n__HAPPIER_PATH__=/usr/bin:/bin\n__HAPPIER_NODE__=/usr/bin/node\n__HAPPIER_NODE_VERSION__=v24.0.0\n__HAPPIER_COREPACK__=/usr/bin/corepack\n',
      err: 'dedicated key denied',
    }),
  }), /could not verify provisioned SSH key/);
});

async function onboardingFixture(t) {
  const { root } = await createTempFixture(t, { prefix: 'hstack-onboarding-' });
  const config = join(root, 'ssh.config');
  await writeFile(config, 'Host worker\n  HostName 100.84.248.35\n  User root\n  StrictHostKeyChecking yes\n');
  await writeFile(join(root, 'id_ed25519.pub'), 'ssh-ed25519 AAAATEST worker\n');
  const target = { name: 'worker', platform: 'posix', ssh: 'worker', sshConfigFile: config,
    repoDir: '/root/happier-dev', cliHomeDir: '/root/.happier/dev-targets/worker', remotePath: [] };
  const scripts = [];
  const probes = [];
  const boundary = {
    runInteractive: async ({ args }) => { scripts.push(args.at(-1)); },
    runCaptureResult: async ({ args }) => {
      probes.push(args);
      return { ok: true, out: '__HAPPIER_UNAME__=Linux\n__HAPPIER_HOME__=/home/happier\n__HAPPIER_PATH__=/usr/bin:/bin\n__HAPPIER_NODE__=/usr/bin/node\n__HAPPIER_NODE_VERSION__=v24.0.0\n__HAPPIER_COREPACK__=/usr/bin/corepack\n__HAPPIER_TAILNET__=100.84.248.35\n', err: '' };
    },
  };
  return { root, config, target, scripts, probes, boundary };
}

for (const [flag, options, expected] of [
  ['toolchain', { toolchain: true }, /--profile=toolchain/],
  ['create-user', { createUser: 'happier' }, /getent passwd.*useradd[\s\S]*authorized_keys[\s\S]*NOPASSWD: ALL/s],
  ['tailscale', { tailscale: true }, /pkgs\.tailscale\.com[\s\S]*BackendState[\s\S]*tailscale up/],
  ['auto-updates', { autoUpdates: true }, /dpkg-query[\s\S]*unattended-upgrades[\s\S]*Automatic-Reboot.*false/],
]) test(`host onboarding ${flag} is explicit and checks existing host state`, async t => {
  const fixture = await onboardingFixture(t);
  await prepareDevTargetHost({ target: fixture.target, ...options }, fixture.boundary);
  assert.match(fixture.scripts.join('\n'), expected);
  for (const script of fixture.scripts) await promisify(execFile)('bash', ['-n', '-c', script]);
  if (options.createUser) {
    const config = await readFile(fixture.config, 'utf8');
    assert.match(config, /User happier/);
    assert.ok(fixture.probes.some(args => args.includes('ControlPath=none')));
  }
});

test('host lockdown refuses a password master before any host mutation', async t => {
  const fixture = await onboardingFixture(t);
  await assert.rejects(prepareDevTargetHost({ target: fixture.target, lockdown: 'tailscale-only' }, {
    ...fixture.boundary,
    runCaptureResult: async ({ args }) => ({ ok: !args.includes('ControlPath=none'), out: '', err: 'key denied' }),
  }), /fresh.*key|key.*authentication/i);
  assert.equal(fixture.scripts.length, 0);
});

test('create-user grants effective sudo for dotted account names before switching SSH', async t => {
  const fixture = await onboardingFixture(t);
  const requests = [];
  const account = 'leeroy.guest';
  await prepareDevTargetHost({ target: fixture.target, createUser: account }, {
    ...fixture.boundary,
    runCaptureResult: async request => { requests.push(request); return fixture.boundary.runCaptureResult(request); },
  });
  assert.match(fixture.scripts.join('\n'), new RegExp(`/etc/sudoers.d/happier-user-${Buffer.from(account).toString('hex')}`));
  assert.ok(requests.some(request => request.args.at(-1) === 'sudo -n true'), 'prove the installed includedir policy through the new account');
});

test('create-user leaves the old SSH configuration usable when the effective sudo grant is rejected', async t => {
  const fixture = await onboardingFixture(t);
  const before = await readFile(fixture.config, 'utf8');
  await assert.rejects(prepareDevTargetHost({ target: fixture.target, createUser: 'leeroy.guest' }, {
    ...fixture.boundary,
    runCaptureResult: request => request.args.at(-1) === 'sudo -n true'
      ? Promise.resolve({ ok: false, out: '', err: 'policy was skipped' }) : fixture.boundary.runCaptureResult(request),
  }), /fresh.*key|sudo/i);
  assert.equal(await readFile(fixture.config, 'utf8'), before);
});

for (const mode of ['tailscale-only', 'ssh-public']) test(`host lockdown ${mode} arms rollback before changes and commits after a fresh probe`, async t => {
  const fixture = await onboardingFixture(t);
  const events = [];
  await prepareDevTargetHost({ target: fixture.target, lockdown: mode, fleetSsh: true }, {
    ...fixture.boundary,
    runInteractive: async request => { events.push(['script', request.args.at(-1)]); await fixture.boundary.runInteractive(request); },
    runCaptureResult: async request => { events.push(['probe', request.args]); return fixture.boundary.runCaptureResult(request); },
  });
  const scripts = fixture.scripts.join('\n');
  assert.match(scripts, /systemd-run.*--on-active=5min/);
  assert.match(scripts, /40-happier-no-password\.conf/);
  assert.match(scripts, /PasswordAuthentication no/);
  assert.match(scripts, /ufw default deny incoming/);
  assert.match(scripts, /ufw allow in on tailscale0/);
  assert.match(scripts, /SSH_CONNECTION/);
  const change = events.findIndex(([kind, value]) => kind === 'script' && value.includes('systemd-run'));
  const commit = events.findIndex(([kind, value]) => kind === 'script' && value.includes('systemctl stop'));
  assert.ok(change >= 0 && commit > change);
  assert.ok(events.slice(change + 1, commit).some(([kind, args]) => kind === 'probe' && args.includes('ControlPath=none')));
  for (const script of fixture.scripts) await promisify(execFile)('bash', ['-n', '-c', script]);
});

test('host onboarding rejects invalid options before contacting the host', async t => {
  const fixture = await onboardingFixture(t);
  for (const options of [{ createUser: 'bad;user' }, { home: '/home/x' }, { lockdown: 'public' }, { tailscaleAuthkeyStdin: true }]) {
    await assert.rejects(prepareDevTargetHost({ target: fixture.target, ...options }, fixture.boundary));
  }
  assert.equal(fixture.scripts.length, 0);
});

test('the complete onboarding recipe remains executable as one SSH command per phase', async t => {
  const fixture = await onboardingFixture(t);
  await prepareDevTargetHost({ target: fixture.target, createUser: 'happier', toolchain: true,
    tailscale: true, lockdown: 'tailscale-only', passwordlessSudo: true, noSleep: true,
    diskTmp: true, inotify: true, fleetSsh: true, autoUpdates: true }, fixture.boundary);
  for (const script of fixture.scripts) await promisify(execFile)('bash', ['-n', '-c', script]);
});

async function lockdownShellFixture(t, mode = 'tailscale-only') {
  const fixture = await onboardingFixture(t);
  const bin = join(fixture.root, 'bin');
  const etc = join(fixture.root, 'etc');
  const state = join(fixture.root, 'state');
  const log = join(fixture.root, 'operations');
  await mkdir(bin);
  await mkdir(state);
  for (const directory of ['ssh/sshd_config.d', 'ufw', 'default']) await mkdir(join(etc, directory), { recursive: true });
  await writeFile(join(etc, 'ssh/sshd_config.d/40-happier-no-password.conf'), 'PasswordAuthentication yes\n');
  await writeFile(join(etc, 'default/ufw'), 'no\n');
  await writeFile(join(etc, 'ufw/rules'), '80/tcp ALLOW IN Anywhere\n');
  for (const [command, source] of Object.entries({
    id: 'case "$1" in -u) echo 0 ;; -un) echo root ;; esac',
    uname: 'echo Linux',
    tailscale: 'case "$1" in status) printf \'{"BackendState":"%s"}\\n\' "${TS_STATE:-Running}" ;; ip) echo 100.84.248.35 ;; esac',
    sshd: 'case "$1" in -T) printf "passwordauthentication no\\nkbdinteractiveauthentication no\\npermitrootlogin without-password\\n" ;; esac',
    'systemd-run': 'printf "arm:%s\\n" "$*" >> "$LOCKDOWN_LOG"; for arg in "$@"; do last="$arg"; done; printf "%s\\n" "$last" > "$TIMER_SCRIPT"',
    systemctl: 'printf "systemctl:%s\\n" "$*" >> "$LOCKDOWN_LOG"; [ "$1" != show ] || echo 0',
    ufw: `printf 'ufw:%s\\n' "$*" >> "$LOCKDOWN_LOG"
case "$*" in
  'status'|'status verbose')
    if [ "$(cat "$UFW_DEFAULT")" = yes ]; then
      printf 'Status: active\\nDefault: deny (incoming), allow (outgoing), disabled (routed)\\n'
      cat "$UFW_RULES"
    else echo 'Status: inactive'; fi ;;
  '--force reset') : > "$UFW_RULES"; echo no > "$UFW_DEFAULT" ;;
  'allow in on tailscale0') echo 'Anywhere on tailscale0 ALLOW IN Anywhere' >> "$UFW_RULES" ;;
  'allow 22/tcp') echo '22/tcp ALLOW IN Anywhere' >> "$UFW_RULES" ;;
  '--force enable') echo yes > "$UFW_DEFAULT" ;;
  '--force disable') echo no > "$UFW_DEFAULT" ;;
  'default deny incoming'|'default allow outgoing') ;;
  *) exit 9 ;;
esac`,
  })) await writeFile(join(bin, command), '#!/bin/sh\n' + source + '\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, SSH_CONNECTION: '100.100.1.1 4567 100.84.248.35 22',
    LOCKDOWN_LOG: log, TIMER_SCRIPT: join(fixture.root, 'timer-script'), UFW_DEFAULT: join(etc, 'default/ufw'), UFW_RULES: join(etc, 'ufw/rules') };
  const remap = command => command.replaceAll('/etc/ssh', `${etc}/ssh`).replaceAll('/etc/ufw', `${etc}/ufw`)
    .replaceAll('/etc/default/ufw', `${etc}/default/ufw`).replaceAll('/var/lib/', `${state}/`);
  const runInteractive = async ({ args, env }) => await promisify(execFile)('/bin/bash', ['-c', remap(args.at(-1))], { env });
  return { ...fixture, env, log, etc, mode, runInteractive, remap };
}

for (const mode of ['tailscale-only', 'ssh-public']) test(`lockdown ${mode} applies exact policy, repeats without changes, and restores on a failed post-login`, async t => {
  const fixture = await lockdownShellFixture(t, mode);
  const boundary = { ...fixture.boundary, runInteractive: fixture.runInteractive };
  await prepareDevTargetHost({ target: fixture.target, lockdown: mode, env: fixture.env }, boundary);
  const first = await readFile(fixture.log, 'utf8');
  assert.ok(first.indexOf('arm:') < first.indexOf('ufw:--force reset'));
  assert.match(await readFile(join(fixture.etc, 'ssh/sshd_config.d/40-happier-no-password.conf'), 'utf8'), /PasswordAuthentication no/);
  const rules = await readFile(fixture.env.UFW_RULES, 'utf8');
  assert.doesNotMatch(rules, /80\/tcp/);
  assert.equal(rules.includes('22/tcp'), mode === 'ssh-public');
  await prepareDevTargetHost({ target: fixture.target, lockdown: mode, env: fixture.env }, boundary);
  const repeated = (await readFile(fixture.log, 'utf8')).slice(first.length);
  assert.doesNotMatch(repeated, /ufw:--force reset|systemctl:reload ssh/);
  await writeFile(join(fixture.etc, 'ssh/sshd_config.d/40-happier-no-password.conf'), 'PasswordAuthentication yes\n');
  await writeFile(fixture.env.UFW_DEFAULT, 'no\n');
  await writeFile(fixture.env.UFW_RULES, '80/tcp ALLOW IN Anywhere\n');
  let probes = 0;
  await assert.rejects(prepareDevTargetHost({ target: fixture.target, lockdown: mode, env: fixture.env }, {
    ...boundary,
    runCaptureResult: async () => ({ ok: ++probes < 3, out: '', err: '' }),
  }), /fresh dedicated-key/);
  assert.equal(await readFile(fixture.env.UFW_DEFAULT, 'utf8'), 'no\n');
  assert.equal(await readFile(fixture.env.UFW_RULES, 'utf8'), '80/tcp ALLOW IN Anywhere\n');
  assert.equal(await readFile(join(fixture.etc, 'ssh/sshd_config.d/40-happier-no-password.conf'), 'utf8'), 'PasswordAuthentication yes\n');
});

test('automatic rollback restores access when the controller disconnects after the policy change', async t => {
  const fixture = await lockdownShellFixture(t);
  let disconnected = false;
  await assert.rejects(prepareDevTargetHost({ target: fixture.target, lockdown: fixture.mode, env: fixture.env }, {
    ...fixture.boundary,
    runInteractive: async request => {
      if (disconnected) throw new Error('connection lost');
      await fixture.runInteractive(request);
      disconnected = true;
      throw new Error('connection lost');
    },
  }), /connection lost/);
  assert.equal(await readFile(fixture.env.UFW_DEFAULT, 'utf8'), 'yes\n');
  const rollback = (await readFile(fixture.env.TIMER_SCRIPT, 'utf8')).trim();
  await promisify(execFile)('/bin/bash', [rollback], { env: fixture.env });
  assert.equal(await readFile(fixture.env.UFW_DEFAULT, 'utf8'), 'no\n');
  assert.equal(await readFile(join(fixture.etc, 'ssh/sshd_config.d/40-happier-no-password.conf'), 'utf8'), 'PasswordAuthentication yes\n');
});

test('tailscale-only refuses an offline tailnet or a public-address connection before arming or changing policy', async t => {
  const fixture = await lockdownShellFixture(t);
  for (const extra of [{ TS_STATE: 'Stopped' }, { SSH_CONNECTION: '100.100.1.1 4567 203.0.113.10 22' }]) {
    await assert.rejects(prepareDevTargetHost({ target: fixture.target, lockdown: fixture.mode, env: { ...fixture.env, ...extra } }, {
      ...fixture.boundary, runInteractive: fixture.runInteractive,
    }));
  }
  assert.equal(existsSync(fixture.log), false);
  assert.equal(await readFile(fixture.env.UFW_DEFAULT, 'utf8'), 'no\n');
});

for (const account of ['root', 'happier']) test(`lockdown rejects a real sshd Match override for ${account} and restores policy`, async t => {
  const fixture = await lockdownShellFixture(t);
  const hostKey = join(fixture.root, 'host-key');
  await promisify(execFile)('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey]);
  const realSshd = (await promisify(execFile)('/bin/sh', ['-c', 'command -v sshd || printf /usr/sbin/sshd'])).stdout.trim();
  const config = join(fixture.root, 'sshd_config');
  await writeFile(config, `Include ${fixture.etc}/ssh/sshd_config.d/*.conf\nMatch User ${account}\n  PasswordAuthentication yes\n`);
  // Run the installed OpenSSH policy engine, without starting a daemon.
  await writeFile(join(fixture.root, 'bin/sshd'), `#!/bin/sh\nexec '${realSshd}' -h '${hostKey}' -f '${config}' "$@"\n`, { mode: 0o755 });
  await writeFile(join(fixture.root, 'bin/id'), '#!/bin/sh\ncase "$1" in -u) echo 0 ;; -un) echo happier ;; esac\n', { mode: 0o755 });
  await assert.rejects(prepareDevTargetHost({ target: fixture.target, lockdown: fixture.mode, env: fixture.env }, {
    ...fixture.boundary, runInteractive: fixture.runInteractive,
  }), /overridden|Command failed/);
  assert.equal(await readFile(fixture.env.UFW_DEFAULT, 'utf8'), 'no\n');
  assert.equal(await readFile(join(fixture.etc, 'ssh/sshd_config.d/40-happier-no-password.conf'), 'utf8'), 'PasswordAuthentication yes\n');
});

for (const version of ['9.6p1 Ubuntu-3ubuntu13', '9.7p1', '9.8p1', '10.0p1']) {
test(`fleet SSH preparation on OpenSSH ${version} validates before reload, converges, and restores rejected configuration`, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-fleet-ssh-' });
  const bin = join(root, 'bin');
  const sshDirectory = join(root, 'ssh');
  const dropIn = join(sshDirectory, 'sshd_config.d/50-happier-fleet.conf');
  const log = join(root, 'operations');
  await mkdir(bin);
  await mkdir(join(sshDirectory, 'sshd_config.d'), { recursive: true });
  await writeFile(join(sshDirectory, 'sshd_config'), 'Include sshd_config.d/*.conf\n');
  for (const [name, script] of Object.entries({
    uname: 'echo Linux', id: 'case "$1" in -u) echo 0 ;; -un) echo worker ;; esac',
    sshd: `printf 'sshd:%s\\n' "$*" >> "$FLEET_LOG"
case "$1" in
  -V) echo "OpenSSH_$SSHD_VERSION, OpenSSL 3.0.13" >&2; exit 0 ;;
  -T)
    printf 'maxsessions %s\\nmaxstartups %s\\n' "\${EFFECTIVE_SESSIONS:-64}" "\${EFFECTIVE_STARTUPS:-100:30:200}"
    [ "$SUPPORTS_PENALTIES" = 0 ] || printf 'persourcepenaltyexemptlist %s\\n' "\${EFFECTIVE_PENALTIES:-100.64.0.0/10}"
    ;;
  -t)
    [ "\${REJECT_FLEET:-0}" = 0 ] || exit 1
    if [ "$#" = 1 ]; then
      [ "\${REJECT_INSTALLED:-0}" = 0 ] || exit 1
      if [ "$SUPPORTS_PENALTIES" = 0 ] && grep -q PerSourcePenaltyExemptList "$FLEET_DROP_IN"; then exit 1; fi
    elif [ "$SUPPORTS_PENALTIES" = 0 ]; then
      case "$*" in *PerSourcePenaltyExemptList*) exit 1 ;; esac
    fi
    ;;
  *) exit 9 ;;
esac`,
    systemctl: 'printf "systemctl:%s\\n" "$*" >> "$FLEET_LOG"; if [ "$1" = show ]; then echo 0; elif [ "$1" = reload ]; then [ "${REJECT_RELOAD:-0}" = 0 ]; fi',
    'systemd-run': 'printf "systemd-run:%s\\n" "$*" >> "$FLEET_LOG"',
  })) await writeFile(join(bin, name), '#!/bin/sh\n' + script + '\n', { mode: 0o755 });
  const target = { name: 'linux', platform: 'posix', ssh: 'linux', remotePath: [] };
  const supportsPenalties = version.startsWith('9.8') || version.startsWith('10.');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FLEET_LOG: log,
    FLEET_DROP_IN: dropIn, SSHD_VERSION: version, SUPPORTS_PENALTIES: supportsPenalties ? '1' : '0' };
  const invoke = extra => prepareDevTargetHost({ target, fleetSsh: true, env: { ...env, ...extra } }, {
    // Remap the fixed OS configuration filesystem only; execute the real host
    // preparation script with sshd/systemd as the external process boundaries.
    runInteractive: async ({ args, env }) => {
      await promisify(execFile)('/bin/bash', ['-c', args.at(-1).replaceAll('/etc/ssh/', `${sshDirectory}/`).replaceAll('/var/lib/', `${root}/`)], { env });
    },
    runCaptureResult: async () => ({ ok: true, out: '', err: '' }),
  });
  await invoke();
  assert.equal(await readFile(dropIn, 'utf8'), 'MaxSessions 64\nMaxStartups 100:30:200\n' +
    (supportsPenalties ? 'PerSourcePenaltyExemptList 100.64.0.0/10\n' : ''));
  const first = await readFile(log, 'utf8');
  assert.ok(first.indexOf('sshd:-t') < first.indexOf('systemctl:reload ssh'));
  assert.match(first, /sshd:-t\nsshd:-T\nsystemctl:reload ssh/, 'the installed configuration must validate before reload');
  await invoke();
  assert.equal((await readFile(log, 'utf8')).match(/systemctl:reload ssh/g).length, 1);
  await writeFile(dropIn, 'MaxStartups 10:30:100\n');
  await assert.rejects(invoke({ REJECT_FLEET: '1' }));
  assert.equal(await readFile(dropIn, 'utf8'), 'MaxStartups 10:30:100\n');
  await assert.rejects(invoke({ REJECT_INSTALLED: '1' }));
  assert.equal(await readFile(dropIn, 'utf8'), 'MaxStartups 10:30:100\n');
  await assert.rejects(invoke({ EFFECTIVE_STARTUPS: '10:30:100' }));
  assert.equal(await readFile(dropIn, 'utf8'), 'MaxStartups 10:30:100\n');
  await assert.rejects(invoke({ EFFECTIVE_SESSIONS: '10' }));
  assert.equal(await readFile(dropIn, 'utf8'), 'MaxStartups 10:30:100\n');
  if (supportsPenalties) {
    await assert.rejects(invoke({ EFFECTIVE_PENALTIES: 'none' }));
    assert.equal(await readFile(dropIn, 'utf8'), 'MaxStartups 10:30:100\n');
  }
  await assert.rejects(invoke({ REJECT_RELOAD: '1' }));
  assert.equal(await readFile(dropIn, 'utf8'), 'MaxStartups 10:30:100\n');
  await rm(dropIn);
  await assert.rejects(invoke({ REJECT_INSTALLED: '1' }));
  assert.equal(existsSync(dropIn), false, 'a rejected first installation must remove its drop-in');
});
}

test('POSIX provisioning reuses an authorized dedicated key and honors directory overrides', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dev-target-provision-'));
  const keyDir = join(root, 'dev-target-ssh', 'mac');
  const calls = [];
  try {
    const target = await provisionPosixDevTarget(
      {
        name: 'mac',
        host: 'mac.example.test',
        user: 'dev',
        stackBaseDir: root,
        repoDir: '/Volumes/work/happier',
        cliHomeDir: '/Volumes/state/happier',
        env: {},
      },
      {
        pathExists: (path) => path === join(keyDir, 'id_ed25519') || path === join(keyDir, 'id_ed25519.pub'),
        runInteractive: async ({ command }) => {
          calls.push(command);
          throw new Error('existing authorized keys require no interactive command');
        },
        runCaptureResult: async ({ args }) => {
          if (args.at(-1) === 'true') return { ok: true, exitCode: 0, out: '', err: '' };
          return {
            ok: true,
            exitCode: 0,
            out: '__HAPPIER_UNAME__=Linux\n__HAPPIER_HOME__=/home/dev\n__HAPPIER_PATH__=/opt/node/bin:/usr/bin\n__HAPPIER_NODE__=/opt/node/bin/node\n__HAPPIER_COREPACK__=/opt/node/bin/corepack\n',
            err: '',
          };
        },
      },
    );

    assert.equal(target.repoDir, '/Volumes/work/happier');
    assert.equal(target.cliHomeDir, '/Volumes/state/happier');
    assert.deepEqual(calls, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POSIX provisioning fails before registration when Node and Corepack are not discoverable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dev-target-provision-'));
  try {
    await assert.rejects(
      () => provisionPosixDevTarget(
        { name: 'mac', host: 'host.test', user: 'dev', stackBaseDir: root, env: {} },
        {
          pathExists: () => true,
          runInteractive: async () => {},
          runCaptureResult: async ({ args }) => (
            args.at(-1) === 'true'
              ? { ok: true, exitCode: 0, out: '', err: '' }
              : {
                  ok: true,
                  exitCode: 0,
                  out: '__HAPPIER_UNAME__=Darwin\n__HAPPIER_HOME__=/Users/dev\n__HAPPIER_PATH__=/usr/bin:/bin\n__HAPPIER_NODE__=\n__HAPPIER_COREPACK__=\n',
                  err: '',
                }
          ),
        },
      ),
      /Node\.js and Corepack/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POSIX outer-host enrollment can omit the guest toolchain requirement while retaining controller-key metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dev-target-outer-host-'));
  const keyDir = join(root, 'dev-target-ssh', 'worker-host');
  try {
    const target = await provisionPosixDevTarget(
      {
        name: 'worker-host',
        host: 'mac.example.test',
        user: 'dev',
        stackBaseDir: root,
        requireToolchain: false,
        env: {},
      },
      {
        pathExists: (path) => path === join(keyDir, 'id_ed25519') || path === join(keyDir, 'id_ed25519.pub'),
        runInteractive: async () => {},
        runCaptureResult: async ({ args }) => (
          args.at(-1) === 'true'
            ? { ok: true, exitCode: 0, out: '', err: '' }
            : {
                ok: true,
                exitCode: 0,
                out: '__HAPPIER_UNAME__=Darwin\n__HAPPIER_HOME__=/Users/dev\n__HAPPIER_PATH__=/usr/bin:/bin\n__HAPPIER_NODE__=\n__HAPPIER_COREPACK__=\n',
                err: '',
              }
        ),
      },
    );

    assert.equal(target.remoteHome, '/Users/dev');
    assert.deepEqual(target.controllerKey, {
      privateKeyPath: join(keyDir, 'id_ed25519'),
      publicKeyPath: join(keyDir, 'id_ed25519.pub'),
    });
    assert.deepEqual(target.remotePath, ['/usr/bin', '/bin']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('existing POSIX target inspection verifies its strict controller key without enrollment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dev-target-existing-'));
  const keyDir = join(root, 'dev-target-ssh', 'mac');
  const calls = [];
  try {
    const target = await inspectProvisionedPosixDevTarget(
      {
        target: {
          name: 'mac',
          platform: 'posix',
          ssh: 'happier-dev-target-mac',
          sshConfigFile: join(keyDir, 'ssh.config'),
          repoDir: '/Users/dev/happier-dev',
          cliHomeDir: '/Users/dev/.happier/dev-targets/mac',
        },
        env: {},
      },
      {
        pathExists: (path) => path === join(keyDir, 'id_ed25519') || path === join(keyDir, 'id_ed25519.pub'),
        runCaptureResult: async ({ command, args }) => {
          calls.push([command, ...args]);
          if (args.at(-1) === 'true') return args.includes('ControlPath=none')
            ? { ok: true, exitCode: 0, out: '', err: '' }
            : { ok: false, exitCode: 255, out: '', err: 'cannot verify the configured key through an existing master' };
          return {
            ok: true,
            exitCode: 0,
            out: '__HAPPIER_UNAME__=Darwin\n__HAPPIER_HOME__=/Users/dev\n__HAPPIER_PATH__=/opt/homebrew/bin:/usr/bin:/bin\n__HAPPIER_NODE__=\n__HAPPIER_COREPACK__=\n',
            err: '',
          };
        },
      },
    );

    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.includes(join(keyDir, 'ssh.config'))));
    assert.equal(target.remoteHome, '/Users/dev');
    assert.deepEqual(target.remotePath, ['/opt/homebrew/bin', '/usr/bin', '/bin']);
    assert.deepEqual(target.controllerKey, {
      privateKeyPath: join(keyDir, 'id_ed25519'),
      publicKeyPath: join(keyDir, 'id_ed25519.pub'),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POSIX provisioning discovers Corepack beside the resolved Node runtime when a version-manager shim omits it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dev-target-provision-'));
  try {
    let discoveryCommand = '';
    const target = await provisionPosixDevTarget(
      { name: 'mac', host: 'host.test', user: 'dev', stackBaseDir: root, env: {} },
      {
        pathExists: () => true,
        runInteractive: async () => {},
        runCaptureResult: async ({ args }) => {
          if (args.at(-1) === 'true') return { ok: true, exitCode: 0, out: '', err: '' };
          discoveryCommand = String(args.at(-1));
          return {
            ok: true,
            exitCode: 0,
            out: [
              '__HAPPIER_UNAME__=Darwin',
              '__HAPPIER_HOME__=/Users/dev',
              '__HAPPIER_PATH__=/Users/dev/.volta/bin:/usr/bin:/bin',
              '__HAPPIER_NODE__=/Users/dev/.volta/bin/node',
              '__HAPPIER_NODE_VERSION__=v22.22.1',
              '__HAPPIER_COREPACK__=/Users/dev/.volta/tools/image/node/22.22.1/bin/corepack',
            ].join('\n'),
            err: '',
          };
        },
      },
    );

    assert.match(discoveryCommand, /process\.execPath/);
    assert.deepEqual(target.remotePath.slice(0, 2), [
      '/Users/dev/.volta/bin',
      '/Users/dev/.volta/tools/image/node/22.22.1/bin',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POSIX provisioning rejects a discovered Node runtime older than the repository major', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dev-target-provision-'));
  try {
    await assert.rejects(
      () => provisionPosixDevTarget(
        { name: 'mac', host: 'host.test', user: 'dev', stackBaseDir: root, env: {} },
        {
          pathExists: () => true,
          runInteractive: async () => {},
          runCaptureResult: async ({ args }) => (
            args.at(-1) === 'true'
              ? { ok: true, exitCode: 0, out: '', err: '' }
              : {
                  ok: true,
                  exitCode: 0,
                  out: [
                    '__HAPPIER_UNAME__=Darwin',
                    '__HAPPIER_HOME__=/Users/dev',
                    '__HAPPIER_PATH__=/opt/node/bin:/usr/bin:/bin',
                    '__HAPPIER_NODE__=/opt/node/bin/node',
                    '__HAPPIER_NODE_VERSION__=v18.15.0',
                    '__HAPPIER_COREPACK__=/opt/node/bin/corepack',
                  ].join('\n'),
                  err: '',
                }
          ),
        },
      ),
      /Node\.js 22 or newer.*v18\.15\.0/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POSIX provisioning leaves strict checking enabled when host-key enrollment fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dev-target-provision-'));
  const keyDir = join(root, 'dev-target-ssh', 'mac');
  const configPath = join(keyDir, 'ssh.config');
  try {
    await assert.rejects(
      () => provisionPosixDevTarget(
        { name: 'mac', host: 'host.test', user: 'dev', stackBaseDir: root, env: {} },
        {
          pathExists: (path) => path === join(keyDir, 'id_ed25519') || path === join(keyDir, 'id_ed25519.pub'),
          runCaptureResult: async () => ({
            ok: false,
            exitCode: 255,
            out: '',
            err: 'REMOTE HOST IDENTIFICATION HAS CHANGED',
          }),
          runInteractive: async () => {
            throw new Error('ssh-copy-id refused the changed host key');
          },
        },
      ),
      /refused the changed host key/i,
    );

    const sshConfig = await readFile(configPath, 'utf8');
    assert.match(sshConfig, /StrictHostKeyChecking yes/);
    assert.doesNotMatch(sshConfig, /StrictHostKeyChecking accept-new/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
