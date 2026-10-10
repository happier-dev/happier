import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { writeFakeBin } from '../../testkit/core/fake_bin_harness.mjs';
import { prepareDevTargetHost } from './provision.mjs';

async function hostFixture(t) {
  const { root } = await createTempFixture(t, { prefix: 'hstack-host-onboarding-' });
  const etc = join(root, 'etc');
  const config = join(root, 'ssh.config');
  const log = join(root, 'operations');
  for (const name of ['sudoers.d', 'apt/apt.conf.d', 'apt/sources.list.d']) await mkdir(join(etc, name), { recursive: true });
  await writeFile(join(etc, 'os-release'), 'ID=ubuntu\nVERSION_CODENAME=noble\n');
  // APT_CONFIG is loaded before apt.conf.d; command-line -o overrides are too
  // late to isolate the host's configuration-file loading.
  await writeFile(join(etc, 'apt/isolated.conf'), `Dir::Etc::main "/dev/null";\nDir::Etc::parts "${etc}/apt/apt.conf.d";\n`);
  await writeFile(config, 'Host worker\n  HostName 100.84.248.35\n  User root\n  StrictHostKeyChecking yes\n');
  await writeFile(join(root, 'passwd'), 'root:x:0:0::/root:/bin/bash\n');
  const publicKey = 'ssh-ed25519 AAAATEST worker';
  await writeFile(join(root, 'id_ed25519.pub'), `${publicKey}\n`);
  await writeFile(log, '');
  await writeFile(join(root, 'tailnet-state'), 'Running');
  await writeFile(join(root, 'service-active'), 'yes');
  const target = { name: 'worker', platform: 'posix', ssh: 'worker', sshConfigFile: config,
    repoDir: '/root/happier-dev', cliHomeDir: '/root/.happier/dev-targets/worker', remotePath: [] };
  const commands = {
    uname: 'echo Linux',
    id: `case "$1" in
  -u) if [ "$#" = 1 ]; then echo 0; else awk -F: -v account="$2" '$1 == account { print $3; found=1 } END { exit !found }' "$HOST_FIXTURE/passwd"; fi ;;
  -un) echo root ;;
  -gn) echo "$2" ;;
  *) exit 79 ;;
esac`,
    node: 'case "$1" in -p) echo /usr/bin/node ;; --version) echo v24.0.0 ;; *) exit 79 ;; esac',
    corepack: 'echo 0.34.0',
    sudo: 'exit 79',
    getent: `[ "$1" = passwd ] || exit 79
[ -f "$HOST_FIXTURE/passwd" ] || exit 2
if [ "$#" = 1 ]; then cat "$HOST_FIXTURE/passwd"
else awk -F: -v account="$2" '$1 == account { print; found=1 } END { exit !found }' "$HOST_FIXTURE/passwd"; fi`,
    useradd: `printf 'useradd:%s\\n' "$*" >> "$HOST_OPERATIONS"
home=''; user=''
while [ "$#" -gt 0 ]; do
  case "$1" in --create-home) shift ;; --home-dir) home="$2"; shift 2 ;; --shell) shift 2 ;; *) user="$1"; shift ;; esac
done
[ -n "$home" ] && [ -n "$user" ] || exit 79
/bin/mkdir -p "$home"
printf '%s:x:1001:1001::%s:/bin/bash\\n' "$user" "$home" >> "$HOST_FIXTURE/passwd"`,
    chown: 'printf "chown:%s\\n" "$*" >> "$HOST_OPERATIONS"',
    visudo: '[ "$1" = -cf ] && [ -s "$2" ] || exit 79',
    install: `#!/bin/bash
args=()
while (( $# )); do
  case "$1" in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac
done
printf 'install:%s\\n' "\${args[*]}" >> "$HOST_OPERATIONS"
exec /usr/bin/install "\${args[@]}"`,
    'apt-get': `printf 'apt-get:%s\\n' "$*" >> "$HOST_OPERATIONS"
case "$*" in update|'install -y ca-certificates curl'|'install -y tailscale') ;;
  'install -y unattended-upgrades') printf yes > "$HOST_FIXTURE/unattended-installed" ;;
  *) exit 79 ;;
esac`,
    'dpkg-query': '[ -f "$HOST_FIXTURE/unattended-installed" ] || exit 1; printf "install ok installed"',
    'apt-config': 'APT_CONFIG="$HOST_ETC/apt/isolated.conf" exec /usr/bin/apt-config "$@"',
    systemctl: `case "$*" in
  'is-active --quiet tailscaled') [ "$(cat "$HOST_FIXTURE/service-active")" = yes ] ;;
  'enable --now tailscaled') printf 'systemctl:%s\\n' "$*" >> "$HOST_OPERATIONS"; printf yes > "$HOST_FIXTURE/service-active" ;;
  *) exit 79 ;;
esac`,
    tailscale: `case "$1" in
  status) printf '{"BackendState":"%s"}\\n' "$(cat "$HOST_FIXTURE/tailnet-state")" ;;
  ip) echo 100.84.248.35 ;;
  up)
    printf 'tailscale:%s\\n' "$*" >> "$HOST_OPERATIONS"
    if [ "$2" = '--auth-key=file:/dev/stdin' ]; then
      IFS= read -r received
      [ "$received" = "$HOST_AUTHKEY" ] || exit 79
      printf yes > "$HOST_FIXTURE/auth-read-from-stdin"
    else exit 79; fi
    printf Running > "$HOST_FIXTURE/tailnet-state"
    ;;
  *) exit 79 ;;
esac`,
  };
  let bin;
  for (const [name, content] of Object.entries(commands)) {
    ({ binDir: bin } = writeFakeBin({ root, name, content: content.startsWith('#!') ? `${content}\n` : `#!/bin/sh\n${content}\n` }));
  }
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: root, BASH_ENV: '',
    HOST_FIXTURE: root, HOST_ETC: etc, HOST_OPERATIONS: log };
  const transportRequests = [];
  const outputs = [];
  const remap = command => command.replaceAll('/etc/', `${etc}/`).replaceAll('/var/lib/', `${root}/state/`)
    .replaceAll('/usr/share/keyrings', `${root}/keyrings`);
  const run = async (request, stdin = '') => {
    transportRequests.push(request.args);
    const output = await new Promise((resolve, reject) => {
      const child = spawn('/bin/bash', ['-c', remap(request.args.at(-1))], { env: request.env, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = ''; let err = '';
      child.stdout.on('data', data => { out += data; });
      child.stderr.on('data', data => { err += data; });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve({ out, err }) : reject(new Error(`shell exit ${code}: ${err}`)));
      child.stdin.end(stdin);
    });
    outputs.push(output);
    return output;
  };
  const boundary = {
    runInteractive: request => run(request),
    runCaptureResult: async request => {
      transportRequests.push(request.args);
      const candidate = await readFile(request.args[request.args.indexOf('-F') + 1], 'utf8');
      const user = candidate.match(/^\s*User\s+(\S+)/m)?.[1];
      let remoteHome = '/root';
      if (user !== 'root') remoteHome = (await readFile(join(root, 'passwd'), 'utf8')).trim().split('\n')
        .map(line => line.split(':')).find(fields => fields[0] === user)?.[5];
      return { ok: true, out: `__HAPPIER_UNAME__=Linux\n__HAPPIER_HOME__=${remoteHome}\n__HAPPIER_PATH__=/usr/bin:/bin\n__HAPPIER_NODE__=/usr/bin/node\n__HAPPIER_NODE_VERSION__=v24.0.0\n__HAPPIER_COREPACK__=/usr/bin/corepack\n__HAPPIER_TAILNET__=100.84.248.35\n`, err: '' };
    },
  };
  return { root, etc, config, log, target, env, publicKey, boundary, run, transportRequests, outputs,
    prepare: options => prepareDevTargetHost({ target, env, ...options }, boundary) };
}

test('create-user installs dedicated keys and effective dotted-user sudo policy while preserving keys on repeat', async t => {
  const host = await hostFixture(t);
  const user = 'leeroy.guest';
  const home = join(host.root, 'home', user);
  // An existing empty custom directory is valid; its filesystem ownership
  // must not be confused with registration as another account's home.
  await mkdir(home, { recursive: true });
  await host.prepare({ createUser: user, home });
  const keys = join(home, '.ssh/authorized_keys');
  assert.equal((await readFile(keys, 'utf8')).trim(), host.publicKey);
  assert.equal((await stat(keys)).mode & 0o777, 0o600);
  const fragment = join(host.etc, `sudoers.d/happier-user-${Buffer.from(user).toString('hex')}`);
  assert.equal(await readFile(fragment, 'utf8'), `${user} ALL=(ALL) NOPASSWD: ALL\n`);
  assert.equal((await stat(fragment)).mode & 0o777, 0o440);
  assert.match(await readFile(host.config, 'utf8'), /User leeroy\.guest/);
  const otherKey = 'ssh-ed25519 AAAAEXISTING existing-client';
  await writeFile(keys, `${otherKey}\n${host.publicKey}\n`);
  const keysBefore = await stat(keys);
  const policyBefore = await stat(fragment);
  await host.prepare({ createUser: user, home });
  assert.equal(await readFile(keys, 'utf8'), `${otherKey}\n${host.publicKey}\n`);
  assert.equal((await stat(keys)).mtimeMs, keysBefore.mtimeMs, 'already-authorized keys must not be rewritten or touched');
  assert.equal((await stat(fragment)).mtimeMs, policyBefore.mtimeMs);
  assert.equal((await readFile(host.log, 'utf8')).split('\n').filter(line => line.startsWith('useradd:')).length, 1);
});

test('create-user refuses an existing home mismatch before modifying keys or access configuration', async t => {
  const host = await hostFixture(t);
  const existing = join(host.root, 'existing-home');
  await mkdir(join(existing, '.ssh'), { recursive: true });
  const keys = join(existing, '.ssh/authorized_keys');
  await writeFile(keys, 'preserved-key\n');
  await writeFile(join(host.root, 'passwd'), `happier:x:1001:1001::${existing}:/bin/bash\n`);
  const config = await readFile(host.config, 'utf8');
  await assert.rejects(host.prepare({ createUser: 'happier', home: join(host.root, 'different-home') }), /Existing worker home differs/);
  assert.equal(await readFile(keys, 'utf8'), 'preserved-key\n');
  assert.equal(await readFile(host.config, 'utf8'), config);
  assert.equal(await readFile(host.log, 'utf8'), '');
});

test('narrow passwordless browser provisioning admits only the canonical elevated installer argv', async t => {
  const host = await hostFixture(t);
  const realVisudo = spawnSync('bash', ['-c', 'command -v visudo'], { encoding: 'utf8' });
  assert.equal(realVisudo.status, 0, realVisudo.stderr);
  writeFakeBin({ root: host.root, name: 'visudo', content: `#!/bin/sh\nexec ${JSON.stringify(realVisudo.stdout.trim())} "$@"\n` });
  const { binDir } = writeFakeBin({ root: host.root, name: 'id', content:
    '#!/bin/sh\ncase "$1" in -u) echo 1000 ;; -un) echo worker ;; *) exit 79 ;; esac\n' });
  // Preparing a restricted grant uses the already-authorized root connection.
  writeFakeBin({ root: host.root, name: 'sudo', content: '#!/bin/sh\nexec "$@"\n' });
  const nodeEntry = join(host.root, 'nvm', 'v24.21.0+fixture', 'bin', 'node');
  await mkdir(join(nodeEntry, '..'), { recursive: true });
  await symlink(process.execPath, nodeEntry);
  writeFakeBin({ root: host.root, name: 'node', content: `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(nodeEntry)}\n` });
  for (const name of ['lvs', 'vgs']) writeFakeBin({ root: host.root, name, content: '#!/bin/sh\nexit 0\n' });
  writeFakeBin({ root: host.root, name: 'findmnt', content: '#!/bin/sh\necho /dev/fixture\n' });
  await host.prepare({ passwordlessSudo: true, passwordlessProvisioning: true });
  const policy = join(host.etc, 'sudoers.d/happier-worker');
  // Native sudoers parsing and POSIX-ERE matching implement the genuine sudo
  // policy boundary. They never read or write the machine's installed policy.
  writeFakeBin({ root: host.root, name: 'sudo', content: `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.shift() !== '-n') process.exit(79);
const parsed = spawnSync('/usr/bin/cvtsudoers', ['-f', 'json', process.env.HOST_BROWSER_POLICY], { encoding: 'utf8' });
if (parsed.status !== 0) { process.stderr.write(parsed.stderr); process.exit(79); }
const lookup = spawnSync('/bin/sh', ['-c', 'command -v "$1"', '--', args[0]], { encoding: 'utf8' });
const command = fs.realpathSync(lookup.stdout.trim());
let allowed = false;
for (const entry of JSON.parse(parsed.stdout).User_Specs ?? []) {
  if (!entry.User_List.some(user => user.username === 'worker') || !entry.Host_List.some(host => host.hostname === 'ALL')) continue;
  for (const spec of entry.Cmnd_Specs) {
    if (!spec.runasusers.some(user => user.username === 'root') || !spec.Options.some(option => option.authenticate === false)) continue;
    for (const rule of spec.Commands) {
      const separator = rule.command.indexOf(' ');
      const executable = rule.command.slice(0, separator);
      const pattern = rule.command.slice(separator + 1);
      if (fs.realpathSync(executable) !== command) continue;
      const matches = pattern.startsWith('^') && pattern.endsWith('$')
        ? spawnSync('/usr/bin/grep', ['-E', '-x', '--', pattern], { input: args.slice(1).join(' ') + '\\n' }).status === 0
        : pattern === args.slice(1).join(' ');
      if (matches) allowed = true;
    }
  }
}
if (!allowed) { console.error('restricted sudo policy denied installer argv'); process.exit(1); }
delete process.env.COREPACK_ENABLE_PROJECT_SPEC;
const result = spawnSync(command, args.slice(1), { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
` });
  const installed = join(host.root, 'browser-installed');
  writeFakeBin({ root: host.root, name: 'corepack', content: `#!${process.execPath}
require('node:assert/strict').equal(process.env.COREPACK_ENABLE_PROJECT_SPEC, '0');
require('node:assert/strict').deepEqual(process.argv.slice(2), ['npm', 'install', '--global', '--no-audit', '--no-fund', '--allow-scripts=agent-browser', 'agent-browser@0.34.0']);
require('node:fs').writeFileSync(process.env.HOST_BROWSER_INSTALLED, 'ready');
` });
  writeFakeBin({ root: host.root, name: 'uname', content: '#!/bin/sh\necho x86_64\n' });
  writeFakeBin({ root: host.root, name: 'agent-browser', content:
    '#!/bin/sh\nif [ "$1" = --version ]; then if [ -f "$HOST_BROWSER_INSTALLED" ]; then echo 0.34.0; else echo 0.0.0; fi; elif [ "$*" != "install --with-deps" ]; then exit 79; fi\n' });
  const env = { ...host.env, HOST_BROWSER_POLICY: policy, HOST_BROWSER_INSTALLED: installed };
  const script = fileURLToPath(new URL('../../provision/linux-ubuntu-provision.sh', import.meta.url));
  const result = spawnSync('/bin/bash', [script, '--profile=qa'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(installed, 'utf8'), 'ready');
  const installer = [nodeEntry, join(binDir, 'corepack'), 'npm', 'install', '--global', '--no-audit', '--no-fund',
    '--allow-scripts=agent-browser', 'agent-browser@0.34.0'];
  for (const assignment of [['COREPACK_ENABLE_PROJECT_SPEC=1'], ['COREPACK_ENABLE_PROJECT_SPEC=0', 'NODE_OPTIONS=--inspect']]) {
    const refused = spawnSync(join(binDir, 'sudo'), ['-n', '/usr/bin/env', ...assignment, ...installer], { env, encoding: 'utf8' });
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /restricted sudo policy denied/);
  }
  const neighboringNode = nodeEntry.replace('v24.21.0+fixture', 'v24x21x0fixture');
  await mkdir(join(neighboringNode, '..'), { recursive: true });
  await symlink(process.execPath, neighboringNode);
  for (const unsafeInstaller of [
    [neighboringNode, ...installer.slice(1)],
    [nodeEntry, `${join(binDir, 'corepack')}-other`, ...installer.slice(2)],
    [...installer, '--force'],
  ]) {
    const refused = spawnSync(join(binDir, 'sudo'), ['-n', '/usr/bin/env', 'COREPACK_ENABLE_PROJECT_SPEC=0', ...unsafeInstaller],
      { env, encoding: 'utf8' });
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /restricted sudo policy denied/);
  }
});

for (const scenario of ['occupied-root-home', 'occupied-root-home-alias', 'uid-zero-alias']) {
  test(`create-user refuses ${scenario} before key ownership, sudo or SSH mutation`, async t => {
    const host = await hostFixture(t);
    const home = join(host.root, 'protected-home');
    await mkdir(join(home, '.ssh'), { recursive: true });
    const keys = join(home, '.ssh/authorized_keys');
    await writeFile(keys, 'preserved-root-key\n');
    const user = scenario === 'uid-zero-alias' ? 'root-alias' : 'worker';
    const passwd = `${scenario === 'uid-zero-alias' ? user : 'root'}:x:0:0::${home}:/bin/bash\n`;
    await writeFile(join(host.root, 'passwd'), passwd);
    let requestedHome = home;
    if (scenario === 'occupied-root-home-alias') {
      const alias = join(host.root, 'home-alias');
      await symlink(home, alias);
      requestedHome = `${alias}/.`;
    }
    const config = await readFile(host.config, 'utf8');
    let refusal;
    try { await host.prepare({ createUser: user, home: requestedHome }); } catch (error) { refusal = error; }
    const operations = await readFile(host.log, 'utf8');
    assert.ok(refusal, `unsafe account was accepted; observed OS mutations:\n${operations}`);
    assert.match(refusal.message, scenario === 'uid-zero-alias' ? /non-root|UID 0/i : /home.*another account/i);
    assert.equal(await readFile(keys, 'utf8'), 'preserved-root-key\n');
    assert.equal(await readFile(join(host.root, 'passwd'), 'utf8'), passwd);
    assert.equal(await readFile(host.config, 'utf8'), config);
    assert.equal(operations, '', 'refusal must precede useradd, key ownership and sudo writes');
  });
}

test('joined Tailscale skips installation and login on repeated host preparation', async t => {
  const host = await hostFixture(t);
  await host.prepare({ tailscale: true });
  await host.prepare({ tailscale: true });
  assert.equal(await readFile(host.log, 'utf8'), '');
  assert.match(await readFile(host.config, 'utf8'), /HostName 100\.84\.248\.35/);
});

test('Tailscale authentication reaches only stdin and subsequent preparation does not reauthenticate', async t => {
  const host = await hostFixture(t);
  await writeFile(join(host.root, 'tailnet-state'), 'Stopped');
  const secret = 'tskey-auth-fixture-only-do-not-print';
  const env = { ...host.env, HOST_AUTHKEY: secret };
  const boundary = { ...host.boundary, runInteractive: request => host.run(request, `${secret}\n`) };
  await prepareDevTargetHost({ target: host.target, env, tailscale: true, tailscaleAuthkeyStdin: true }, boundary);
  assert.equal(await readFile(join(host.root, 'auth-read-from-stdin'), 'utf8'), 'yes');
  assert.ok(host.transportRequests.every(args => !args.some(arg => arg.includes(secret))), 'credential must never enter SSH argv');
  assert.ok(host.outputs.every(({ out, err }) => !out.includes(secret) && !err.includes(secret)), 'credential must never enter output');
  assert.ok(!(await readFile(host.log, 'utf8')).includes(secret), 'credential must never enter operation logs');
  const first = await readFile(host.log, 'utf8');
  await prepareDevTargetHost({ target: host.target, env, tailscale: true, tailscaleAuthkeyStdin: true }, boundary);
  assert.equal(await readFile(host.log, 'utf8'), first);
});

test('automatic updates replace broad inherited origins with security-only policy, disable reboot and converge', async t => {
  const host = await hostFixture(t);
  await writeFile(join(host.etc, 'apt/apt.conf.d/50unattended-upgrades'),
    'Unattended-Upgrade::Allowed-Origins { "Ubuntu:noble"; "Ubuntu:noble-updates"; };\nUnattended-Upgrade::Origins-Pattern { "origin=*"; };\nUnattended-Upgrade::Automatic-Reboot "true";\n');
  await host.prepare({ autoUpdates: true });
  const policy = join(host.etc, 'apt/apt.conf.d/52happier-security-upgrades');
  const content = await readFile(policy, 'utf8');
  assert.match(content, /Allowed-Origins \{ "\$\{distro_id\}:\$\{distro_codename\}-security"; \}/);
  assert.match(content, /Automatic-Reboot "false"/);
  const effective = await host.run({ args: ['apt-config dump'], env: host.env });
  assert.match(effective.out, /Allowed-Origins:: "\$\{distro_id\}:\$\{distro_codename\}-security"/);
  assert.doesNotMatch(effective.out, /noble-updates|origin=\*/);
  assert.match(effective.out, /Automatic-Reboot "false"/);
  const before = await stat(policy);
  const operations = await readFile(host.log, 'utf8');
  assert.match(operations, /apt-get:install -y unattended-upgrades/);
  await host.prepare({ autoUpdates: true });
  assert.equal((await stat(policy)).mtimeMs, before.mtimeMs);
  assert.equal(await readFile(host.log, 'utf8'), operations);
});

test('automatic updates refuse non-Ubuntu systems and an effective reboot override', async t => {
  const host = await hostFixture(t);
  await writeFile(join(host.etc, 'os-release'), 'ID=debian\nVERSION_CODENAME=bookworm\n');
  await assert.rejects(host.prepare({ autoUpdates: true }), /supports Ubuntu/);
  assert.equal(await readFile(host.log, 'utf8'), '');
  await writeFile(join(host.etc, 'os-release'), 'ID=ubuntu\nVERSION_CODENAME=noble\n');
  await writeFile(join(host.etc, 'apt/apt.conf.d/99operator-reboot'), 'Unattended-Upgrade::Automatic-Reboot "true";\n');
  await assert.rejects(host.prepare({ autoUpdates: true }), /Automatic reboot policy is overridden/);
});
