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

export async function patchPackedTarballForBun(options = {}) {
  const tarballPath = String(options.tarballPath ?? '').trim() || resolveTarballPathFromEnv(options.env ?? process.env);
  if (!tarballPath) {
    throw new Error('[postpack] could not resolve packed tarball path (missing npm env?)');
  }
  if (!fs.existsSync(tarballPath)) {
    throw new Error(`[postpack] packed tarball not found: ${tarballPath}`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-cli-postpack-'));
  const extractedRoot = path.join(tmpDir, 'package');
  const pkgJsonPath = path.join(extractedRoot, 'package.json');
  const outTarballPath = path.join(tmpDir, `patched-${path.basename(tarballPath)}`);

  try {
    await tar.x({ file: tarballPath, cwd: tmpDir, strict: true });
    if (!fs.existsSync(pkgJsonPath)) {
      throw new Error(`[postpack] missing package.json inside tarball: ${pkgJsonPath}`);
    }

    const pkgJsonRaw = fs.readFileSync(pkgJsonPath, 'utf8');
    const pkgJsonParsed = JSON.parse(pkgJsonRaw);
    const patched = stripInternalWorkspaceDeps(pkgJsonParsed);

    fs.writeFileSync(pkgJsonPath, `${JSON.stringify(patched, null, 2)}\n`, 'utf8');

    await tar.c({ gzip: true, file: outTarballPath, cwd: tmpDir, portable: true }, ['package']);
    fs.renameSync(outTarballPath, tarballPath);

    return { tarballPath };
  } finally {
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
