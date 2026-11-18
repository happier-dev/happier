import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { copyFile, mkdir, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLI_BINARY_TARGETS, resolveCliToolsPlatformDir, resolveCurrentBinaryTarget, resolveExecutableName } from '../../../../packages/cli-common/src/componentArtifacts/targets.ts';
import { run } from '../utils/proc/proc.mjs';

// Preserve the installer's existing flat or target-directory layout. The tools
// producer's platform metadata identifies a native flat payload without parsing
// executable ABIs or introducing another target setting.
export function readSourceGuestPayloadTargets(env) {
  const configuredRoot = String(env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT ?? '').trim();
  if (!configuredRoot) {
    return [{ target: resolveCurrentBinaryTarget({ availableTargets: CLI_BINARY_TARGETS }), relativeDir: '' }];
  }
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

// Registered archives come from this same producer on another native build host.
// Rebuilt targets keep their local producer; registration supplies only the others.
export function readSourceGuestPayloadArchiveImports(env, { logger = console } = {}) {
  if (env.HAPPIER_DEV_GUEST_CLI_EXPORT !== '1') return [];
  const archives = JSON.parse(env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_METADATA || '{}').archives ?? [];
  if (!Array.isArray(archives)) throw new Error('[source-bundle] guest archive metadata must contain an archive list');
  const rebuilt = readSourceGuestPayloadTargets(env) ?? [];
  const imports = new Map();
  for (const archive of archives) {
    const target = CLI_BINARY_TARGETS.find(target => target.os === archive?.target?.os && target.arch === archive?.target?.arch);
    if (!target || !/^[a-f0-9]{64}$/.test(archive.sha256 ?? '')
        || typeof archive.archivePath !== 'string' || !isAbsolute(archive.archivePath)) {
      throw new Error('[source-bundle] invalid registered guest archive metadata');
    }
    if (rebuilt.some(item => item.target.os === target.os && item.target.arch === target.arch)) {
      logger.error(`[source-bundle] registered guest archive skipped for ${target.os}/${target.arch}: local producer already builds this target`);
      continue;
    }
    imports.set(`${target.os}-${target.arch}`, { target: { os: target.os, arch: target.arch },
      sha256: archive.sha256, archivePath: archive.archivePath });
  }
  return [...imports.values()].sort((a, b) => `${a.target.os}-${a.target.arch}`.localeCompare(`${b.target.os}-${b.target.arch}`));
}

async function retainGuestArchive({ target, archivePath: source, sha256 }, outputDir, signal) {
  const archivePath = join(outputDir, 'guest-payload-archives', `${target.os}-${target.arch}.tar.gz`);
  await mkdir(dirname(archivePath), { recursive: true });
  await copyFile(source, archivePath);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archivePath, { signal })) hash.update(chunk);
  const digest = hash.digest('hex');
  if (sha256 && sha256 !== digest) throw new Error(`[source-bundle] registered guest archive checksum mismatch for ${target.os}/${target.arch}`);
  return { target: { os: target.os, arch: target.arch }, sha256: digest, archivePath };
}

export function sourceGuestPayloadEnvironment(payload) {
  return { HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: payload.root,
    HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_METADATA: JSON.stringify({ root: payload.root,
      identity: payload.identity, ...(payload.targetIdentities ? { targetIdentities: payload.targetIdentities } : {}),
      ...(payload.archives ? { archives: payload.archives } : {}) }) };
}

export async function buildSourceGuestPayload({ repoDir, sourceRepoDir, dependencyRootDir, outputDir, targets, sourceCapture, env, signal }) {
  const root = join(outputDir, 'guest-payload');
  const importedArchives = readSourceGuestPayloadArchiveImports(env);
  // The caller owns these captured inputs. Reuse canonical capture containment
  // for mounted installed dependencies; tree callers also name their pinned install.
  const captureContext = { HAPPIER_STACK_REPO_DIR: repoDir,
    HAPPIER_WORKSPACE_CAPTURE_SOURCE_REPO_DIR: dependencyRootDir ?? sourceRepoDir };
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
    const { createScpReadyPayloadArchive } = await loader.import(
      pathToFileURL(join(repoDir, 'packages/cli-common/src/systemTasks/kinds/createScpReadyPayloadArchive.ts')).href, import.meta.url);
    const runCommand = (command, args, options) => run(command, args, {
      ...options, env: { ...captureEnv, ...options?.env }, signal, stdio: 'ignore', captureFailureDiagnostic: true,
    });
    const targetIdentities = {};
    const exportedArchives = [];
    for (const { target, relativeDir } of targets) {
      signal?.throwIfAborted();
      // The payload owner builds the Iroh addon and Session holders from repoDir's Rust sources.
      const payload = await buildCliBinaryArtifactPayload({
        repoRoot: repoDir, payloadDir: join(root, relativeDir), target, runCommand,
      });
      targetIdentities[`${target.os}-${target.arch}`] = payload.identity;
      if (env.HAPPIER_DEV_GUEST_CLI_EXPORT === '1') {
        const archive = await createScpReadyPayloadArchive(join(root, relativeDir));
        try {
          exportedArchives.push(await retainGuestArchive({ target,
            archivePath: join(archive.archiveStageRoot, archive.archiveFileName) }, outputDir, signal));
        } finally { await archive.cleanup(); }
      }
    }
    for (const archive of importedArchives) {
      signal?.throwIfAborted();
      exportedArchives.push(await retainGuestArchive(archive, outputDir, signal));
    }
    const collection = targets.some(item => item.relativeDir);
    const identity = collection
      ? createHash('sha256').update(JSON.stringify(Object.entries(targetIdentities).sort(([a], [b]) => a.localeCompare(b)))).digest('hex')
      : Object.values(targetIdentities)[0];
    return { root, identity, sourceCapture, ...(collection ? { targetIdentities } : {}),
      ...(exportedArchives.length ? { archives: exportedArchives } : {}) };
  } finally {
    await loader?.unregister();
    for (const [key, value] of Object.entries(previousContext)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
