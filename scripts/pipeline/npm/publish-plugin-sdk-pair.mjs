#!/usr/bin/env node

// @ts-check

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { admitNpmPublication } from '../release/admit-release.mjs';

function fail(message) {
  throw new Error(message);
}

function normalizeTag(value, name) {
  const tag = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(tag)) {
    fail(`${name} must be a bounded npm dist-tag`);
  }
  return tag;
}

function readTarballIdentity(tarballPath) {
  let raw;
  try {
    raw = execFileSync('tar', ['-xOf', tarballPath, 'package/package.json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
  } catch (error) {
    fail(`Unable to read plugin SDK pair tarball metadata: ${error instanceof Error ? error.message : String(error)}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(String(raw));
  } catch (error) {
    fail(`Plugin SDK pair tarball package.json is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const name = String(manifest?.name ?? '').trim();
  const version = String(manifest?.version ?? '').trim();
  if (!name || !version) fail('Plugin SDK pair tarballs must include a package name and version');
  return { name, version };
}

/** @param {string} directory */
function resolvePairTarballsFromDirectory(directory) {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    fail(`--tarball-dir must be an existing directory (got '${directory}')`);
  }
  const tarballs = readdirSync(directory)
    .filter((entry) => entry.endsWith('.tgz'))
    .map((entry) => path.join(directory, entry))
    .filter((entry) => statSync(entry).isFile())
    .sort((left, right) => left.localeCompare(right));
  if (tarballs.length !== 2) {
    fail(`--tarball-dir must contain exactly the two plugin SDK pair tarballs (found ${tarballs.length})`);
  }
  /** @type {Record<string, string>} */
  const pathsByPackage = {};
  for (const tarball of tarballs) {
    const identity = readTarballIdentity(tarball);
    if (!['@happier-dev/plugin-sdk', '@happier-dev/plugin-ui'].includes(identity.name) || pathsByPackage[identity.name]) {
      fail('--tarball-dir must contain one plugin-sdk tarball and one plugin-ui tarball');
    }
    pathsByPackage[identity.name] = tarball;
  }
  const sdkTarball = pathsByPackage['@happier-dev/plugin-sdk'];
  const uiTarball = pathsByPackage['@happier-dev/plugin-ui'];
  if (!sdkTarball || !uiTarball) {
    fail('--tarball-dir must contain one plugin-sdk tarball and one plugin-ui tarball');
  }
  return { sdkTarball, uiTarball };
}

function invokeCanonicalPublisher({ repoRoot, channel, tarball, tag, dryRun, githubOutput, npmVersion, authorizedSha }) {
  const publisher = path.join(repoRoot, 'scripts', 'pipeline', 'npm', 'publish-tarball.mjs');
  const args = [
    publisher,
    '--channel', channel,
    '--tarball', tarball,
    '--tag', tag,
    ...(npmVersion !== '' ? ['--npm-version', npmVersion] : ['--npm-version', '']),
    ...(authorizedSha ? ['--authorized-sha', authorizedSha] : []),
    ...(githubOutput ? ['--github-output', githubOutput] : []),
  ];
  const printable = `node ${path.relative(repoRoot, publisher)} --channel ${channel} --tarball ${tarball} --tag ${tag}`;
  if (dryRun) {
    process.stdout.write(`[dry-run] ${printable}\n`);
    return;
  }
  execFileSync(process.execPath, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
    timeout: 10 * 60_000,
  });
}

/** @param {string} outputPath @param {{ name: string; version: string }} expected */
function readPublishedIdentity(outputPath, expected) {
  const values = Object.create(null);
  const output = readFileSync(outputPath, 'utf8');
  for (const line of output.split(/\r?\n/u)) {
    if (!line) continue;
    const index = line.indexOf('=');
    if (index < 1) fail('Canonical publisher emitted an invalid package identity output');
    const key = line.slice(0, index);
    const value = line.slice(index + 1);
    if (!/^(?:package|version|integrity)$/u.test(key) || Object.hasOwn(values, key) || !value || /[\r\n]/u.test(value)) {
      fail('Canonical publisher emitted an unsafe package identity output');
    }
    values[key] = value;
  }
  if (values.package !== expected.name || values.version !== expected.version || !/^sha512-[A-Za-z0-9+/=]+$/u.test(values.integrity ?? '')) {
    fail('Canonical publisher did not verify the expected plugin SDK pair identity');
  }
  return { package: values.package, version: values.version, integrity: values.integrity };
}

/** @param {string} outputPath @param {{ package: string; version: string; integrity: string }} sdk @param {{ package: string; version: string; integrity: string }} ui */
function writePairPublicationOutput(outputPath, sdk, ui) {
  if (!outputPath) return;
  appendFileSync(outputPath, [
    `plugin_sdk_package=${sdk.package}`,
    `plugin_sdk_version=${sdk.version}`,
    `plugin_sdk_integrity=${sdk.integrity}`,
    `plugin_ui_package=${ui.package}`,
    `plugin_ui_version=${ui.version}`,
    `plugin_ui_integrity=${ui.integrity}`,
    '',
  ].join('\n'), 'utf8');
}

function main() {
  const { values } = parseArgs({
    options: {
      channel: { type: 'string' },
      'sdk-tarball': { type: 'string' },
      'ui-tarball': { type: 'string' },
      'tarball-dir': { type: 'string', default: '' },
      tag: { type: 'string', default: '' },
      'staging-tag': { type: 'string', default: '' },
      'npm-version': { type: 'string', default: '11.5.1' },
      'github-output': { type: 'string', default: '' },
      'authorized-sha': { type: 'string', default: '' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  const channel = String(values.channel ?? '').trim();
  if (channel !== 'preview' && channel !== 'production') {
    fail(`--channel must be preview or production (got '${channel || '<empty>'}')`);
  }
  const sdkTarballInput = String(values['sdk-tarball'] ?? '').trim();
  const uiTarballInput = String(values['ui-tarball'] ?? '').trim();
  const tarballDirInput = String(values['tarball-dir'] ?? '').trim();
  if (tarballDirInput && (sdkTarballInput || uiTarballInput)) {
    fail('--tarball-dir cannot be combined with --sdk-tarball or --ui-tarball');
  }
  if (!tarballDirInput && (!sdkTarballInput || !uiTarballInput)) {
    fail('Either --tarball-dir or both --sdk-tarball and --ui-tarball are required');
  }
  const fromDirectory = tarballDirInput ? resolvePairTarballsFromDirectory(path.resolve(tarballDirInput)) : null;
  const sdkTarball = fromDirectory?.sdkTarball ?? path.resolve(sdkTarballInput);
  const uiTarball = fromDirectory?.uiTarball ?? path.resolve(uiTarballInput);
  const finalTag = normalizeTag(values.tag || (channel === 'preview' ? 'next' : 'latest'), '--tag');
  const stagingTag = normalizeTag(values['staging-tag'] || `${finalTag}-staging`, '--staging-tag');
  const npmVersion = String(values['npm-version'] ?? '').trim();
  const githubOutput = String(values['github-output'] ?? '').trim();
  const authorizedSha = String(values['authorized-sha'] ?? '').trim();
  const dryRun = values['dry-run'] === true;
  const repoRoot = path.resolve(process.cwd());
  let identities = null;

  if (!dryRun) {
    if (!existsSync(sdkTarball) || !existsSync(uiTarball)) {
      fail('Plugin SDK pair tarballs must exist before publication');
    }
    const sdk = readTarballIdentity(sdkTarball);
    const ui = readTarballIdentity(uiTarball);
    if (sdk.name !== '@happier-dev/plugin-sdk' || ui.name !== '@happier-dev/plugin-ui') {
      fail(`Plugin SDK pair has unexpected package names (${sdk.name}, ${ui.name})`);
    }
    if (sdk.version !== ui.version) {
      fail(`Plugin SDK pair tarballs must share an exact version (got ${sdk.version} and ${ui.version})`);
    }
    identities = { sdk, ui };
    admitNpmPublication({
      mode: 'pack+publish',
      dryRun: false,
      authorizedSha,
      packageNames: [sdk.name, ui.name],
    });
  }

  // The existing publisher owns npm integrity verification and idempotent tag
  // repair. This owner only sequences the lockstep pair: stage both immutable
  // tarballs first, then make the public tag visible SDK-first.
  const outputDirectory = dryRun ? '' : mkdtempSync(path.join(tmpdir(), 'happier-plugin-sdk-pair-publish-'));
  try {
    for (const [tarball, tag, output] of [
      [sdkTarball, stagingTag, ''],
      [uiTarball, stagingTag, ''],
      [sdkTarball, finalTag, outputDirectory ? path.join(outputDirectory, 'plugin-sdk') : ''],
      [uiTarball, finalTag, outputDirectory ? path.join(outputDirectory, 'plugin-ui') : ''],
    ]) {
      invokeCanonicalPublisher({
        repoRoot,
        channel,
        tarball,
        tag,
        dryRun,
        githubOutput: output,
        npmVersion,
        authorizedSha,
      });
    }
    if (identities) {
      const sdk = readPublishedIdentity(path.join(outputDirectory, 'plugin-sdk'), identities.sdk);
      const ui = readPublishedIdentity(path.join(outputDirectory, 'plugin-ui'), identities.ui);
      writePairPublicationOutput(githubOutput, sdk, ui);
    }
  } finally {
    if (outputDirectory) rmSync(outputDirectory, { recursive: true, force: true });
  }
}

main();
