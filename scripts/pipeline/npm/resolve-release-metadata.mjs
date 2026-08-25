#!/usr/bin/env node

// @ts-check

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const VERSION_PATTERNS = Object.freeze({
  production: /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/,
  preview: /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-preview\.(?:[1-9]\d*)(?:\.(?:[1-9]\d*))?$/,
});

const RELEASE_PACKAGE_FIELDS = Object.freeze({
  cli: 'cli',
  stack: 'stack',
  server: 'server',
  pluginSdk: 'plugin_sdk',
  sdk: 'sdk',
  channelsProtocol: 'channels_protocol',
});

/** @param {unknown} value @param {string} name */
function parseBoolean(value, name) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

/** @param {string} version @param {string} productId @param {'preview' | 'production'} channel */
function validateVersion(version, productId, channel) {
  if (version.includes('\n') || version.includes('\r') || !VERSION_PATTERNS[channel].test(version)) {
    throw new Error(`npm release metadata rejected non-canonical ${productId} version`);
  }
  return version;
}

/**
 * Validate and shape source/package metadata before it crosses the workflow
 * output boundary.  Keeping this pure lets workflow callers and local dry-runs
 * use the identical contract.
 *
 * @param {{
 *   channel: 'preview' | 'production';
 *   sourceRef: string;
 *   sha: string;
 *   npmTag: string;
 *   versions: Partial<Record<'cli' | 'stack' | 'server' | 'pluginSdk' | 'sdk' | 'channelsProtocol', string>>;
 *   requested: Record<'cli' | 'stack' | 'server' | 'pluginSdk' | 'sdk' | 'channelsProtocol', boolean>;
 * }} input
 */
export function resolveNpmReleaseMetadata(input) {
  const channel = String(input.channel ?? '');
  if (channel !== 'preview' && channel !== 'production') {
    throw new Error(`npm release metadata rejected unsupported channel '${channel || '<empty>'}'`);
  }
  const sourceRef = String(input.sourceRef ?? '').trim();
  const expectedSourceRef = channel === 'preview' ? 'preview' : 'main';
  if (sourceRef !== expectedSourceRef) {
    throw new Error(`npm release metadata rejected ${channel} source ref '${sourceRef}'`);
  }
  const sha = String(input.sha ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error('npm release metadata rejected an invalid source SHA');
  }
  const npmTag = String(input.npmTag ?? '').trim();
  const expectedTag = channel === 'preview' ? 'next' : 'latest';
  if (npmTag !== expectedTag) {
    throw new Error(`npm release metadata rejected npm tag '${npmTag}' for ${channel}`);
  }

  /** @type {Record<string, string>} */
  const versions = {};
  for (const [key, productId] of Object.entries(RELEASE_PACKAGE_FIELDS)) {
    if (!input.requested[key]) continue;
    const version = String(input.versions[key] ?? '');
    versions[key] = validateVersion(version, productId, /** @type {'preview' | 'production'} */ (channel));
  }
  return { sha, sourceRef, channel, npmTag, versions };
}

/** @param {string} repoRoot @param {string} packageJsonPath */
function readPackageVersion(repoRoot, packageJsonPath) {
  const manifestPath = path.resolve(repoRoot, packageJsonPath);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const version = String(manifest.version ?? '').trim();
  if (!version) throw new Error(`package.json missing version: ${manifestPath}`);
  return version;
}

/** @param {string} repoRoot @param {Record<string, boolean>} requested @param {string} serverRunnerDir */
function readProductionVersions(repoRoot, requested, serverRunnerDir) {
  /** @type {Record<string, string>} */
  const versions = {};
  if (requested.cli) versions.cli = readPackageVersion(repoRoot, 'apps/cli/package.json');
  if (requested.stack) versions.stack = readPackageVersion(repoRoot, 'apps/stack/package.json');
  if (requested.server) versions.server = readPackageVersion(repoRoot, path.join(serverRunnerDir, 'package.json'));
  if (requested.pluginSdk) {
    const sdkVersion = readPackageVersion(repoRoot, 'packages/plugin-sdk/package.json');
    const uiVersion = readPackageVersion(repoRoot, 'packages/plugin-ui/package.json');
    if (sdkVersion !== uiVersion) {
      throw new Error(`plugin-sdk and plugin-ui must be version-equal (got ${sdkVersion} and ${uiVersion})`);
    }
    versions.pluginSdk = sdkVersion;
  }
  if (requested.sdk) versions.sdk = readPackageVersion(repoRoot, 'packages/sdk/package.json');
  if (requested.channelsProtocol) {
    versions.channelsProtocol = readPackageVersion(repoRoot, 'packages/channels-protocol/package.json');
  }
  return versions;
}

/** @param {string} repoRoot @param {Record<string, boolean>} requested @param {string} serverRunnerDir */
function readPreviewVersions(repoRoot, requested, serverRunnerDir) {
  const args = [
    path.join(repoRoot, 'scripts/pipeline/run.mjs'),
    'npm-set-preview-versions',
    '--publish-cli',
    String(requested.cli),
    '--publish-stack',
    String(requested.stack),
    '--publish-server',
    String(requested.server),
    '--publish-plugin-sdk',
    String(requested.pluginSdk),
    '--publish-sdk',
    String(requested.sdk),
    '--publish-channels-protocol',
    String(requested.channelsProtocol),
    '--server-runner-dir',
    serverRunnerDir,
    '--write',
    'false',
  ];
  const raw = execFileSync(process.execPath, args, {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`npm-set-preview-versions returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function main() {
  const { values } = parseArgs({
    options: {
      channel: { type: 'string' },
      'source-ref': { type: 'string' },
      'npm-tag': { type: 'string' },
      'publish-cli': { type: 'string', default: 'false' },
      'publish-stack': { type: 'string', default: 'false' },
      'publish-server': { type: 'string', default: 'false' },
      'publish-plugin-sdk': { type: 'string', default: 'false' },
      'publish-sdk': { type: 'string', default: 'false' },
      'publish-channels-protocol': { type: 'string', default: 'false' },
      'server-runner-dir': { type: 'string', default: 'packages/relay-server' },
      'github-output': { type: 'string', default: '' },
    },
    allowPositionals: false,
  });

  const channel = String(values.channel ?? '').trim();
  if (channel !== 'preview' && channel !== 'production') {
    throw new Error(`--channel must be preview or production (got '${channel || '<empty>'}')`);
  }
  const requested = {
    cli: parseBoolean(values['publish-cli'], '--publish-cli'),
    stack: parseBoolean(values['publish-stack'], '--publish-stack'),
    server: parseBoolean(values['publish-server'], '--publish-server'),
    pluginSdk: parseBoolean(values['publish-plugin-sdk'], '--publish-plugin-sdk'),
    sdk: parseBoolean(values['publish-sdk'], '--publish-sdk'),
    channelsProtocol: parseBoolean(values['publish-channels-protocol'], '--publish-channels-protocol'),
  };
  const repoRoot = process.cwd();
  const serverRunnerDir = String(values['server-runner-dir'] ?? '').trim() || 'packages/relay-server';
  const versions = channel === 'preview'
    ? readPreviewVersions(repoRoot, requested, serverRunnerDir)
    : readProductionVersions(repoRoot, requested, serverRunnerDir);
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const result = resolveNpmReleaseMetadata({
    channel,
    sourceRef: String(values['source-ref'] ?? ''),
    sha,
    npmTag: String(values['npm-tag'] ?? ''),
    versions,
    requested,
  });

  const githubOutput = String(values['github-output'] ?? '').trim();
  if (githubOutput) {
    const outputs = [
      `sha=${result.sha}`,
      `source_ref=${result.sourceRef}`,
      `channel=${result.channel}`,
      `npm_tag=${result.npmTag}`,
      ...Object.entries(result.versions).map(([key, version]) => `${RELEASE_PACKAGE_FIELDS[key]}_version=${version}`),
    ];
    appendFileSync(githubOutput, `${outputs.join('\n')}\n`, 'utf8');
    return;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
