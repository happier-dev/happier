import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseSelfHostInvocation,
  pickReleaseAsset,
  resolveMinisignBootstrapAsset,
  resolveSelfHostHealthTimeoutMs,
  resolveSelfHostDefaults,
  renderUpdaterLaunchdPlistXml,
  renderUpdaterScheduledTaskWrapperPs1,
  renderUpdaterSystemdUnit,
  renderServerEnvFile,
  renderServerServiceUnit,
  mergeEnvTextWithDefaults,
} from './self_host_runtime.mjs';

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
  }, /signature/i);
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

test('resolveMinisignBootstrapAsset maps platforms to trusted minisign assets', () => {
  assert.deepEqual(resolveMinisignBootstrapAsset({ platform: 'linux' }), {
    assetName: 'minisign-0.12-linux.tar.gz',
    sha256: '9a599b48ba6eb7b1e80f12f36b94ceca7c00b7a5173c95c3efc88d9822957e73',
  });
  assert.deepEqual(resolveMinisignBootstrapAsset({ platform: 'darwin' }), {
    assetName: 'minisign-0.12-macos.zip',
    sha256: '89000b19535765f9cffc65a65d64a820f433ef6db8020667f7570e06bf6aac63',
  });
  assert.deepEqual(resolveMinisignBootstrapAsset({ platform: 'win32' }), {
    assetName: 'minisign-0.12-win64.zip',
    sha256: '37b600344e20c19314b2e82813db2bfdcc408b77b876f7727889dbd46d539479',
  });
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
    workingDirectory: '/Users/me/.happier/self-host',
    stdoutPath: '/Users/me/.happier/self-host/logs/updater.out.log',
    stderrPath: '/Users/me/.happier/self-host/logs/updater.err.log',
  });

  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.doesNotMatch(plist, /<key>KeepAlive<\/key>/);
  assert.match(plist, /<key>PATH<\/key>/);
  assert.match(plist, /<string>\/Users\/me\/\.happier\/bin\/hstack<\/string>/);
  assert.match(plist, /<string>self-host<\/string>/);
  assert.match(plist, /<string>update<\/string>/);
  assert.match(plist, /<string>--channel=preview<\/string>/);
  assert.match(plist, /<string>--mode=user<\/string>/);
  assert.match(plist, /<string>--non-interactive<\/string>/);
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
