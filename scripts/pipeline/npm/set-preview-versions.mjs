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
 * @param {'cli' | 'stack' | 'server' | 'support'} packageKey
 */
function rollingProductIdForPackage(packageKey) {
  return packageKey === 'stack' ? 'hstack' : packageKey;
}

async function main() {
  const { values } = parseArgs({
    options: {
      'repo-root': { type: 'string', default: '' },
      'publish-cli': { type: 'string', default: 'false' },
      'publish-stack': { type: 'string', default: 'false' },
      'publish-server': { type: 'string', default: 'false' },
      'publish-support': { type: 'string', default: 'false' },
      'server-runner-dir': { type: 'string', default: 'packages/relay-server' },
      'cli-version': { type: 'string', default: '' },
      'stack-version': { type: 'string', default: '' },
      'server-version': { type: 'string', default: '' },
      'support-version': { type: 'string', default: '' },
      write: { type: 'string', default: 'true' },
    },
    allowPositionals: false,
  });

  const repoRoot = path.resolve(String(values['repo-root'] ?? '').trim() || process.cwd());
  const publishCli = parseBoolString(values['publish-cli'], '--publish-cli');
  const publishStack = parseBoolString(values['publish-stack'], '--publish-stack');
  const publishServer = parseBoolString(values['publish-server'], '--publish-server');
  const publishSupport = parseBoolString(values['publish-support'], '--publish-support');
  const serverRunnerDir = String(values['server-runner-dir'] ?? '').trim() || 'packages/relay-server';
  const shouldWrite = parseBoolString(values.write, '--write');
  const explicitVersions = {
    cli: String(values['cli-version'] ?? '').trim(),
    stack: String(values['stack-version'] ?? '').trim(),
    server: String(values['server-version'] ?? '').trim(),
    support: String(values['support-version'] ?? '').trim(),
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

  process.stdout.write(`${JSON.stringify(versions)}\n`);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
