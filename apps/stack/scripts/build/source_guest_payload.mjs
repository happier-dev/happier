import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { cp, mkdir, rm, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLI_BINARY_TARGETS, resolveCliToolsPlatformDir, resolveExecutableName } from '../../../../packages/cli-common/src/componentArtifacts/targets.ts';
import { run } from '../utils/proc/proc.mjs';

// Preserve the installer's existing flat or target-directory layout. The tools
// producer's platform metadata identifies a native flat payload without parsing
// executable ABIs or introducing another target setting.
export function readSourceGuestPayloadTargets(env) {
  const configuredRoot = String(env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT ?? '').trim();
  if (!configuredRoot) return null;
  const root = resolve(configuredRoot);
  const targets = CLI_BINARY_TARGETS.filter(target => {
    const path = join(root, `${target.os}-${target.arch}`);
    return existsSync(path) && statSync(path).isDirectory();
  }).map(target => ({ target, relativeDir: `${target.os}-${target.arch}` }));
  const manifestPath = join(root, 'tools/unpacked/.happier-tools-manifest.json');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const target = CLI_BINARY_TARGETS.find(candidate => resolveCliToolsPlatformDir(candidate) === manifest.platformDir);
    if (!target) throw new Error('[source-bundle] guest payload tools metadata has an unsupported platform');
    if (!targets.some(item => item.target === target)) targets.unshift({ target, relativeDir: '' });
  }
  // Interpreter/manual flat roots have no canonical native target metadata.
  // Keep their existing override rather than inventing a target or attestation.
  if (!existsSync(manifestPath) && CLI_BINARY_TARGETS.some(target =>
    existsSync(join(root, resolveExecutableName({ baseName: 'happier', target }))))) return null;
  return targets.length ? targets : null;
}

export async function buildSourceGuestPayload({ repoDir, sourceRepoDir, outputDir, runtimeDir, targets, sourceCapture, env, signal }) {
  const root = join(outputDir, 'guest-payload');
  // The caller owns one graph in an isolated finite worker. Reuse canonical
  // capture containment for its mounted installed dependencies across awaits.
  const captureContext = { HAPPIER_STACK_REPO_DIR: repoDir, HAPPIER_WORKSPACE_CAPTURE_SOURCE_REPO_DIR: sourceRepoDir };
  const previousContext = Object.fromEntries(Object.keys(captureContext).map(key => [key, process.env[key]]));
  const captureEnv = { ...env, ...captureContext };
  // Vendor tool archives retain their installed-input lifecycle. Every authored
  // compiler/tool script and every first-party native source comes from repoDir.
  let loader;
  try {
    Object.assign(process.env, captureContext);
    const archives = join(repoDir, 'apps/cli/tools/archives');
    if (!existsSync(archives)) {
      await mkdir(dirname(archives), { recursive: true });
      await symlink(join(sourceRepoDir, 'apps/cli/tools/archives'), archives, process.platform === 'win32' ? 'junction' : 'dir');
    }
    const { createCliSourceLoader } = await import(pathToFileURL(join(repoDir, 'packages/cli-common/cliSourceLoader.mjs')).href);
    loader = await createCliSourceLoader('source-runtime-guest-payload');
    const { buildCliBinaryArtifactPayload } = await loader.import(
      pathToFileURL(join(repoDir, 'packages/cli-common/src/componentArtifacts/buildCliBinaryArtifactPayload.ts')).href, import.meta.url);
    const runCommand = (command, args, options) => run(command, args, {
      ...options, env: { ...captureEnv, ...options?.env }, signal, stdio: 'ignore', captureFailureDiagnostic: true,
    });
    const targetIdentities = {};
    for (const { target, relativeDir } of targets) {
      signal?.throwIfAborted();
      const irohPackage = join(repoDir, 'packages/iroh-native');
      if (existsSync(join(irohPackage, 'scripts/build-node-addon.mjs'))) {
        const nativeDir = join(irohPackage, 'native');
        await rm(nativeDir, { recursive: true, force: true });
        const hostOs = process.platform === 'win32' ? 'windows' : process.platform;
        if (target.os === hostOs && target.arch === process.arch && existsSync(join(runtimeDir, 'iroh-native/native'))) {
          await cp(join(runtimeDir, 'iroh-native/native'), nativeDir, { recursive: true });
        } else {
          const { buildNodeAddon } = await import(pathToFileURL(join(irohPackage, 'scripts/build-node-addon.mjs')).href);
          await buildNodeAddon({ packageDir: irohPackage, artifactDir: nativeDir,
            platform: target.os === 'windows' ? 'win32' : target.os, arch: target.arch, env: captureEnv, runCommand });
        }
      }
      const payload = await buildCliBinaryArtifactPayload({
        repoRoot: repoDir, payloadDir: join(root, relativeDir), target, runCommand,
      });
      targetIdentities[`${target.os}-${target.arch}`] = payload.identity;
    }
    const collection = targets.some(item => item.relativeDir);
    const identity = collection
      ? createHash('sha256').update(JSON.stringify(Object.entries(targetIdentities).sort(([a], [b]) => a.localeCompare(b)))).digest('hex')
      : Object.values(targetIdentities)[0];
    return { root, identity, sourceCapture, ...(collection ? { targetIdentities } : {}) };
  } finally {
    await loader?.unregister();
    for (const [key, value] of Object.entries(previousContext)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
