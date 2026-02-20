// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

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

function main() {
  const { values } = parseArgs({
    options: {
      'repo-root': { type: 'string', default: '' },
      'publish-cli': { type: 'string', default: 'false' },
      'publish-stack': { type: 'string', default: 'false' },
      'publish-server': { type: 'string', default: 'false' },
      'server-runner-dir': { type: 'string', default: 'packages/relay-server' },
      write: { type: 'string', default: 'true' },
    },
    allowPositionals: false,
  });

  const repoRoot = path.resolve(String(values['repo-root'] ?? '').trim() || process.cwd());
  const publishCli = parseBoolString(values['publish-cli'], '--publish-cli');
  const publishStack = parseBoolString(values['publish-stack'], '--publish-stack');
  const publishServer = parseBoolString(values['publish-server'], '--publish-server');
  const serverRunnerDir = String(values['server-runner-dir'] ?? '').trim() || 'packages/relay-server';
  const shouldWrite = parseBoolString(values.write, '--write');

  const runRaw = String(process.env.GITHUB_RUN_NUMBER ?? '').trim();
  const attemptRaw = String(process.env.GITHUB_RUN_ATTEMPT ?? '').trim();

  const runNumber = runRaw ? Number(runRaw) : NaN;
  const attemptNumber = attemptRaw ? Number(attemptRaw) : NaN;

  const run = Number.isFinite(runNumber) ? Math.max(0, Math.floor(runNumber)) : Math.floor(Date.now() / 1000);
  const attempt = Number.isFinite(attemptNumber) ? Math.max(1, Math.floor(attemptNumber)) : Math.max(1, Math.floor(process.pid));

  /** @type {Record<string, string>} */
  const versions = {};

  if (publishCli) {
    const base = normalizeBase(readPackageVersion(repoRoot, path.join('apps', 'cli', 'package.json')));
    versions.cli = `${base}-preview.${run}.${attempt}`;
    if (shouldWrite) {
      writePackageVersion(repoRoot, path.join('apps', 'cli', 'package.json'), versions.cli);
    }
  }

  if (publishStack) {
    const base = normalizeBase(readPackageVersion(repoRoot, path.join('apps', 'stack', 'package.json')));
    versions.stack = `${base}-preview.${run}.${attempt}`;
    if (shouldWrite) {
      writePackageVersion(repoRoot, path.join('apps', 'stack', 'package.json'), versions.stack);
    }
  }

  if (publishServer) {
    if (!serverRunnerDir) fail('--server-runner-dir is required when --publish-server true');
    const base = normalizeBase(readPackageVersion(repoRoot, path.join(serverRunnerDir, 'package.json')));
    versions.server = `${base}-preview.${run}.${attempt}`;
    if (shouldWrite) {
      writePackageVersion(repoRoot, path.join(serverRunnerDir, 'package.json'), versions.server);
    }
  }

  process.stdout.write(`${JSON.stringify(versions)}\n`);
}

main();
