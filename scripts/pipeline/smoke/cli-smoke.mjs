// @ts-check

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolvePackedTarball } from '../npm/resolvePackedTarball.mjs';
import { assertCliManagedRuntimeTarballCoherence } from '../npm/cli-managed-runtime-tarball.mjs';
import { resolveCliPublicationBuildSteps } from '../../../apps/cli/scripts/buildPublication.mjs';
import { resolveInstalledBinPath } from './resolveInstalledBinPath.mjs';

const EXPECTED_PROVIDER_PROJECTIONS = Object.freeze([
  Object.freeze({
    packageName: '@happier-dev/plugins-cliproxyapi',
    pluginId: 'happier.provider.cliproxyapi',
    localId: 'cliproxyapi',
    providerId: 'cliproxyapi',
  }),
  Object.freeze({
    packageName: '@happier-dev/plugins-deepseek',
    pluginId: 'happier.provider.deepseek',
    localId: 'deepseek',
    providerId: 'deepseek',
  }),
  Object.freeze({
    packageName: '@happier-dev/plugins-lmstudio',
    pluginId: 'happier.provider.lmstudio',
    localId: 'lmstudio',
    providerId: 'lmstudio',
  }),
  Object.freeze({
    packageName: '@happier-dev/plugins-ollama',
    pluginId: 'happier.provider.ollama',
    localId: 'ollama',
    providerId: 'ollama',
  }),
  Object.freeze({
    packageName: '@happier-dev/plugins-openai-models',
    pluginId: 'happier.provider.openai',
    localId: 'openai',
    providerId: 'openai',
  }),
  Object.freeze({
    packageName: '@happier-dev/plugins-openrouter',
    pluginId: 'happier.provider.openrouter',
    localId: 'openrouter',
    providerId: 'openrouter',
  }),
  Object.freeze({
    packageName: '@happier-dev/plugins-zai',
    pluginId: 'happier.provider.zai',
    localId: 'zai',
    providerId: 'zai',
  }),
]);

const EXPECTED_PROVIDER_MATERIALIZERS = Object.freeze([
  Object.freeze({
    agentId: 'claude',
    packageName: '@happier-dev/plugins-claude',
    protocol: 'anthropic',
    materialization: 'spawnEnv',
  }),
  Object.freeze({
    agentId: 'codex',
    packageName: '@happier-dev/plugins-codex',
    protocol: 'openai-responses',
    materialization: 'engineConfig',
  }),
  Object.freeze({
    agentId: 'opencode',
    packageName: '@happier-dev/plugins-opencode',
    protocol: 'openai-chat',
    materialization: 'configFile',
  }),
]);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function assertSmoke(condition, message) {
  if (!condition) throw new Error(message);
}

function asNonEmptyString(value) {
  const trimmed = String(value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readEnvPath(env) {
  return String(env.PATH ?? env.Path ?? '');
}

function readEnvPathext(env) {
  return String(env.PATHEXT ?? env.Pathext ?? '');
}

function normalizePathext(pathext) {
  const raw = asNonEmptyString(pathext) ?? '.EXE;.CMD;.BAT;.COM';
  return raw
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (part.startsWith('.') ? part : `.${part}`));
}

function expandPathextCaseVariants(exts) {
  const seen = new Set();
  const variants = [];
  for (const ext of exts) {
    for (const candidate of [ext, ext.toLowerCase(), ext.toUpperCase()]) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      variants.push(candidate);
    }
  }
  return variants;
}

function isCommandOnly(command) {
  const trimmed = String(command ?? '').trim();
  if (!trimmed) return false;
  if (trimmed.includes('/') || trimmed.includes('\\')) return false;
  if (trimmed.includes(':')) return false;
  return true;
}

function isWindowsShellShimPath(pathLike) {
  return /\.(cmd|bat)$/i.test(String(pathLike ?? '').trim());
}

function buildWindowsCommandCandidates(commandLike, env) {
  const cmd = asNonEmptyString(commandLike);
  if (!cmd) return [];

  const exts = expandPathextCaseVariants(normalizePathext(readEnvPathext(env)));
  const lowered = cmd.toLowerCase();
  const hasKnownExt = exts.some((ext) => lowered.endsWith(ext.toLowerCase()));
  return hasKnownExt ? [cmd] : [...exts.map((ext) => `${cmd}${ext}`), cmd];
}

function resolveWindowsCommandPath(commandPath, env = process.env) {
  for (const candidate of buildWindowsCommandCandidates(commandPath, env)) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }

  return null;
}

const cmdMetaCharsRegExp = /([()\][%!^"`<>&|;, *?])/g;
const nodeModulesCmdShimRegExp = /node_modules[\\/].bin[\\/][^\\/]+\.cmd$/i;

function escapeCmdCommand(arg) {
  return arg.replace(cmdMetaCharsRegExp, '^$1');
}

function escapeCmdArgument(arg, doubleEscapeMetaChars) {
  let value = `${arg}`;

  value = value.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  value = value.replace(/(?=(\\+?)?)\1$/, '$1$1');
  value = `"${value}"`;
  value = value.replace(cmdMetaCharsRegExp, '^$1');
  if (doubleEscapeMetaChars) {
    value = value.replace(cmdMetaCharsRegExp, '^$1');
  }

  return value;
}

function buildCmdExeInvocation(params) {
  const resolvedCommand = path.normalize(params.resolvedCommand);
  const comspec =
    asNonEmptyString(params.comspec) ??
    asNonEmptyString(params.env.comspec) ??
    asNonEmptyString(params.env.ComSpec) ??
    asNonEmptyString(params.env.COMSPEC) ??
    'cmd.exe';

  const needsDoubleEscape = nodeModulesCmdShimRegExp.test(resolvedCommand);
  const shellCommand = [escapeCmdCommand(resolvedCommand), ...params.args.map((arg) => escapeCmdArgument(arg, needsDoubleEscape))].join(' ');

  return {
    command: comspec,
    args: ['/d', '/s', '/c', `"${shellCommand}"`],
    windowsVerbatimArguments: true,
  };
}

function resolveWindowsCommandOnPath(command, env = process.env) {
  const cmd = asNonEmptyString(command);
  if (!cmd) return null;

  const pathEnv = asNonEmptyString(readEnvPath(env));
  if (!pathEnv) return null;

  const candidates = buildWindowsCommandCandidates(cmd, env);

  for (const dir of pathEnv.split(path.delimiter)) {
    const trimmedDir = dir.trim();
    if (!trimmedDir) continue;
    for (const name of candidates) {
      const full = path.join(trimmedDir, name);
      try {
        if (fs.existsSync(full)) return full;
      } catch {
        // ignore
      }
    }
  }

  return null;
}

function resolveWindowsCommandInvocation(params) {
  const command = String(params.command ?? '').trim();
  const args = Array.isArray(params.args) ? params.args.map((arg) => String(arg)) : [];

  if (process.platform !== 'win32') {
    return { command, args };
  }

  const env = params.env ?? process.env;
  const shouldResolveOnPath = params.resolveCommandOnPath !== false;
  const resolvedCommand =
    shouldResolveOnPath && isCommandOnly(command)
      ? (resolveWindowsCommandOnPath(command, env) ?? command)
      : (resolveWindowsCommandPath(command, env) ?? command);

  if (!isWindowsShellShimPath(resolvedCommand)) {
    return { command: resolvedCommand, args };
  }

  return buildCmdExeInvocation({ resolvedCommand, args, env, comspec: params.comspec });
}

/**
 * @param {unknown} value
 * @param {string} name
 */
function parseBool(value, name) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  fail(`${name} must be 'true' or 'false' (got: ${value})`);
}

/**
 * @param {{ dryRun: boolean }} opts
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string; env?: Record<string, string>; stdio?: import('node:child_process').StdioOptions; timeoutMs?: number; }} [extra]
 * @returns {string}
 */
function run(opts, cmd, args, extra) {
  const printable = `${cmd} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`;
  const cwd = extra?.cwd ? path.resolve(extra.cwd) : process.cwd();
  const timeout = extra?.timeoutMs ?? 10 * 60_000;
  if (opts.dryRun) {
    console.log(`[dry-run] (cwd: ${cwd}) ${printable}`);
    return '';
  }

  const stdio = extra?.stdio ?? 'inherit';
  const env = { ...process.env, ...(extra?.env ?? {}) };
  const invocation = resolveWindowsCommandInvocation({
    command: cmd,
    args,
    env,
    resolveCommandOnPath: true,
  });
  return execFileSync(invocation.command, invocation.args, {
    cwd,
    env,
    encoding: stdio === 'inherit' ? 'utf8' : 'utf8',
    stdio,
    timeout,
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
}

/**
 * @param {string} repoRoot
 * @param {string} rel
 */
function withinRepo(repoRoot, rel) {
  return path.resolve(repoRoot, rel);
}

/**
 * @param {string} prefix
 * @returns {string}
 */
function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * The smoke gate installs and drives the packed artifact, so the tarball it packs must
 * correspond to current source. The CLI package reaches that only through its canonical
 * publication build: a live workspace build isolates a failing generator-owned plugin and
 * leaves its last-green package installed, and the pack then ships those stale bytes.
 *
 * @param {{ dryRun: boolean }} opts
 * @param {{ absPkgDir: string; workspaceName: string; repoRoot: string }} params
 */
function buildSmokePackage(opts, { absPkgDir, workspaceName, repoRoot }) {
  if (path.basename(absPkgDir) !== 'cli') {
    run(opts, 'yarn', ['workspace', workspaceName, 'build'], { cwd: repoRoot });
    return;
  }
  for (const step of resolveCliPublicationBuildSteps({ packageRoot: absPkgDir })) {
    run(opts, step.command, step.args, { cwd: step.cwd, timeoutMs: 30 * 60_000 });
  }
}

/**
 * @param {string} pkgDir
 * @param {string} destDir
 * @param {{ dryRun: boolean }} opts
 * @returns {string} absolute tgz path
 */
function npmPack(pkgDir, destDir, opts) {
  if (opts.dryRun) {
    const printable = path.basename(pkgDir) === 'cli'
      ? `${process.execPath} apps/cli/scripts/packTarball.mjs --dest-dir ${destDir}`
      : `npm pack --silent --pack-destination ${destDir}`;
    console.log(`[dry-run] (cwd: ${pkgDir}) ${printable}`);
    return path.join(destDir, 'DRY_RUN.tgz');
  }

  fs.mkdirSync(destDir, { recursive: true });
  if (path.basename(pkgDir) === 'cli') {
    const scriptPath = path.resolve(pkgDir, 'scripts', 'packTarball.mjs');
    const raw = execFileSync(process.execPath, [scriptPath, '--dest-dir', destDir], {
      cwd: pkgDir,
      env: { ...process.env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      // The helper first publishes the artifact closure and then gives npm pack its own bounded
      // ten-minute budget. The parent must cover both stages instead of pre-empting a healthy pack.
      timeout: 20 * 60_000,
    }).trim();
    const { tgzPath } = resolvePackedTarball(raw, {
      cwd: pkgDir,
      sourceLabel: 'CLI pack helper',
    });
    if (!tgzPath.endsWith('.tgz') || !fs.existsSync(tgzPath) || !fs.statSync(tgzPath).isFile()) {
      throw new Error(`CLI pack helper did not produce an expected .tgz file (cwd: ${pkgDir}): ${tgzPath}`);
    }
    // Ordinary smoke accepts either an honest source-only pack or a complete installable
    // pack. The canonical coherence owner proves the declared mode matches the exact bytes.
    assertCliManagedRuntimeTarballCoherence(tgzPath);
    return tgzPath;
  }

  const env = { ...process.env };
  const invocation = resolveWindowsCommandInvocation({
    command: 'npm',
    args: ['pack', '--silent', '--pack-destination', destDir],
    env,
    resolveCommandOnPath: true,
  });
  const raw = execFileSync(invocation.command, invocation.args, {
    cwd: pkgDir,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: 10 * 60_000,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  }).trim();

  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const filename = lines.length > 0 ? lines[lines.length - 1] : '';
  if (!filename) {
    throw new Error(`npm pack did not return a tarball filename (cwd: ${pkgDir})`);
  }
  const tgzPath = path.resolve(destDir, filename);
  if (!tgzPath.endsWith('.tgz') || !fs.existsSync(tgzPath) || !fs.statSync(tgzPath).isFile()) {
    throw new Error(`npm pack did not produce an expected .tgz file (cwd: ${pkgDir}): ${tgzPath}`);
  }
  return tgzPath;
}

/**
 * @param {string} prefixDir
 * @returns {string}
 */
function resolveInstalledBin(prefixDir) {
  const binPath = resolveInstalledBinPath(prefixDir);
  if (binPath) return binPath;

  fail(`Unable to locate installed CLI binary under prefix ${prefixDir} (looked for: happier)`);
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveInstalledCliPackageRoot(prefixDir, binPath) {
  const candidates = [];
  try {
    candidates.push(path.dirname(path.dirname(fs.realpathSync(binPath))));
  } catch {
    // The Windows npm command shim is not a symlink to the package bin entry.
  }
  candidates.push(
    path.join(prefixDir, 'lib', 'node_modules', '@happier-dev', 'cli'),
    path.join(prefixDir, 'node_modules', '@happier-dev', 'cli'),
  );

  for (const candidate of candidates) {
    const packageJsonPath = path.join(candidate, 'package.json');
    try {
      if (readJsonFile(packageJsonPath).name === '@happier-dev/cli') return candidate;
    } catch {
      // Try the next npm global-prefix layout.
    }
  }
  throw new Error(`Unable to locate the installed @happier-dev/cli package under ${prefixDir}`);
}

function findSingleGeneratedRegistryChunk(distDir) {
  const matches = fs.readdirSync(distDir)
    .filter((name) => /^createResolvedContributionRegistry-.*\.mjs$/.test(name));
  assertSmoke(
    matches.length === 1,
    `Expected exactly one installed generated contribution-registry chunk, found ${matches.length}`,
  );
  return path.join(distDir, matches[0]);
}

function hasExactProperty(value, propertyName, seen = new Set()) {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Object.prototype.hasOwnProperty.call(value, propertyName)) return true;
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ('value' in descriptor && hasExactProperty(descriptor.value, propertyName, seen)) return true;
  }
  return false;
}

function compareProviderProjection(left, right) {
  const leftKey = `${left.pluginId}/${left.localId}`;
  const rightKey = `${right.pluginId}/${right.localId}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

async function verifyInstalledProviderArtifact({ prefixDir, binPath, dryRun }) {
  if (dryRun) {
    console.log(`[dry-run] verify installed Provider artifact under ${prefixDir}`);
    console.log('[dry-run] activate installed Agent plugins and materialize registered Provider bindings');
    return;
  }

  const cliPackageRoot = resolveInstalledCliPackageRoot(prefixDir, binPath);
  console.log(`[smoke] Installed CLI package root: ${cliPackageRoot}`);
  const cliPackageJson = readJsonFile(path.join(cliPackageRoot, 'package.json'));
  const dependencies = cliPackageJson.dependencies ?? {};
  const bundledDependencies = new Set(cliPackageJson.bundledDependencies ?? []);

  for (const provider of EXPECTED_PROVIDER_PROJECTIONS) {
    assertSmoke(
      Object.prototype.hasOwnProperty.call(dependencies, provider.packageName),
      `Installed CLI dependency metadata is missing ${provider.packageName}`,
    );
    assertSmoke(
      bundledDependencies.has(provider.packageName),
      `Installed CLI bundledDependencies is missing ${provider.packageName}`,
    );
    const providerPackageRoot = path.join(cliPackageRoot, 'node_modules', ...provider.packageName.split('/'));
    assertSmoke(
      fs.statSync(path.join(providerPackageRoot, 'package.json')).isFile(),
      `Installed CLI is missing bundled Provider package ${provider.packageName}`,
    );
    assertSmoke(
      fs.statSync(path.join(providerPackageRoot, 'dist', 'manifest.js')).isFile(),
      `Installed Provider package ${provider.packageName} is missing its compiled manifest`,
    );
    const providerManifestModule = await import(
      pathToFileURL(path.join(providerPackageRoot, 'dist', 'manifest.js')).href
    );
    const providerManifest = providerManifestModule.PLUGIN_MANIFEST;
    assertSmoke(
      providerManifest?.id === provider.pluginId,
      `Installed Provider package ${provider.packageName} has unexpected plugin id ${providerManifest?.id}`,
    );
    const contributedProviders = providerManifest.contributes?.providers ?? [];
    assertSmoke(
      contributedProviders.length === 1 && contributedProviders[0]?.id === provider.providerId,
      `Installed Provider package ${provider.packageName} has unexpected Provider contributions`,
    );
  }

  const registryChunk = findSingleGeneratedRegistryChunk(path.join(cliPackageRoot, 'dist'));
  const registryModule = await import(pathToFileURL(registryChunk).href);
  const getResolvedContributionRegistry = Object.values(registryModule).find((value) => (
    typeof value === 'function' && value.name === 'getResolvedContributionRegistry'
  ));
  assertSmoke(
    typeof getResolvedContributionRegistry === 'function',
    'Installed generated registry chunk does not expose the CLI contribution projection owner',
  );
  const registry = getResolvedContributionRegistry();
  const actualProviders = registry.providers.map((entry) => ({
    packageName: EXPECTED_PROVIDER_PROJECTIONS.find((candidate) => (
      candidate.pluginId === entry.pluginId && candidate.localId === entry.identity?.localId
    ))?.packageName ?? null,
    pluginId: entry.pluginId,
    localId: entry.identity?.localId,
    providerId: entry.definition?.id,
  })).sort(compareProviderProjection);
  const expectedProviders = [...EXPECTED_PROVIDER_PROJECTIONS].sort(compareProviderProjection);
  assertSmoke(
    JSON.stringify(actualProviders) === JSON.stringify(expectedProviders),
    `Installed CLI Provider projection mismatch: ${JSON.stringify(actualProviders)}`,
  );
  assertSmoke(
    registry.providers.every((entry) => (
      entry.provenance === 'first_party' && entry.source?.kind === 'bundled'
    )),
    'Installed CLI Provider projection contains a non-bundled or non-first-party contribution',
  );
  assertSmoke(
    !hasExactProperty(registry, 'providerSupport'),
    'Installed CLI generated projection contains retired providerSupport output',
  );

  const installedPluginSdkTesting = await import(pathToFileURL(path.join(
    cliPackageRoot,
    'node_modules',
    '@happier-dev',
    'plugin-sdk',
    'dist',
    'testing',
    'index.js',
  )).href);
  const createPluginTestkit = installedPluginSdkTesting.createPluginTestkit;
  assertSmoke(
    typeof createPluginTestkit === 'function',
    'Installed CLI Plugin SDK testing surface does not expose createPluginTestkit',
  );

  for (const materializer of EXPECTED_PROVIDER_MATERIALIZERS) {
    const agent = registry.agents.find((entry) => entry.id === materializer.agentId);
    assertSmoke(agent, `Installed CLI projection is missing Agent ${materializer.agentId}`);
    assertSmoke(
      agent.definition?.providerRequirements?.materialization === materializer.materialization,
      `Installed CLI Agent ${materializer.agentId} has stale providerRequirements`,
    );
    assertSmoke(
      !Object.prototype.hasOwnProperty.call(agent.definition ?? {}, 'providerSupport'),
      `Installed CLI Agent ${materializer.agentId} contains retired providerSupport output`,
    );

    const agentPackageRoot = path.join(
      cliPackageRoot,
      'node_modules',
      ...materializer.packageName.split('/'),
    );
    assertSmoke(
      fs.statSync(path.join(agentPackageRoot, 'package.json')).isFile(),
      `Installed CLI is missing bundled Agent package ${materializer.packageName}`,
    );
    const agentPluginModule = await import(pathToFileURL(path.join(
      agentPackageRoot,
      'dist',
      'index.js',
    )).href);
    assertSmoke(
      typeof agentPluginModule.activate === 'function' && agentPluginModule.PLUGIN_MANIFEST,
      `Installed ${materializer.agentId} plugin activation exports are unavailable`,
    );

    let activation = null;
    try {
      activation = await createPluginTestkit({
        manifest: agentPluginModule.PLUGIN_MANIFEST,
        module: { activate: agentPluginModule.activate },
      });
      const adapter = activation.registration('agents', materializer.agentId)?.providerBinding;
      assertSmoke(
        adapter?.v === 1,
        `Installed ${materializer.agentId} activation did not register its Provider adapter`,
      );

      const agentTargetKey = `backend:${materializer.agentId}`;
      const connectionId = 'pc_provider_artifact_smoke';
      const prepared = adapter.prepare({ v: 1, agentTargetKey, connectionId });
      const materialized = await adapter.materialize({
        binding: {
          v: 1,
          agentTargetKey,
          selection: {
            connectionId,
            model: { id: 'provider-artifact-smoke-model' },
          },
          contributionKey: null,
          endpoint: {
            endpointTemplateId: 'provider-artifact-smoke',
            normalizedUrl: 'https://example.invalid/v1',
            protocol: materializer.protocol,
            publicHeaders: {},
          },
          runtimeCredentialTransport: null,
          compatibilityFingerprint: 'provider-artifact-smoke',
        },
        prepared,
        credential: { kind: 'none' },
      });
      assertSmoke(
        prepared.materialization === materializer.materialization
          && materialized?.kind === materializer.materialization,
        `Installed ${materializer.agentId} Provider materializer returned an unexpected shape`,
      );
      assertSmoke(
        JSON.stringify(materialized).includes('https://example.invalid/v1'),
        `Installed ${materializer.agentId} Provider materializer did not consume the resolved endpoint`,
      );
    } finally {
      await activation?.dispose();
    }
  }

  console.log(
    `[smoke] Installed Provider artifact verified: ${EXPECTED_PROVIDER_PROJECTIONS.length} projections/packages and ${EXPECTED_PROVIDER_MATERIALIZERS.length} materializers.`,
  );
}

async function main() {
  const repoRoot = path.resolve(process.cwd());
  const { values } = parseArgs({
    options: {
      'package-dir': { type: 'string', default: 'apps/cli' },
      'workspace-name': { type: 'string', default: '@happier-dev/cli' },
      'skip-build': { type: 'string', default: 'false' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const pkgDir = String(values['package-dir'] ?? '').trim() || 'apps/cli';
  const workspaceName = String(values['workspace-name'] ?? '').trim() || '@happier-dev/cli';
  const skipBuild = parseBool(values['skip-build'], '--skip-build');
  const dryRun = values['dry-run'] === true;
  const opts = { dryRun };

  const absPkgDir = withinRepo(repoRoot, pkgDir);
  if (!fs.existsSync(absPkgDir)) {
    fail(`package dir not found: ${pkgDir}`);
  }

  const prefixDir = dryRun ? withinRepo(repoRoot, 'dist/smoke/DRY_RUN_PREFIX') : mkTmpDir('happier-cli-smoke-prefix-');
  const homeDir = dryRun ? withinRepo(repoRoot, 'dist/smoke/DRY_RUN_HOME') : mkTmpDir('happier-cli-smoke-home-');
  const packDir = dryRun ? withinRepo(repoRoot, 'dist/smoke/DRY_RUN_PACK') : mkTmpDir('happier-cli-smoke-pack-');
  const npmCacheDir = dryRun ? withinRepo(repoRoot, 'dist/smoke/DRY_RUN_NPM_CACHE') : path.join(homeDir, '.npm-cache');
  const npmUserConfigPath = dryRun ? withinRepo(repoRoot, 'dist/smoke/DRY_RUN_NPMRC') : path.join(homeDir, '.npmrc');
  const npmEnv = {
    HOME: homeDir,
    npm_config_userconfig: npmUserConfigPath,
    npm_config_cache: npmCacheDir,
    npm_config_update_notifier: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  };

  if (!skipBuild) {
    buildSmokePackage(opts, { absPkgDir, workspaceName, repoRoot });
  }

  if (!dryRun) {
    fs.mkdirSync(npmCacheDir, { recursive: true });
    fs.writeFileSync(npmUserConfigPath, '', 'utf8');
  }
  const tgzPath = npmPack(absPkgDir, packDir, opts);
  console.log(`[smoke] Packed CLI artifact: ${tgzPath}`);

  run(opts, 'npm', [
    'install',
    '-g',
    '--prefix',
    prefixDir,
    '--cache',
    npmCacheDir,
    '--userconfig',
    npmUserConfigPath,
    tgzPath,
  ], { cwd: repoRoot, env: npmEnv });

  const binPath = opts.dryRun ? path.join(prefixDir, process.platform === 'win32' ? 'happier.cmd' : 'bin/happier') : resolveInstalledBin(prefixDir);

  const baseEnv = { ...process.env, HAPPIER_HOME_DIR: homeDir };

  run(opts, binPath, ['--help'], { cwd: repoRoot, env: baseEnv, stdio: opts.dryRun ? 'inherit' : ['ignore', 'inherit', 'inherit'], timeoutMs: 30_000 });
  run(opts, binPath, ['--version'], { cwd: repoRoot, env: baseEnv, stdio: opts.dryRun ? 'inherit' : ['ignore', 'inherit', 'inherit'], timeoutMs: 10_000 });

  const doctor = run(opts, binPath, ['doctor', '--help'], { cwd: repoRoot, env: baseEnv, stdio: ['ignore', 'pipe', 'inherit'], timeoutMs: 10_000 });
  if (!opts.dryRun && doctor) {
    process.stdout.write(doctor);
    if (!doctor.endsWith('\n')) process.stdout.write('\n');
  }

  const daemonHelp = run(opts, binPath, ['daemon', '--help'], { cwd: repoRoot, env: baseEnv, stdio: ['ignore', 'pipe', 'inherit'], timeoutMs: 10_000 });
  if (!opts.dryRun) {
    process.stdout.write(daemonHelp);
    if (!daemonHelp.endsWith('\n')) process.stdout.write('\n');
    if (!daemonHelp.includes('happier daemon') || !daemonHelp.includes('Usage:')) {
      fail('Expected `happier daemon --help` to include command header and usage text');
    }
  }

  run(opts, binPath, ['providers', '--help'], { cwd: repoRoot, env: baseEnv, stdio: ['ignore', 'pipe', 'inherit'], timeoutMs: 10_000 });
  await verifyInstalledProviderArtifact({ prefixDir, binPath, dryRun: opts.dryRun });

  console.log('[smoke] CLI smoke test passed.');
}

await main();
