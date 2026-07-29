import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as tar from 'tar';

function normalizePackNameForFilename(name) {
  const raw = String(name ?? '').trim();
  if (!raw) return '';
  return raw.replace(/^@/, '').replaceAll('/', '-');
}

function resolveExpectedTarballFilenameFromEnv(env) {
  const name = normalizePackNameForFilename(env?.npm_package_name);
  const version = String(env?.npm_package_version ?? '').trim();
  if (!name || !version) return '';
  return `${name}-${version}.tgz`;
}

function resolvePackDestinationFromEnv(env) {
  const raw = String(env?.npm_config_pack_destination ?? '').trim();
  if (!raw) return process.cwd();
  return path.resolve(process.cwd(), raw);
}

function resolveTarballPathFromEnv(env) {
  const destDir = resolvePackDestinationFromEnv(env);
  const expected = resolveExpectedTarballFilenameFromEnv(env);
  if (expected) {
    const candidate = path.join(destDir, expected);
    if (fs.existsSync(candidate)) return candidate;
  }

  // Fallback: pick the most recently modified tgz in the destination.
  try {
    const entries = fs.readdirSync(destDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.tgz'))
      .map((entry) => ({
        name: entry.name,
        mtimeMs: fs.statSync(path.join(destDir, entry.name)).mtimeMs,
      }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const newest = entries[0]?.name ?? '';
    if (newest) return path.join(destDir, newest);
  } catch {
    // ignore
  }

  return '';
}

function stripInternalWorkspaceDeps(pkgJson) {
  const deps = pkgJson?.dependencies && typeof pkgJson.dependencies === 'object' ? { ...pkgJson.dependencies } : null;
  if (!deps) return pkgJson;

  for (const key of Object.keys(deps)) {
    if (key.startsWith('@happier-dev/')) {
      delete deps[key];
    }
  }

  return {
    ...pkgJson,
    dependencies: deps,
  };
}

const CLI_PUBLISHED_BIN_CONTRACT = Object.freeze({
  happier: './bin/happier.mjs',
  'happier-dev': './bin/happier-dev.mjs',
  'happier-mcp': './bin/happier-mcp.mjs',
});

function restoreCliPublishedBinContract(pkgJson) {
  if (pkgJson?.name !== '@happier-dev/cli') {
    return pkgJson;
  }

  const currentBin = (pkgJson?.bin && typeof pkgJson.bin === 'object') ? { ...pkgJson.bin } : {};
  let changed = false;
  for (const [binName, binPath] of Object.entries(CLI_PUBLISHED_BIN_CONTRACT)) {
    if (currentBin[binName] !== binPath) {
      currentBin[binName] = binPath;
      changed = true;
    }
  }

  if (!changed && pkgJson.bin && Object.keys(currentBin).length === Object.keys(pkgJson.bin).length) {
    return pkgJson;
  }

  return {
    ...pkgJson,
    bin: currentBin,
  };
}

function readDeferredVoiceInferenceConfig(pkgJson) {
  const voiceInference = pkgJson?.happier?.voiceInference;
  const deferredRuntimePackages = Array.isArray(voiceInference?.deferredRuntimePackages)
    ? voiceInference.deferredRuntimePackages.map((value) => String(value ?? '').trim()).filter(Boolean)
    : [];
  const deferredRuntimeArchiveTargets = Array.isArray(voiceInference?.deferredRuntimeArchiveTargets)
    ? voiceInference.deferredRuntimeArchiveTargets.map((value) => String(value ?? '').trim()).filter(Boolean)
    : [];

  if (deferredRuntimePackages.length === 0 || deferredRuntimeArchiveTargets.length === 0) {
    return null;
  }

  return {
    deferredRuntimePackages,
    deferredRuntimeArchiveTargets,
  };
}

function hasCompleteDeferredVoiceInferenceArchiveMatrix({ packageRoot, deferredRuntimeArchiveTargets }) {
  return deferredRuntimeArchiveTargets.every((target) => (
    fs.existsSync(path.join(packageRoot, 'tools', 'archives', `voice-inference-runtime-${target}.tar.gz`))
  ));
}

function stripDeferredVoiceInferenceDepsIfArchived(pkgJson, { packageRoot }) {
  const config = readDeferredVoiceInferenceConfig(pkgJson);
  if (!config) {
    return pkgJson;
  }

  if (!hasCompleteDeferredVoiceInferenceArchiveMatrix({
    packageRoot,
    deferredRuntimeArchiveTargets: config.deferredRuntimeArchiveTargets,
  })) {
    return pkgJson;
  }

  const deps = pkgJson?.dependencies && typeof pkgJson.dependencies === 'object' ? { ...pkgJson.dependencies } : null;
  const optionalDeps = pkgJson?.optionalDependencies && typeof pkgJson.optionalDependencies === 'object'
    ? { ...pkgJson.optionalDependencies }
    : null;
  if (!deps && !optionalDeps) {
    return pkgJson;
  }

  for (const packageName of config.deferredRuntimePackages) {
    if (deps) delete deps[packageName];
    if (optionalDeps) delete optionalDeps[packageName];
  }

  return {
    ...pkgJson,
    ...(deps ? { dependencies: deps } : {}),
    ...(optionalDeps ? { optionalDependencies: optionalDeps } : {}),
  };
}

function readErrorCode(error) {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return '';
  }
  return typeof error.code === 'string' ? error.code : '';
}

function createDestinationLocalPath(tarballPath, kind) {
  return path.join(
    path.dirname(tarballPath),
    `.${path.basename(tarballPath)}.postpack-${kind}-${process.pid}-${randomUUID()}.tmp`,
  );
}

function replacePackedTarball(stagedTarballPath, tarballPath) {
  try {
    fs.renameSync(stagedTarballPath, tarballPath);
    return;
  } catch (error) {
    const code = readErrorCode(error);
    if (code !== 'EEXIST' && code !== 'EPERM') {
      throw error;
    }
  }

  const backupTarballPath = createDestinationLocalPath(tarballPath, 'backup');
  fs.renameSync(tarballPath, backupTarballPath);
  try {
    fs.renameSync(stagedTarballPath, tarballPath);
  } catch (error) {
    try {
      fs.renameSync(backupTarballPath, tarballPath);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        `[postpack] failed to promote patched tarball and restore previous destination: ${tarballPath}`,
      );
    }
    throw error;
  }

  fs.rmSync(backupTarballPath, { force: true });
}

export async function patchPackedTarballForBun(options = {}) {
  const env = options.env ?? process.env;
  if (String(env?.npm_config_dry_run ?? '').trim().toLowerCase() === 'true') {
    return {
      skipped: true,
      reason: 'npm-pack-dry-run',
    };
  }

  const tarballPath = String(options.tarballPath ?? '').trim() || resolveTarballPathFromEnv(env);
  if (!tarballPath) {
    throw new Error('[postpack] could not resolve packed tarball path (missing npm env?)');
  }
  if (!fs.existsSync(tarballPath)) {
    throw new Error(`[postpack] packed tarball not found: ${tarballPath}`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-cli-postpack-'));
  const extractedRoot = path.join(tmpDir, 'package');
  const pkgJsonPath = path.join(extractedRoot, 'package.json');
  const stagedTarballPath = createDestinationLocalPath(tarballPath, 'staging');

  try {
    await tar.x({ file: tarballPath, cwd: tmpDir, strict: true });
    if (!fs.existsSync(pkgJsonPath)) {
      throw new Error(`[postpack] missing package.json inside tarball: ${pkgJsonPath}`);
    }

    const pkgJsonRaw = fs.readFileSync(pkgJsonPath, 'utf8');
    const pkgJsonParsed = JSON.parse(pkgJsonRaw);
    const strippedInternal = stripInternalWorkspaceDeps(pkgJsonParsed);
    const strippedDeferredVoiceDeps = stripDeferredVoiceInferenceDepsIfArchived(strippedInternal, {
      packageRoot: extractedRoot,
    });
    const patched = restoreCliPublishedBinContract(strippedDeferredVoiceDeps);

    fs.writeFileSync(pkgJsonPath, `${JSON.stringify(patched, null, 2)}\n`, 'utf8');

    await tar.c({ gzip: true, file: stagedTarballPath, cwd: tmpDir, portable: true }, ['package']);
    replacePackedTarball(stagedTarballPath, tarballPath);

    return { tarballPath };
  } finally {
    try {
      fs.rmSync(stagedTarballPath, { force: true });
    } catch {
      // ignore
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // ignore
    }
  }
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return path.resolve(argv1) === path.resolve(fileURLToPath(import.meta.url));
})();

if (invokedAsMain) {
  patchPackedTarballForBun().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
