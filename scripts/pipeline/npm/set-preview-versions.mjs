// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { resolveRollingPublishVersion } from '../release/lib/rolling-version-allocation.mjs';

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * @param {unknown} value
 * @param {string} name
 */
function parseBoolString(value, name) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  fail(`${name} must be 'true' or 'false' (got: ${value})`);
}

/**
 * @param {string} version
 */
function normalizeBase(version) {
  const m = String(version ?? '')
    .trim()
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) fail(`Invalid version: ${version}`);
  return `${m[1]}.${m[2]}.${m[3]}`;
}

/**
 * The source packages remain held at 0.0.0 until a release candidate bumps
 * them. Preview packing nevertheless begins the public Developer Preview on
 * the approved 0.1.0 line.
 * @param {string} version
 */
function normalizePublicSdkPreviewBase(version) {
  const base = normalizeBase(version);
  return base === '0.0.0' ? '0.1.0' : base;
}

/**
 * @param {string} repoRoot
 * @param {string} pkgPath
 * @param {string} nextVersion
 */
function writePackageVersion(repoRoot, pkgPath, nextVersion) {
  const abs = path.resolve(repoRoot, pkgPath);
  const parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
  parsed.version = nextVersion;
  fs.writeFileSync(abs, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
}

/**
 * @param {string} repoRoot
 * @param {string} pkgPath
 */
function readPackageVersion(repoRoot, pkgPath) {
  const abs = path.resolve(repoRoot, pkgPath);
  const parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const version = String(parsed?.version ?? '').trim();
  if (!version) fail(`package.json missing version: ${path.relative(repoRoot, abs)}`);
  return version;
}

/**
 * @param {'cli' | 'stack' | 'server' | 'support' | 'pluginSdk' | 'sdk' | 'channelsProtocol'} packageKey
 */
function rollingProductIdForPackage(packageKey) {
  if (packageKey === 'stack') return 'hstack';
  if (packageKey === 'pluginSdk') return 'plugin_sdk';
  if (packageKey === 'channelsProtocol') return 'channels_protocol';
  return packageKey;
}

async function main() {
  const { values } = parseArgs({
    options: {
      'repo-root': { type: 'string', default: '' },
      'publish-cli': { type: 'string', default: 'false' },
      'publish-stack': { type: 'string', default: 'false' },
      'publish-server': { type: 'string', default: 'false' },
      'publish-support': { type: 'string', default: 'false' },
      'publish-plugin-sdk': { type: 'string', default: 'false' },
      'publish-sdk': { type: 'string', default: 'false' },
      'publish-channels-protocol': { type: 'string', default: 'false' },
      'server-runner-dir': { type: 'string', default: 'packages/relay-server' },
      'cli-version': { type: 'string', default: '' },
      'stack-version': { type: 'string', default: '' },
      'server-version': { type: 'string', default: '' },
      'support-version': { type: 'string', default: '' },
      'plugin-sdk-version': { type: 'string', default: '' },
      'sdk-version': { type: 'string', default: '' },
      'channels-protocol-version': { type: 'string', default: '' },
      write: { type: 'string', default: 'true' },
    },
    allowPositionals: false,
  });

  const repoRoot = path.resolve(String(values['repo-root'] ?? '').trim() || process.cwd());
  const publishCli = parseBoolString(values['publish-cli'], '--publish-cli');
  const publishStack = parseBoolString(values['publish-stack'], '--publish-stack');
  const publishServer = parseBoolString(values['publish-server'], '--publish-server');
  const publishSupport = parseBoolString(values['publish-support'], '--publish-support');
  const publishPluginSdk = parseBoolString(values['publish-plugin-sdk'], '--publish-plugin-sdk');
  const publishSdk = parseBoolString(values['publish-sdk'], '--publish-sdk');
  const publishChannelsProtocol = parseBoolString(values['publish-channels-protocol'], '--publish-channels-protocol');
  const serverRunnerDir = String(values['server-runner-dir'] ?? '').trim() || 'packages/relay-server';
  const shouldWrite = parseBoolString(values.write, '--write');
  const explicitVersions = {
    cli: String(values['cli-version'] ?? '').trim(),
    stack: String(values['stack-version'] ?? '').trim(),
    server: String(values['server-version'] ?? '').trim(),
    support: String(values['support-version'] ?? '').trim(),
    pluginSdk: String(values['plugin-sdk-version'] ?? '').trim(),
    sdk: String(values['sdk-version'] ?? '').trim(),
    channelsProtocol: String(values['channels-protocol-version'] ?? '').trim(),
  };

  /** @type {Record<string, string>} */
  const versions = {};

  if (publishCli) {
    const base = normalizeBase(readPackageVersion(repoRoot, path.join('apps', 'cli', 'package.json')));
    versions.cli = (
      await resolveRollingPublishVersion({
        repoRoot,
        productId: rollingProductIdForPackage('cli'),
        channel: 'preview',
        baseVersion: base,
        explicitVersion: explicitVersions.cli,
        publishSurface: 'npm',
        env: process.env,
      })
    ).version;
    if (shouldWrite) {
      writePackageVersion(repoRoot, path.join('apps', 'cli', 'package.json'), versions.cli);
    }
  }

  if (publishStack) {
    const base = normalizeBase(readPackageVersion(repoRoot, path.join('apps', 'stack', 'package.json')));
    versions.stack = (
      await resolveRollingPublishVersion({
        repoRoot,
        productId: rollingProductIdForPackage('stack'),
        channel: 'preview',
        baseVersion: base,
        explicitVersion: explicitVersions.stack,
        publishSurface: 'npm',
        env: process.env,
      })
    ).version;
    if (shouldWrite) {
      writePackageVersion(repoRoot, path.join('apps', 'stack', 'package.json'), versions.stack);
    }
  }

  if (publishServer) {
    if (!serverRunnerDir) fail('--server-runner-dir is required when --publish-server true');
    const base = normalizeBase(readPackageVersion(repoRoot, path.join(serverRunnerDir, 'package.json')));
    versions.server = (
      await resolveRollingPublishVersion({
        repoRoot,
        productId: rollingProductIdForPackage('server'),
        channel: 'preview',
        baseVersion: base,
        explicitVersion: explicitVersions.server,
        publishSurface: 'npm',
        env: process.env,
      })
    ).version;
    if (shouldWrite) {
      writePackageVersion(repoRoot, path.join(serverRunnerDir, 'package.json'), versions.server);
    }
  }

  if (publishSupport) {
    const base = normalizeBase(readPackageVersion(repoRoot, path.join('packages', 'support', 'package.json')));
    versions.support = (
      await resolveRollingPublishVersion({
        repoRoot,
        productId: rollingProductIdForPackage('support'),
        channel: 'preview',
        baseVersion: base,
        explicitVersion: explicitVersions.support,
        publishSurface: 'npm',
        env: process.env,
      })
    ).version;
    if (shouldWrite) {
      writePackageVersion(repoRoot, path.join('packages', 'support', 'package.json'), versions.support);
    }
  }

  if (publishPluginSdk) {
    const pluginSdkPath = path.join('packages', 'plugin-sdk', 'package.json');
    const pluginUiPath = path.join('packages', 'plugin-ui', 'package.json');
    const pluginSdkVersion = readPackageVersion(repoRoot, pluginSdkPath);
    const pluginUiVersion = readPackageVersion(repoRoot, pluginUiPath);
    if (pluginSdkVersion !== pluginUiVersion) {
      fail(`plugin-sdk and plugin-ui must be version-equal (got ${pluginSdkVersion} and ${pluginUiVersion})`);
    }
    const base = normalizePublicSdkPreviewBase(pluginSdkVersion);
    versions.pluginSdk = (
      await resolveRollingPublishVersion({
        repoRoot,
        productId: rollingProductIdForPackage('pluginSdk'),
        channel: 'preview',
        baseVersion: base,
        explicitVersion: explicitVersions.pluginSdk,
        publishSurface: 'npm',
        env: process.env,
      })
    ).version;
    if (shouldWrite) {
      writePackageVersion(repoRoot, pluginSdkPath, versions.pluginSdk);
      writePackageVersion(repoRoot, pluginUiPath, versions.pluginSdk);
    }
  }

  if (publishSdk) {
    const packagePath = path.join('packages', 'sdk', 'package.json');
    const base = normalizePublicSdkPreviewBase(readPackageVersion(repoRoot, packagePath));
    versions.sdk = (
      await resolveRollingPublishVersion({
        repoRoot,
        productId: rollingProductIdForPackage('sdk'),
        channel: 'preview',
        baseVersion: base,
        explicitVersion: explicitVersions.sdk,
        publishSurface: 'npm',
        env: process.env,
      })
    ).version;
    if (shouldWrite) {
      writePackageVersion(repoRoot, packagePath, versions.sdk);
    }
  }

  if (publishChannelsProtocol) {
    const packagePath = path.join('packages', 'channels-protocol', 'package.json');
    const base = normalizePublicSdkPreviewBase(readPackageVersion(repoRoot, packagePath));
    versions.channelsProtocol = (
      await resolveRollingPublishVersion({
        repoRoot,
        productId: rollingProductIdForPackage('channelsProtocol'),
        channel: 'preview',
        baseVersion: base,
        explicitVersion: explicitVersions.channelsProtocol,
        publishSurface: 'npm',
        env: process.env,
      })
    ).version;
    if (shouldWrite) {
      writePackageVersion(repoRoot, packagePath, versions.channelsProtocol);
    }
  }

  process.stdout.write(`${JSON.stringify(versions)}\n`);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
