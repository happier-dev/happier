#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveNpmCommandInvocation } from '../../../../../../scripts/workspaces/execYarnCommand.mjs';
import { resolveTypeScriptCliInvocation } from '../../../../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(fixtureRoot, '../../../../..');
const CHANNELS_PROTOCOL_PACKAGE_NAME = '@happier-dev/channels-protocol';
const PLUGIN_SDK_PACKAGE_NAME = '@happier-dev/plugin-sdk';

function archiveFileSpecifier(archivePath) {
  return pathToFileURL(resolve(archivePath)).href;
}

export function buildFixtureConsumerPackageJson({
  protocolTarball,
  sdkTarball,
  fixtureArchive,
}) {
  return {
    name: 'happier-channel-fixture-consumer',
    private: true,
    type: 'module',
    dependencies: {
      [CHANNELS_PROTOCOL_PACKAGE_NAME]: archiveFileSpecifier(protocolTarball),
      [PLUGIN_SDK_PACKAGE_NAME]: archiveFileSpecifier(sdkTarball),
      'happier-out-of-tree-channel-socket-provider': archiveFileSpecifier(fixtureArchive),
    },
  };
}

export function resolveFixtureNpmInvocation(args, options = {}) {
  return resolveNpmCommandInvocation(args, {
    platform: options.platform,
    comspec: options.comspec,
    npmExecPath: options.npmExecPath,
    processExecPath: options.processExecPath,
  });
}

export function resolveFixtureTypeScriptInvocation(options = {}) {
  return resolveTypeScriptCliInvocation({
    repoRoot: options.repoRoot ?? repositoryRoot,
    workspaceDir: options.workspaceDir,
    processExecPath: options.processExecPath ?? process.execPath,
  });
}

function pathIsInside(rootPath, candidatePath) {
  const relativePath = relative(resolve(rootPath), resolve(candidatePath));
  return relativePath === ''
    || (!isAbsolute(relativePath) && relativePath !== '..'
      && !relativePath.startsWith('../') && !relativePath.startsWith('..\\'));
}

function runNpmCommand(args, options) {
  const invocation = resolveFixtureNpmInvocation(args, {
    npmExecPath: process.env.npm_execpath,
    processExecPath: process.execPath,
  });
  return execFileSync(invocation.command, invocation.args, {
    ...options,
    ...(invocation.windowsVerbatimArguments
      ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
      : {}),
  });
}

function runTypeScriptCommand(args, { cwd, ...options }) {
  const invocation = resolveFixtureTypeScriptInvocation({ workspaceDir: cwd });
  return execFileSync(invocation.command, [...invocation.argsPrefix, ...args], {
    cwd,
    ...options,
  });
}

async function typecheckPackedPublicAuthoring(consumerRoot) {
  const [publicAuthoringSource, sdkProjectionContractSource, publicAuthoringTsconfig] = await Promise.all([
    readFile(join(fixtureRoot, 'test', 'public-authoring.ts'), 'utf8'),
    readFile(join(fixtureRoot, 'test', 'sdk-projection-contract.ts'), 'utf8'),
    readFile(join(fixtureRoot, 'tsconfig.public.json'), 'utf8'),
  ]);
  const authoringTestRoot = join(consumerRoot, 'test');
  await mkdir(authoringTestRoot, { recursive: true });
  await Promise.all([
    writeFile(join(authoringTestRoot, 'public-authoring.ts'), publicAuthoringSource),
    writeFile(join(authoringTestRoot, 'sdk-projection-contract.ts'), sdkProjectionContractSource),
    writeFile(join(consumerRoot, 'tsconfig.public.json'), publicAuthoringTsconfig),
  ]);
  runTypeScriptCommand(['--noEmit', '-p', 'tsconfig.public.json'], {
    cwd: consumerRoot,
    stdio: 'inherit',
  });
}

async function assertInstalledPackage({ consumerRoot, packageName }) {
  const packageRoot = join(consumerRoot, 'node_modules', ...packageName.split('/'));
  const stats = await lstat(packageRoot);
  const [physicalConsumerRoot, physicalPackageRoot] = await Promise.all([
    realpath(consumerRoot),
    realpath(packageRoot),
  ]);
  if (!stats.isDirectory() || stats.isSymbolicLink() || !pathIsInside(physicalConsumerRoot, physicalPackageRoot)) {
    throw new Error(`packed fixture resolved ${packageName} through a non-installed package path`);
  }
  const installedPackageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  if (installedPackageJson.name !== packageName) {
    throw new Error(`packed fixture installed an unexpected package identity for ${packageName}`);
  }
}

export function buildPackedEntrypointSmokeSource(packageName) {
  return [
    `const pluginSdk = await import(${JSON.stringify(PLUGIN_SDK_PACKAGE_NAME)});`,
    `const channelsProtocol = await import(${JSON.stringify(CHANNELS_PROTOCOL_PACKAGE_NAME)});`,
    `const channelsProtocolV1 = await import(${JSON.stringify(`${CHANNELS_PROTOCOL_PACKAGE_NAME}/v1`)});`,
    `const channelsProtocolTestingV1 = await import(${JSON.stringify(`${CHANNELS_PROTOCOL_PACKAGE_NAME}/testing/v1`)});`,
    `const plugin = await import(${JSON.stringify(packageName)});`,
    "const { readFile } = await import('node:fs/promises');",
    "const { join } = await import('node:path');",
    "const { isDeepStrictEqual } = await import('node:util');",
    `const pluginRoot = join(process.cwd(), 'node_modules', ...${JSON.stringify(packageName.split('/'))});`,
    "const committedManifest = JSON.parse(await readFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), 'utf8'));",
    "const sourceManifest = JSON.parse(JSON.stringify(plugin.manifest));",
    "if (typeof pluginSdk.definePlugin !== 'function') throw new Error('packed fixture SDK root did not load');",
    "if (typeof channelsProtocol.ConversationProviderSetupResultV1Schema?.parse !== 'function') throw new Error('packed fixture Channels protocol root did not load');",
    "if (typeof channelsProtocolV1.ConversationProviderSetupResultV1Schema?.parse !== 'function') throw new Error('packed fixture Channels protocol V1 did not load');",
    "if (typeof channelsProtocolTestingV1.createConversationProviderSetupResultV1Fixture !== 'function') throw new Error('packed fixture Channels protocol testing V1 did not load');",
    "if (typeof channelsProtocolTestingV1.assertConversationProviderContributionV1 !== 'function') throw new Error('packed fixture Channels provider conformance assertion did not load');",
    "if (plugin.manifest?.id !== 'acme.channels.out-of-tree-socket') throw new Error('packed fixture manifest did not load');",
    "if (plugin.manifest?.brand?.iconResourceId !== 'brand-icon') throw new Error('packed fixture brand did not load');",
    "if (typeof plugin.activate !== 'function') throw new Error('packed fixture daemon entrypoint did not load');",
    'channelsProtocolTestingV1.assertConversationProviderContributionV1(plugin.manifest);',
    "if (!isDeepStrictEqual(committedManifest, sourceManifest)) throw new Error('packed fixture manifest does not match its source projection');",
  ].join('\n');
}

export async function runPackFixture() {
  const packageJson = JSON.parse(await readFile(join(fixtureRoot, 'package.json'), 'utf8'));
  const protocolTarball = process.env.CHANNELS_PROTOCOL_TARBALL;
  const sdkTarball = process.env.PLUGIN_SDK_TARBALL;

  if (!protocolTarball || !sdkTarball) {
    throw new Error(
      'Set CHANNELS_PROTOCOL_TARBALL and PLUGIN_SDK_TARBALL to run the candidate packed-fixture smoke check. This script never falls back to the checkout or workspace links, and does not establish official-origin package proof.',
    );
  }

  const tempRoot = await mkdtemp(join(tmpdir(), 'happier-channel-fixture-'));
  try {
    const packRoot = join(tempRoot, 'pack');
    const consumerRoot = join(tempRoot, 'consumer');
    await mkdir(packRoot, { recursive: true });
    await mkdir(consumerRoot, { recursive: true });
    runNpmCommand(['pack', '--ignore-scripts', '--pack-destination', packRoot], {
      cwd: fixtureRoot,
      stdio: 'inherit',
    });
    const fixtureArchive = join(packRoot, `${packageJson.name.replace(/^@/, '').replace('/', '-')}-${packageJson.version}.tgz`);
    await writeFile(
      join(consumerRoot, 'package.json'),
      `${JSON.stringify(buildFixtureConsumerPackageJson({
        protocolTarball,
        sdkTarball,
        fixtureArchive,
      }), null, 2)}\n`,
    );
    runNpmCommand(['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: consumerRoot,
      stdio: 'inherit',
    });
    await Promise.all([
      assertInstalledPackage({ consumerRoot, packageName: CHANNELS_PROTOCOL_PACKAGE_NAME }),
      assertInstalledPackage({ consumerRoot, packageName: PLUGIN_SDK_PACKAGE_NAME }),
      assertInstalledPackage({ consumerRoot, packageName: packageJson.name }),
    ]);
    await typecheckPackedPublicAuthoring(consumerRoot);
    const installedBrand = await readFile(join(consumerRoot, 'node_modules', packageJson.name, 'assets', 'brand.png'));
    if (!installedBrand.subarray(0, 8).every((byte, index) => byte === [137, 80, 78, 71, 13, 10, 26, 10][index])) {
      throw new Error('packed fixture did not install its declared PNG brand asset');
    }
    execFileSync(process.execPath, ['--input-type=module', '-e', buildPackedEntrypointSmokeSource(packageJson.name)], {
      cwd: consumerRoot,
      stdio: 'inherit',
    });
    process.stdout.write(`installed ${packageJson.name} from ${fixtureArchive}\n`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

const entrypointPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (entrypointPath && import.meta.url === pathToFileURL(entrypointPath).href) {
  await runPackFixture();
}
