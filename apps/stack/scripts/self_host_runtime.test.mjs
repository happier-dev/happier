import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseSelfHostInvocation,
  pickReleaseAsset,
  renderServerEnvFile,
  renderServerServiceUnit,
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

test('renderServerEnvFile emits sqlite/local defaults for self-host mode', () => {
  const envText = renderServerEnvFile({
    port: 3005,
    host: '127.0.0.1',
    dataDir: '/var/lib/happier',
    filesDir: '/var/lib/happier/files',
    dbDir: '/var/lib/happier/pglite',
  });
  assert.match(envText, /PORT=3005/);
  assert.match(envText, /HAPPIER_DB_PROVIDER=sqlite/);
  assert.match(envText, /HAPPIER_FILES_BACKEND=local/);
  assert.match(envText, /HAPPIER_SERVER_LIGHT_DATA_DIR=\/var\/lib\/happier/);
  assert.match(envText, /HAPPIER_SERVER_LIGHT_FILES_DIR=\/var\/lib\/happier\/files/);
  assert.match(envText, /HAPPIER_SERVER_LIGHT_DB_DIR=\/var\/lib\/happier\/pglite/);
});
