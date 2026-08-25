import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { resolveTypeScriptCliInvocation } from '../../../../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidateProtocolTarball = process.env.CHANNELS_PROTOCOL_TARBALL ?? '';
const candidateSdkTarball = process.env.PLUGIN_SDK_TARBALL ?? '';
const hasCandidateTarballs = Boolean(candidateProtocolTarball && candidateSdkTarball);
const hasPartialCandidateConfiguration =
  Boolean(candidateProtocolTarball || candidateSdkTarball) && !hasCandidateTarballs;
const packFixture = await import('../scripts/pack-fixture.mjs');

async function readFixturePackageJson() {
  return JSON.parse(await readFile(join(fixtureRoot, 'package.json'), 'utf8'));
}

test('packed fixture archive excludes repository-only test tooling', async () => {
  const packageJson = await readFixturePackageJson();

  assert.deepEqual(packageJson.files, [
    '.happier-plugin/plugin.json',
    'assets',
    'src',
  ]);
});

test('public NodeNext authoring composes only the published Channels entrypoints', async () => {
  const source = (await Promise.all([
    readFile(join(fixtureRoot, 'test', 'public-authoring.ts'), 'utf8'),
    readFile(join(fixtureRoot, 'test', 'sdk-projection-contract.ts'), 'utf8'),
  ])).join('\n');
  const packageSpecifiers = [...new Set(
    [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/gu)]
      .map(([, specifier]) => specifier)
      .filter((specifier) => specifier.startsWith('@happier-dev/')),
  )].sort();

  assert.deepEqual(packageSpecifiers, [
    '@happier-dev/channels-protocol',
    '@happier-dev/channels-protocol/testing/v1',
    '@happier-dev/channels-protocol/v1',
    '@happier-dev/plugin-sdk',
    '@happier-dev/plugin-sdk/actions',
    '@happier-dev/plugin-sdk/automations',
    '@happier-dev/plugin-sdk/background-services',
    '@happier-dev/plugin-sdk/manifest',
    '@happier-dev/plugin-sdk/protocol',
    '@happier-dev/plugin-sdk/sessions',
  ]);
  assert.doesNotMatch(source, /@happier-dev\/(?:protocol|channels-contract)(?:\/|['"])/u);
});

test('packed authoring uses the canonical TypeScript owner in the clean consumer', () => {
  const consumerRoot = resolve('/candidate/clean consumer');
  const canonicalInvocation = resolveTypeScriptCliInvocation({
    processExecPath: process.execPath,
    workspaceDir: consumerRoot,
  });
  const invocation = packFixture.resolveFixtureTypeScriptInvocation({
    processExecPath: process.execPath,
    workspaceDir: consumerRoot,
  });

  assert.equal(invocation.command, canonicalInvocation.command);
  assert.deepEqual(invocation.argsPrefix, canonicalInvocation.argsPrefix);
  assert.match(invocation.argsPrefix[0], /\/node_modules\/@typescript\/native\//u);
});

test('packed runtime smoke rejects an archive manifest that drifts from source projection', () => {
  const smoke = packFixture.buildPackedEntrypointSmokeSource(
    'happier-out-of-tree-channel-socket-provider',
  );

  assert.match(smoke, /\.happier-plugin/u);
  assert.match(smoke, /isDeepStrictEqual/u);
  assert.match(smoke, /source projection/u);
  assert.match(smoke, /assertConversationProviderContributionV1/u);
});

test('packed fixture writes portable archive specifiers and invokes npm through the Windows-safe owner', () => {
  const protocolTarball = resolve('/candidate/Channels Protocol.tgz');
  const sdkTarball = resolve('/candidate/Plugin SDK.tgz');
  const fixtureArchive = resolve('/candidate/Fixture Provider.tgz');
  const packageJson = packFixture.buildFixtureConsumerPackageJson({
    protocolTarball,
    sdkTarball,
    fixtureArchive,
  });

  assert.equal(
    packageJson.dependencies['@happier-dev/channels-protocol'],
    pathToFileURL(protocolTarball).href,
  );
  assert.equal(
    packageJson.dependencies['@happier-dev/plugin-sdk'], pathToFileURL(sdkTarball).href);
  assert.equal(
    packageJson.dependencies['happier-out-of-tree-channel-socket-provider'],
    pathToFileURL(fixtureArchive).href,
  );
  assert.doesNotMatch(
    packageJson.dependencies['@happier-dev/channels-protocol'],
    /^file:\/[^/]/u,
  );
  // A release candidate is a prerelease version, which the provider archive's
  // ordinary registry ranges never accept. Without overrides npm resolves both
  // public packages from the registry and the candidate under test is never
  // installed, so the whole proof silently becomes a registry install.
  assert.deepEqual(packageJson.overrides, {
    '@happier-dev/channels-protocol': pathToFileURL(protocolTarball).href,
    '@happier-dev/plugin-sdk': pathToFileURL(sdkTarball).href,
  });

  const invocation = packFixture.resolveFixtureNpmInvocation(['pack', '--ignore-scripts'], {
    platform: 'win32',
    comspec: 'C:\\Windows\\System32\\cmd.exe',
  });
  assert.equal(invocation.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(invocation.windowsVerbatimArguments, true);
  assert.deepEqual(invocation.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.match(invocation.args[3], /npm\.cmd/u);
  assert.match(invocation.args[3], /pack/u);
});

test('packed fixture fails closed when candidate archives are missing', () => {
  const result = spawnSync(process.execPath, ['scripts/pack-fixture.mjs'], {
    cwd: fixtureRoot,
    env: {
      ...process.env,
      CHANNELS_PROTOCOL_TARBALL: '',
      PLUGIN_SDK_TARBALL: '',
    },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Set CHANNELS_PROTOCOL_TARBALL and PLUGIN_SDK_TARBALL/u);
});

test('packed external fixture refuses a half-supplied candidate instead of skipping', () => {
  // The only caller that supplies these archives binds both names at one call
  // site, so losing one of them is a rename away. Without this the packed proof
  // silently returns to a skip, which reads as green.
  assert.equal(
    hasPartialCandidateConfiguration,
    false,
    `exactly one candidate archive was supplied (CHANNELS_PROTOCOL_TARBALL=${JSON.stringify(candidateProtocolTarball)}, PLUGIN_SDK_TARBALL=${JSON.stringify(candidateSdkTarball)})`,
  );
});

test('packed external fixture installs the candidate public SDK and Channels protocol', { skip: !hasCandidateTarballs }, () => {
  const result = spawnSync(process.execPath, ['scripts/pack-fixture.mjs'], {
    cwd: fixtureRoot,
    env: process.env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
