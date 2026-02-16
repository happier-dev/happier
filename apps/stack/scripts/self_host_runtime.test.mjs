import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  parseSelfHostInvocation,
  pickReleaseAsset,
  resolveMinisignPublicKeyText,
  resolveSelfHostAutoUpdateDefault,
  resolveSelfHostAutoUpdateIntervalMinutes,
  resolveSelfHostHealthTimeoutMs,
  resolveSelfHostDefaults,
  renderUpdaterLaunchdPlistXml,
  renderUpdaterScheduledTaskWrapperPs1,
  renderUpdaterSystemdUnit,
  renderUpdaterSystemdTimerUnit,
  buildUpdaterScheduledTaskCreateArgs,
  renderServerEnvFile,
  renderServerServiceUnit,
  renderSelfHostStatusText,
  buildSelfHostDoctorChecks,
  normalizeSelfHostAutoUpdateState,
  decideSelfHostAutoUpdateReconcile,
  mergeEnvTextWithDefaults,
} from './self_host_runtime.mjs';

function b64(buf) {
  return Buffer.from(buf).toString('base64');
}

function base64UrlToBuffer(value) {
  const s = String(value ?? '')
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(String(value ?? '').length / 4) * 4, '=');
  return Buffer.from(s, 'base64');
}

function createMinisignKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  const rawPublicKey = base64UrlToBuffer(jwk.x);
  assert.equal(rawPublicKey.length, 32);

  const keyId = Buffer.from('0123456789abcdef', 'hex');
  const publicKeyBytes = Buffer.concat([Buffer.from('Ed'), keyId, rawPublicKey]);
  const pubkeyFile = `untrusted comment: minisign public key\n${b64(publicKeyBytes)}\n`;
  return { pubkeyFile, keyId, privateKey };
}

function signMinisignMessage({ message, keyId, privateKey }) {
  const signature = sign(null, message, privateKey);
  const sigLineBytes = Buffer.concat([Buffer.from('Ed'), keyId, signature]);
  const trustedComment = 'trusted comment: test';
  const trustedSuffix = Buffer.from(trustedComment.slice('trusted comment: '.length), 'utf-8');
  const globalSignature = sign(null, Buffer.concat([signature, trustedSuffix]), privateKey);
  return [
    'untrusted comment: signature from happier stack test',
    b64(sigLineBytes),
    trustedComment,
    b64(globalSignature),
    '',
  ].join('\n');
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('parseSelfHostInvocation accepts optional self-host prefix', () => {
  const parsed = parseSelfHostInvocation(['self-host', 'install', '--channel=preview']);
  assert.equal(parsed.subcommand, 'install');
  assert.deepEqual(parsed.rest, ['--channel=preview']);
});

test('parseSelfHostInvocation supports direct command invocation', () => {
  const parsed = parseSelfHostInvocation(['status', '--json']);
  assert.equal(parsed.subcommand, 'status');
  assert.deepEqual(parsed.rest, ['--json']);
});

test('pickReleaseAsset returns matching archive and checksum assets', () => {
  const assets = [
    { name: 'happier-server-v1.2.3-linux-x64.tar.gz', browser_download_url: 'https://example.test/server.tar.gz' },
    { name: 'checksums-happier-server-v1.2.3.txt', browser_download_url: 'https://example.test/checksums.txt' },
    { name: 'checksums-happier-server-v1.2.3.txt.minisig', browser_download_url: 'https://example.test/checksums.txt.minisig' },
  ];
  const picked = pickReleaseAsset({
    assets,
    product: 'happier-server',
    os: 'linux',
    arch: 'x64',
  });
  assert.equal(picked.archiveUrl, 'https://example.test/server.tar.gz');
  assert.equal(picked.checksumsUrl, 'https://example.test/checksums.txt');
  assert.equal(picked.signatureUrl, 'https://example.test/checksums.txt.minisig');
});

test('self-host release installer reports archive source url', async (t) => {
  if (process.platform === 'win32') {
    t.skip('tar-based bundle test does not run on windows');
    return;
  }
  if (spawnSync('bash', ['-lc', 'command -v tar >/dev/null 2>&1'], { stdio: 'ignore' }).status !== 0) {
    t.skip('tar is required for bundle installation test');
    return;
  }

  const tmp = await mkdtemp(join(tmpdir(), 'happier-self-host-bundle-test-'));
  t.after(async () => {
    await spawnSync('bash', ['-lc', `rm -rf "${tmp.replaceAll('"', '\\"')}"`], { stdio: 'ignore' });
  });

  const staging = join(tmp, 'staging');
  const rootName = 'happier-server-v1.2.3-preview.1-linux-x64';
  const rootDir = join(staging, rootName);
  await mkdir(join(rootDir, 'generated'), { recursive: true });
  await writeFile(join(rootDir, 'generated', 'dummy.txt'), 'ok', 'utf-8');

  const binaryName = 'happier-server';
  const binaryPath = join(rootDir, binaryName);
  await writeFile(binaryPath, '#!/bin/sh\necho ok\n', 'utf-8');
  spawnSync('bash', ['-lc', `chmod +x "${binaryPath.replaceAll('"', '\\"')}"`], { stdio: 'ignore' });

  const archiveName = `${rootName}.tar.gz`;
  const archivePath = join(tmp, archiveName);
  const tar = spawnSync('tar', ['-czf', archivePath, '-C', staging, rootName], { encoding: 'utf-8' });
  assert.equal(tar.status, 0, tar.stderr || tar.stdout);

  const archiveBytes = await (await import('node:fs/promises')).readFile(archivePath);
  const archiveSha = sha256Hex(archiveBytes);
  const checksumsText = `${archiveSha} ${archiveName}\n`;
  const { pubkeyFile, keyId, privateKey } = createMinisignKeyPair();
  const sigFile = signMinisignMessage({
    message: Buffer.from(checksumsText, 'utf-8'),
    keyId,
    privateKey,
  });

  const archiveUrl = `data:application/octet-stream;base64,${archiveBytes.toString('base64')}`;
  const checksumsUrl = `data:text/plain,${encodeURIComponent(checksumsText)}`;
  const sigUrl = `data:text/plain,${encodeURIComponent(sigFile)}`;

  const bundle = {
    version: '1.2.3-preview.1',
    archive: { name: archiveName, url: archiveUrl },
    checksums: { name: `checksums-happier-server-v1.2.3-preview.1.txt`, url: checksumsUrl },
    checksumsSig: { name: `checksums-happier-server-v1.2.3-preview.1.txt.minisig`, url: sigUrl },
  };

  const installRoot = join(tmp, 'install');
  const config = {
    platform: process.platform,
    dataDir: join(installRoot, 'data'),
    versionsDir: join(installRoot, 'versions'),
    serverBinaryPath: join(installRoot, 'bin', binaryName),
    serverPreviousBinaryPath: join(installRoot, 'bin', `${binaryName}.previous`),
  };

  const mod = await import('./self_host_runtime.mjs');
  assert.equal(typeof mod.installSelfHostBinaryFromBundle, 'function');

  const result = await mod.installSelfHostBinaryFromBundle({
    bundle,
    binaryName,
    config,
    pubkeyFile,
  });

  assert.equal(result.version, '1.2.3-preview.1');
  assert.equal(result.source, archiveUrl);
});

test('pickReleaseAsset rejects releases missing minisign signature assets', () => {
  assert.throws(() => {
    pickReleaseAsset({
      assets: [
        { name: 'happier-server-v1.2.3-linux-x64.tar.gz', browser_download_url: 'https://example.test/server.tar.gz' },
        { name: 'checksums-happier-server-v1.2.3.txt', browser_download_url: 'https://example.test/checksums.txt' },
      ],
      product: 'happier-server',
      os: 'linux',
      arch: 'x64',
    });
  }, /minisig|signature/i);
});

test('pickReleaseAsset supports windows zip artifacts', () => {
  const assets = [
    { name: 'happier-server-v1.2.3-windows-x64.zip', browser_download_url: 'https://example.test/server.zip' },
    { name: 'checksums-happier-server-v1.2.3.txt', browser_download_url: 'https://example.test/checksums.txt' },
    { name: 'checksums-happier-server-v1.2.3.txt.minisig', browser_download_url: 'https://example.test/checksums.txt.minisig' },
  ];
  const picked = pickReleaseAsset({
    assets,
    product: 'happier-server',
    os: 'windows',
    arch: 'x64',
  });
  assert.equal(picked.archiveUrl, 'https://example.test/server.zip');
});

test('pickReleaseAsset supports windows tar.gz artifacts', () => {
  const assets = [
    { name: 'happier-server-v1.2.3-windows-x64.tar.gz', browser_download_url: 'https://example.test/server.tgz' },
    { name: 'checksums-happier-server-v1.2.3.txt', browser_download_url: 'https://example.test/checksums.txt' },
    { name: 'checksums-happier-server-v1.2.3.txt.minisig', browser_download_url: 'https://example.test/checksums.txt.minisig' },
  ];
  const picked = pickReleaseAsset({
    assets,
    product: 'happier-server',
    os: 'windows',
    arch: 'x64',
  });
  assert.equal(picked.archiveUrl, 'https://example.test/server.tgz');
});

test('renderServerServiceUnit references configured binary and env file', () => {
  const unit = renderServerServiceUnit({
    serviceName: 'happier-server',
    binaryPath: '/opt/happier/bin/happier-server',
    envFilePath: '/etc/happier/server.env',
    workingDirectory: '/opt/happier',
    logPath: '/var/log/happier/server.log',
  });
  assert.match(unit, /ExecStart=\/opt\/happier\/bin\/happier-server/);
  assert.match(unit, /EnvironmentFile=\/etc\/happier\/server.env/);
  assert.match(unit, /WorkingDirectory=\/opt\/happier/);
  assert.match(unit, /StandardOutput=append:\/var\/log\/happier\/server.log/);
});

test('resolveSelfHostDefaults uses user-mode paths by default', () => {
  const cfg = resolveSelfHostDefaults({ platform: 'linux', mode: 'user', homeDir: '/home/me' });
  assert.equal(cfg.installRoot, '/home/me/.happier/self-host');
  assert.equal(cfg.binDir, '/home/me/.happier/bin');
  assert.equal(cfg.configDir, '/home/me/.happier/self-host/config');
});

test('resolveMinisignPublicKeyText prefers inline override and otherwise returns bundled key', () => {
  const bundled = resolveMinisignPublicKeyText({});
  assert.match(bundled, /minisign public key/i);
  assert.equal(resolveMinisignPublicKeyText({ HAPPIER_MINISIGN_PUBKEY: 'hello' }), 'hello');
});

test('renderServerEnvFile emits sqlite/local defaults for self-host mode', () => {
  const envText = renderServerEnvFile({
    port: 3005,
    host: '127.0.0.1',
    dataDir: '/var/lib/happier',
    filesDir: '/var/lib/happier/files',
    dbDir: '/var/lib/happier/pglite',
  });
  assert.match(envText, /PORT=3005/);
  assert.match(envText, /METRICS_ENABLED=false/);
  assert.match(envText, /HAPPIER_DB_PROVIDER=sqlite/);
  assert.match(envText, /DATABASE_URL=file:\/var\/lib\/happier\/happier-server-light\.sqlite/);
  assert.match(envText, /HAPPIER_FILES_BACKEND=local/);
  assert.match(envText, /HAPPIER_SQLITE_AUTO_MIGRATE=1/);
  assert.match(envText, /HAPPIER_SQLITE_MIGRATIONS_DIR=\/var\/lib\/happier\/migrations\/sqlite/);
  assert.match(envText, /HAPPIER_SERVER_LIGHT_DATA_DIR=\/var\/lib\/happier/);
  assert.match(envText, /HAPPIER_SERVER_LIGHT_FILES_DIR=\/var\/lib\/happier\/files/);
  assert.match(envText, /HAPPIER_SERVER_LIGHT_DB_DIR=\/var\/lib\/happier\/pglite/);
});

test('renderServerEnvFile includes ui bundle directory when provided', () => {
  const envText = renderServerEnvFile({
    port: 3005,
    host: '127.0.0.1',
    dataDir: '/var/lib/happier',
    filesDir: '/var/lib/happier/files',
    dbDir: '/var/lib/happier/pglite',
    uiDir: '/var/lib/happier/ui-web/current',
  });
  assert.match(envText, /HAPPIER_SERVER_UI_DIR=\/var\/lib\/happier\/ui-web\/current/);
});

test('renderServerEnvFile includes PRISMA_QUERY_ENGINE_LIBRARY when a packaged sqlite engine is present', async () => {
  const serverBinDir = await mkdtemp(join(tmpdir(), 'happier-self-host-bin-'));
  await mkdir(join(serverBinDir, 'generated', 'sqlite-client'), { recursive: true });
  const enginePath = join(serverBinDir, 'generated', 'sqlite-client', 'libquery_engine-darwin-arm64.dylib.node');
  await writeFile(enginePath, 'stub', 'utf-8');

  const envText = renderServerEnvFile({
    port: 3005,
    host: '127.0.0.1',
    platform: 'darwin',
    arch: 'arm64',
    serverBinDir,
    dataDir: '/var/lib/happier',
    filesDir: '/var/lib/happier/files',
    dbDir: '/var/lib/happier/pglite',
  });
  assert.match(envText, /PRISMA_CLIENT_ENGINE_TYPE=library/);
  assert.match(envText, new RegExp(`PRISMA_QUERY_ENGINE_LIBRARY=${enginePath.replaceAll('\\\\', '\\\\\\\\')}`));
});

test('renderServerEnvFile uses file URL semantics on Windows', () => {
  const envText = renderServerEnvFile({
    port: 3005,
    host: '127.0.0.1',
    platform: 'win32',
    dataDir: 'C:\\\\Users\\\\me\\\\.happier\\\\self-host\\\\data',
    filesDir: 'C:\\\\Users\\\\me\\\\.happier\\\\self-host\\\\data\\\\files',
    dbDir: 'C:\\\\Users\\\\me\\\\.happier\\\\self-host\\\\data\\\\pglite',
  });
  assert.match(envText, /DATABASE_URL=file:\/\/\/C:\/Users\/me\/\.happier\/self-host\/data\/happier-server-light\.sqlite/);
});

test('resolveSelfHostHealthTimeoutMs defaults to a safe health timeout', () => {
  assert.equal(resolveSelfHostHealthTimeoutMs({}), 90_000);
});

test('resolveSelfHostHealthTimeoutMs honors explicit timeout values >= 10s', () => {
  assert.equal(resolveSelfHostHealthTimeoutMs({ HAPPIER_SELF_HOST_HEALTH_TIMEOUT_MS: '120000' }), 120_000);
});

test('resolveSelfHostHealthTimeoutMs ignores invalid or too-small values', () => {
  assert.equal(resolveSelfHostHealthTimeoutMs({ HAPPIER_SELF_HOST_HEALTH_TIMEOUT_MS: 'abc' }), 90_000);
  assert.equal(resolveSelfHostHealthTimeoutMs({ HAPPIER_SELF_HOST_HEALTH_TIMEOUT_MS: '5000' }), 90_000);
});

test('resolveSelfHostAutoUpdateDefault is opt-in (disabled by default)', () => {
  assert.equal(resolveSelfHostAutoUpdateDefault({}), false);
  assert.equal(resolveSelfHostAutoUpdateDefault({ HAPPIER_SELF_HOST_AUTO_UPDATE: '1' }), true);
});

test('resolveSelfHostAutoUpdateIntervalMinutes provides a safe default and bounds invalid values', () => {
  assert.equal(resolveSelfHostAutoUpdateIntervalMinutes({}), 1440);
  assert.equal(resolveSelfHostAutoUpdateIntervalMinutes({ HAPPIER_SELF_HOST_AUTO_UPDATE_INTERVAL_MINUTES: '60' }), 60);
  assert.equal(resolveSelfHostAutoUpdateIntervalMinutes({ HAPPIER_SELF_HOST_AUTO_UPDATE_INTERVAL_MINUTES: '0' }), 1440);
  assert.equal(resolveSelfHostAutoUpdateIntervalMinutes({ HAPPIER_SELF_HOST_AUTO_UPDATE_INTERVAL_MINUTES: 'abc' }), 1440);
});

test('renderUpdaterSystemdUnit runs self-host update without restart loops', () => {
  const unit = renderUpdaterSystemdUnit({
    updaterLabel: 'happier-server-updater',
    hstackPath: '/home/me/.happier/bin/hstack',
    channel: 'preview',
    mode: 'user',
    workingDirectory: '/home/me/.happier/self-host',
    stdoutPath: '/home/me/.happier/self-host/logs/updater.out.log',
    stderrPath: '/home/me/.happier/self-host/logs/updater.err.log',
    wantedBy: 'default.target',
  });
  assert.match(unit, /ExecStart=\/home\/me\/\.happier\/bin\/hstack self-host update --channel=preview --mode=user --non-interactive/);
  assert.match(unit, /Restart=no/);
  assert.match(unit, /WantedBy=default\.target/);
});

test('renderUpdaterLaunchdPlistXml runs self-host update without keepalive loops', () => {
  const plist = renderUpdaterLaunchdPlistXml({
    updaterLabel: 'happier-server-updater',
    hstackPath: '/Users/me/.happier/bin/hstack',
    channel: 'preview',
    mode: 'user',
    intervalMinutes: 60,
    workingDirectory: '/Users/me/.happier/self-host',
    stdoutPath: '/Users/me/.happier/self-host/logs/updater.out.log',
    stderrPath: '/Users/me/.happier/self-host/logs/updater.err.log',
  });

  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>3600<\/integer>/);
  assert.doesNotMatch(plist, /<key>StartCalendarInterval<\/key>/);
  assert.doesNotMatch(plist, /<key>KeepAlive<\/key>/);
  assert.match(plist, /<key>PATH<\/key>/);
  assert.match(plist, /<string>\/Users\/me\/\.happier\/bin\/hstack<\/string>/);
  assert.match(plist, /<string>self-host<\/string>/);
  assert.match(plist, /<string>update<\/string>/);
  assert.match(plist, /<string>--channel=preview<\/string>/);
  assert.match(plist, /<string>--mode=user<\/string>/);
  assert.match(plist, /<string>--non-interactive<\/string>/);
});

test('renderUpdaterLaunchdPlistXml supports daily time-of-day schedules', () => {
  const plist = renderUpdaterLaunchdPlistXml({
    updaterLabel: 'happier-server-updater',
    hstackPath: '/Users/me/.happier/bin/hstack',
    channel: 'stable',
    mode: 'user',
    at: '03:15',
    workingDirectory: '/Users/me/.happier/self-host',
    stdoutPath: '/Users/me/.happier/self-host/logs/updater.out.log',
    stderrPath: '/Users/me/.happier/self-host/logs/updater.err.log',
  });
  assert.match(plist, /<key>StartCalendarInterval<\/key>/);
  assert.match(plist, /<key>Hour<\/key>\s*<integer>3<\/integer>/);
  assert.match(plist, /<key>Minute<\/key>\s*<integer>15<\/integer>/);
  assert.doesNotMatch(plist, /<key>StartInterval<\/key>/);
});

test('renderUpdaterSystemdTimerUnit schedules periodic updater runs', () => {
  const timer = renderUpdaterSystemdTimerUnit({
    updaterLabel: 'happier-server-updater',
    intervalMinutes: 60,
  });
  assert.match(timer, /OnUnitActiveSec=60m/);
  assert.doesNotMatch(timer, /OnCalendar=/);
  assert.match(timer, /Unit=happier-server-updater\.service/);
  assert.match(timer, /WantedBy=timers\.target/);
});

test('renderUpdaterSystemdTimerUnit supports daily time-of-day schedules', () => {
  const timer = renderUpdaterSystemdTimerUnit({
    updaterLabel: 'happier-server-updater',
    at: '03:15',
  });
  assert.match(timer, /OnCalendar=\*-\*-\*\s+03:15:00/);
  assert.doesNotMatch(timer, /OnUnitActiveSec=/);
  assert.match(timer, /Unit=happier-server-updater\.service/);
});

test('renderUpdaterScheduledTaskWrapperPs1 runs self-host update without node dependencies', () => {
  const wrapper = renderUpdaterScheduledTaskWrapperPs1({
    updaterLabel: 'happier-server-updater',
    hstackPath: 'C:\\\\Users\\\\me\\\\.happier\\\\bin\\\\hstack.exe',
    channel: 'preview',
    mode: 'user',
    workingDirectory: 'C:\\\\Users\\\\me\\\\.happier\\\\self-host',
    stdoutPath: 'C:\\\\Users\\\\me\\\\.happier\\\\self-host\\\\logs\\\\updater.out.log',
    stderrPath: 'C:\\\\Users\\\\me\\\\.happier\\\\self-host\\\\logs\\\\updater.err.log',
  });

  assert.match(
    wrapper,
    /hstack\.exe"\s+"self-host"\s+"update"\s+"--channel=preview"\s+"--mode=user"\s+"--non-interactive"/i
  );
});

test('buildUpdaterScheduledTaskCreateArgs uses DAILY schedule when at is provided', () => {
  const args = buildUpdaterScheduledTaskCreateArgs({
    backend: 'schtasks-user',
    taskName: 'Happier\\\\happier-server-updater',
    definitionPath: 'C:\\\\Users\\\\me\\\\.happier\\\\self-host\\\\services\\\\happier-server-updater.ps1',
    at: '03:15',
  });
  assert.ok(args.includes('DAILY'));
  assert.ok(args.includes('03:15'));
  assert.equal(args.includes('MINUTE'), false);
});

test('mergeEnvTextWithDefaults preserves overrides while backfilling new default keys', () => {
  const defaults = renderServerEnvFile({
    port: 3005,
    host: '127.0.0.1',
    dataDir: '/var/lib/happier',
    filesDir: '/var/lib/happier/files',
    dbDir: '/var/lib/happier/pglite',
  });
  const existing = [
    ...defaults
      .split('\n')
      .filter((line) => !line.startsWith('HAPPIER_SQLITE_AUTO_MIGRATE=') && !line.startsWith('HAPPIER_SQLITE_MIGRATIONS_DIR=')),
    'PORT=7777',
    'FOO=bar',
    '',
  ].join('\n');

  const merged = mergeEnvTextWithDefaults(existing, defaults);
  assert.match(merged, /PORT=7777/);
  assert.match(merged, /HAPPIER_SQLITE_AUTO_MIGRATE=1/);
  assert.match(merged, /HAPPIER_SQLITE_MIGRATIONS_DIR=\/var\/lib\/happier\/migrations\/sqlite/);
  assert.match(merged, /FOO=bar/);
});

test('renderSelfHostStatusText reports versions, health, and auto-update config separately from job state', () => {
  const text = renderSelfHostStatusText(
    {
      channel: 'preview',
      mode: 'user',
      serviceName: 'happier-server',
      serverUrl: 'http://127.0.0.1:3005',
      healthy: true,
      service: { active: true, enabled: true },
      versions: { server: '1.2.3-preview.1', uiWeb: '9.9.9-preview.2' },
      autoUpdate: {
        label: 'happier-server-updater',
        job: { active: true, enabled: true },
        configured: { enabled: true, intervalMinutes: 60 },
      },
      updatedAt: '2026-02-15T00:00:00.000Z',
    },
    { colors: false },
  );

  assert.match(text, /channel:\s*preview/);
  assert.match(text, /mode:\s*user/);
  assert.match(text, /url:\s*http:\/\/127\.0\.0\.1:3005/);
  assert.match(text, /health:\s*ok/);
  assert.match(text, /server:\s*1\.2\.3-preview\.1/);
  assert.match(text, /ui-web:\s*9\.9\.9-preview\.2/);
  assert.match(text, /auto-update:\s*configured enabled \(every 60m\); job enabled, active/);
  assert.match(text, /updated:\s*2026-02-15T00:00:00\.000Z/);
});

test('renderSelfHostStatusText shows disabled auto-update config even if job state is unknown', () => {
  const text = renderSelfHostStatusText(
    {
      channel: 'stable',
      mode: 'user',
      serviceName: 'happier-server',
      serverUrl: 'http://127.0.0.1:3005',
      healthy: false,
      service: { active: null, enabled: null },
      versions: { server: null, uiWeb: null },
      autoUpdate: {
        label: 'happier-server-updater',
        job: { active: null, enabled: null },
        configured: { enabled: false, intervalMinutes: 1440 },
      },
      updatedAt: null,
    },
    { colors: false },
  );

  assert.match(text, /auto-update:\s*configured disabled; job unknown/);
  assert.match(text, /health:\s*failed/);
});

test('buildSelfHostDoctorChecks does not require external minisign and includes ui-web checks when installed', () => {
  const checks = buildSelfHostDoctorChecks(
    {
      platform: 'linux',
      mode: 'user',
      serverBinaryPath: '/home/me/.happier/self-host/bin/happier-server',
      configEnvPath: '/home/me/.happier/self-host/config/server.env',
      uiWebCurrentDir: '/home/me/.happier/self-host/ui-web/current',
    },
    {
      state: { uiWeb: { installed: true } },
      commandExists: (name) => new Set(['tar', 'systemctl']).has(name),
      pathExists: (p) => p.endsWith('happier-server') || p.endsWith('server.env') || p.endsWith('index.html'),
    },
  );

  assert.ok(checks.find((c) => c.name === 'tar')?.ok);
  assert.ok(checks.find((c) => c.name === 'systemctl')?.ok);
  assert.equal(checks.some((c) => c.name === 'minisign'), false);
  assert.ok(checks.find((c) => c.name === 'ui-web')?.ok);
});

test('buildSelfHostDoctorChecks flags missing ui-web bundle when state expects ui-web installed', () => {
  const checks = buildSelfHostDoctorChecks(
    {
      platform: 'linux',
      mode: 'user',
      serverBinaryPath: '/home/me/.happier/self-host/bin/happier-server',
      configEnvPath: '/home/me/.happier/self-host/config/server.env',
      uiWebCurrentDir: '/home/me/.happier/self-host/ui-web/current',
    },
    {
      state: { uiWeb: { installed: true } },
      commandExists: () => true,
      pathExists: (p) => !p.endsWith('index.html'),
    },
  );

  assert.equal(checks.find((c) => c.name === 'ui-web')?.ok, false);
});

test('normalizeSelfHostAutoUpdateState upgrades legacy boolean config to structured config', () => {
  assert.deepEqual(
    normalizeSelfHostAutoUpdateState({ autoUpdate: true }, { fallbackIntervalMinutes: 1440 }),
    { enabled: true, intervalMinutes: 1440, at: '' },
  );
  assert.deepEqual(
    normalizeSelfHostAutoUpdateState({ autoUpdate: false }, { fallbackIntervalMinutes: 1440 }),
    { enabled: false, intervalMinutes: 1440, at: '' },
  );
});

test('normalizeSelfHostAutoUpdateState preserves explicit interval and bounds invalid values', () => {
  assert.deepEqual(
    normalizeSelfHostAutoUpdateState({ autoUpdate: { enabled: true, intervalMinutes: 60 } }, { fallbackIntervalMinutes: 1440 }),
    { enabled: true, intervalMinutes: 60, at: '' },
  );
  assert.deepEqual(
    normalizeSelfHostAutoUpdateState({ autoUpdate: { enabled: true, intervalMinutes: 0 } }, { fallbackIntervalMinutes: 1440 }),
    { enabled: true, intervalMinutes: 1440, at: '' },
  );
  assert.deepEqual(
    normalizeSelfHostAutoUpdateState({}, { fallbackIntervalMinutes: 1440 }),
    { enabled: false, intervalMinutes: 1440, at: '' },
  );
});

test('decideSelfHostAutoUpdateReconcile maps configured state to an install/uninstall action', () => {
  assert.deepEqual(
    decideSelfHostAutoUpdateReconcile({ autoUpdate: true }, { fallbackIntervalMinutes: 1440 }),
    { action: 'install', enabled: true, intervalMinutes: 1440, at: '' },
  );
  assert.deepEqual(
    decideSelfHostAutoUpdateReconcile({ autoUpdate: false }, { fallbackIntervalMinutes: 1440 }),
    { action: 'uninstall', enabled: false, intervalMinutes: 1440, at: '' },
  );
  assert.deepEqual(
    decideSelfHostAutoUpdateReconcile({}, { fallbackIntervalMinutes: 1440 }),
    { action: 'uninstall', enabled: false, intervalMinutes: 1440, at: '' },
  );
});
