#!/usr/bin/env node
// @ts-check
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readPublishablePlugins } from '../../plugins/publishable.mjs';
import { normalizePublicReleaseChannel } from '../release/lib/public-release-rings.mjs';
import { resolveRollingPublishVersion, validateExactRollingPublishVersion } from '../release/lib/rolling-version-allocation.mjs';
import { admitNpmPublication, admitPublicSdkRelease } from '../release/admit-release.mjs';

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const SDK = '@happier-dev/plugin-sdk';
const TOOLCHAIN = 'packages/plugin-sdk/src/ui/build/publicToolchainCompatibility.generated.ts';

export function pluginDistTag(channel) {
  const ring = normalizePublicReleaseChannel(channel);
  if (!ring) throw new Error('--channel must be dev, preview or production');
  return ring === 'stable' ? 'latest' : ring === 'preview' ? 'next' : 'dev';
}

/** Resolve once after the optional SDK pair publication; never use a source placeholder. */
export async function resolvePluginSdkVersion({ channel, sdkVersion = '', readPublishedVersion = readNpmVersion }) {
  const tag = pluginDistTag(channel);
  const version = sdkVersion || await readPublishedVersion(`${SDK}@${tag}`);
  if (typeof version !== 'string' || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`An exact published Plugin SDK version is required for the ${tag} dist-tag`);
  }
  return version;
}

function readNpmVersion(spec) {
  try {
    return JSON.parse(execFileSync('npm', ['view', spec, 'version', '--json', '--prefer-online'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }));
  } catch (error) {
    const failure = /** @type {{stderr?: unknown}} */ (error);
    if (/\bE404\b/u.test(String(failure.stderr ?? ''))) return null;
    throw error;
  }
}

/** Generate from the existing owners; only publication version facts differ. */
export async function derivePluginPublicationToolchain(repoRoot, sdkVersion) {
  const { derivePublicToolchainCompatibilityV1, renderPublicToolchainCompatibilityModule } = await import(
    pathToFileURL(path.join(repoRoot, 'packages/plugin-sdk/scripts/generatePublicToolchainCompatibility.mjs')).href
  );
  const facts = await mkdtemp(path.join(tmpdir(), 'happier-plugin-release-facts-'));
  try {
    for (const relative of ['package.json', 'apps/cli/package.json', 'apps/ui/package.json', 'packages/plugin-sdk/package.json', 'packages/plugin-ui/package.json', 'pnpm-lock.yaml']) {
      const target = path.join(facts, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(repoRoot, relative), target);
    }
    for (const relative of ['packages/plugin-sdk/package.json', 'packages/plugin-ui/package.json']) {
      const target = path.join(facts, relative);
      const manifest = JSON.parse(await readFile(target, 'utf8'));
      manifest.version = sdkVersion;
      if (relative.includes('plugin-ui')) manifest.dependencies[SDK] = sdkVersion;
      await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    await mkdir(path.join(facts, 'packages/protocol'), { recursive: true });
    // Protocol's executable facts remain owned by the selected source build.
    await symlink(path.join(repoRoot, 'packages/protocol/dist'), path.join(facts, 'packages/protocol/dist'), 'junction');
    return renderPublicToolchainCompatibilityModule(await derivePublicToolchainCompatibilityV1({ repoRoot: facts }));
  } finally { await rm(facts, { recursive: true, force: true }); }
}

/** CI metadata rewrites use atomic writes and never overwrite intervening edits. */
export async function withTemporaryPublicationFiles(files, operation) {
  const written = [];
  try {
    for (const file of files) {
      const original = await readFile(file.path, 'utf8');
      const temporary = `${file.path}.plugin-publication-${process.pid}`;
      await writeFile(temporary, file.contents);
      await rename(temporary, file.path);
      written.push({ ...file, original });
    }
    return await operation();
  } finally {
    let concurrentEdit;
    for (const file of written.reverse()) {
      if (await readFile(file.path, 'utf8') !== file.contents) {
        concurrentEdit ??= new Error(`Publication metadata changed concurrently; refusing to overwrite ${file.path}`);
        continue;
      }
      const temporary = `${file.path}.plugin-publication-${process.pid}`;
      await writeFile(temporary, file.original);
      await rename(temporary, file.path);
    }
    if (concurrentEdit) throw concurrentEdit;
  }
}

function emitOutput(outputPath, values) {
  if (!outputPath) return;
  for (const [key, value] of Object.entries(values)) {
    if (/[\r\n]/u.test(String(value))) throw new Error(`Unsafe publication output: ${key}`);
    appendFileSync(outputPath, `${key}=${value}\n`, 'utf8');
  }
}

export async function releasePlugin(options) {
  const { repoRoot, pluginId, channel, statusFile = '', githubOutput = '', approved = false,
    authorizedSha = '', mode = 'pack+publish', sdkVersion = '', explicitVersion = '', outDir = '' } = options;
  const plugin = readPublishablePlugins(repoRoot).find(candidate => candidate.id === pluginId);
  if (!plugin) throw new Error(`Plugin '${pluginId}' is not an opt-in publishable package`);
  const status = { id: plugin.id, packageName: plugin.packageName, result: 'failure', version: '', integrity: '' };
  try {
    emitOutput(githubOutput, { plugin_id: plugin.id, package: plugin.packageName });
    if (mode !== 'pack' && mode !== 'pack+publish') throw new Error('--mode must be pack or pack+publish');
    admitPublicSdkRelease({ packageName: plugin.packageName, approvalRequired: true, approved });
    admitNpmPublication({ mode, dryRun: false, authorizedSha });
    const tag = pluginDistTag(channel);
    const channelId = normalizePublicReleaseChannel(channel);
    if (channelId === 'stable') {
      if (!explicitVersion) throw new Error('Production plugin publication requires an explicit admitted --version');
      validateExactRollingPublishVersion({ productId: `plugin:${plugin.id}`, channel: channelId,
        baseVersion: explicitVersion, version: explicitVersion });
    }
    const exactSdk = await resolvePluginSdkVersion({ channel, sdkVersion });
    const packagePath = path.join(plugin.packageDir, 'package.json');
    const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
    const allocation = await resolveRollingPublishVersion({
      repoRoot, productId: `plugin:${plugin.id}`, channel: channelId,
      baseVersion: channelId === 'stable' ? explicitVersion : manifest.version, explicitVersion, publishSurface: 'npm', env: process.env,
    });
    status.version = allocation.version;
    manifest.version = allocation.version;
    manifest.dependencies = { ...manifest.dependencies, [SDK]: exactSdk };
    const packet = await derivePluginPublicationToolchain(repoRoot, exactSdk);
    const directory = path.resolve(repoRoot, outDir || `dist/release-assets/plugins/${plugin.id}`);
    await mkdir(directory, { recursive: true });
    const tarball = path.join(directory, `${plugin.id}-${allocation.version}.tgz`);
    await withTemporaryPublicationFiles([
      { path: packagePath, contents: `${JSON.stringify(manifest, null, 2)}\n` },
      { path: path.join(repoRoot, TOOLCHAIN), contents: packet },
    ], async () => {
      const packEnvironment = { ...process.env, TSX_TSCONFIG_PATH: path.join(repoRoot, 'apps/cli/tsconfig.runtime.json') };
      delete packEnvironment.NODE_AUTH_TOKEN;
      delete packEnvironment.NPM_TOKEN;
      execFileSync(process.execPath, [
        '--conditions=happier-source', '--import', path.join(repoRoot, 'packages/cli-common/registerSourceRuntime.mjs'),
        path.join(scriptRoot, 'pack-plugin-for-publication.mjs'), '--repo-root', repoRoot,
        '--plugin-root', plugin.packageDir, '--version', allocation.version, '--tarball', tarball,
      ], { cwd: repoRoot, env: packEnvironment, stdio: 'inherit' });
    });
    emitOutput(githubOutput, { version: status.version, tarball, dist_tag: tag, sdk_version: exactSdk });
    if (mode === 'pack+publish') {
      const publisherOutput = path.join(directory, 'publication-output.txt');
      await writeFile(publisherOutput, '');
      execFileSync(process.execPath, [path.join(scriptRoot, 'publish-tarball.mjs'),
        '--channel', channel, '--tarball', tarball, '--tag', tag, '--provenance', 'true',
        '--authorized-sha', authorizedSha, '--github-output', publisherOutput,
      ], { cwd: repoRoot, env: process.env, stdio: 'inherit' });
      const identity = Object.fromEntries(readFileSync(publisherOutput, 'utf8').trim().split(/\r?\n/u).map(line => {
        const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
      }));
      if (identity.package !== plugin.packageName || identity.version !== status.version || !identity.integrity) {
        throw new Error('Canonical npm publisher did not return the selected plugin identity');
      }
      status.integrity = identity.integrity;
      status.result = 'success';
      emitOutput(githubOutput, { integrity: status.integrity });
    } else status.result = 'packed';
    return status;
  } finally {
    if (statusFile) {
      await mkdir(path.dirname(path.resolve(statusFile)), { recursive: true });
      await writeFile(statusFile, `${JSON.stringify(status)}\n`);
    }
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    channel: { type: 'string' }, plugin: { type: 'string' }, 'repo-root': { type: 'string', default: process.cwd() },
    'sdk-version': { type: 'string', default: '' }, version: { type: 'string', default: '' },
    'status-file': { type: 'string', default: '' }, 'github-output': { type: 'string', default: '' },
    'approve-public-sdk-release': { type: 'string', default: 'false' },
    'authorized-sha': { type: 'string', default: '' }, mode: { type: 'string', default: 'pack+publish' },
    'out-dir': { type: 'string', default: '' },
  } });
  if (!['true', 'false'].includes(values['approve-public-sdk-release'])) throw new Error('--approve-public-sdk-release must be true or false');
  await releasePlugin({ repoRoot: path.resolve(values['repo-root']), pluginId: values.plugin, channel: values.channel,
    sdkVersion: values['sdk-version'], explicitVersion: values.version, statusFile: values['status-file'],
    githubOutput: values['github-output'], approved: values['approve-public-sdk-release'] === 'true',
    authorizedSha: values['authorized-sha'], mode: values.mode, outDir: values['out-dir'] });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
