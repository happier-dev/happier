// postpack: vendor the repo-root build-system helpers that apps/stack/scripts/ reaches via
// `../../../../../` imports into the packed @happier-dev/stack tarball, and rewrite those escaping
// imports to the in-package vendored copies.
//
// Background: several apps/stack/scripts/ files import repo-root siblings through paths like
// `../../../../../scripts/workspaces/...` or `../../../../../packages/cli-common/...`. These
// resolve at the monorepo root in dev but, once @happier-dev/stack is `npm pack`-ed and installed
// standalone, the five `../` escape the package to the npm install root
// (`<prefix>/node_modules/scripts/...` / `.../packages/...`) — ENOENT. npm's `files` glob also
// cannot traverse parent dirs to include those files. So the packed tarball is broken for
// standalone consumers (hstack setup/start crash). This postpack (mirroring
// apps/cli/scripts/postpack/patchPackedTarballForBun.mjs) unpacks the tarball produced by
// `npm pack`, copies each escaped helper into package/scripts/utils/workspaces/, rewrites every
// escaping import to the in-package vendored copy, rewrites the helpers' own back-imports into
// apps/stack/scripts/utils/* to in-package relative paths, and repacks. The repo-root sources stay
// canonical for monorepo builds; only the published tarball is made self-contained.
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo-root-relative paths of the files that apps/stack/scripts/ reaches through escaping imports.
// Each is vendored into package/scripts/utils/workspaces/ (basename preserved). Keep in sync with
// the actual escaping imports in apps/stack/scripts/ (guarded by a source-drift test).
export const VENDOR_SPECS = Object.freeze([
  'scripts/workspaces/ensureWorkspacePackagesBuilt.mjs',
  'scripts/workspaces/execYarnCommand.mjs',
  'scripts/workspaces/workspacePackageBuildLock.mjs',
  'packages/cli-common/processInstance.mjs',
]);

// Escaping import prefix: five `../` from package/scripts/utils/<subdir>/ reaches the npm install
// root, escaping the @happier-dev/stack package. Each escaping import
// `<ESCAPE_PREFIX><spec>` is rewritten to the in-package `<VENDORED_PREFIX><basename>`.
const ESCAPE_IMPORT_PREFIX = '../../../../../';
const VENDORED_PREFIX = '../workspaces/';

// Vendored helpers (the scripts/workspaces/ ones) reach back into apps/stack/scripts/utils/* via
// this prefix; from their new in-package location (scripts/utils/workspaces/) the same targets are
// one level up. Applied to every vendored file (a no-op for files without such imports).
const BACK_TO_UTILS_IMPORT = '../../apps/stack/scripts/utils/';
const VENDORED_TO_UTILS_IMPORT = '../';

const VENDORED_DIR_REL = path.join('scripts', 'utils', 'workspaces');

export function rewriteBackToUtilsImport(content) {
  return content.split(BACK_TO_UTILS_IMPORT).join(VENDORED_TO_UTILS_IMPORT);
}

/**
 * Build the escaping-import → vendored-import rewrite map. Each spec's escaping import
 * `${ESCAPE_PREFIX}<repoPath>` maps to `${VENDORED_PREFIX}<basename>`.
 */
export function buildEscapeRewriteMap() {
  const map = new Map();
  for (const spec of VENDOR_SPECS) {
    const basename = path.basename(spec);
    map.set(`${ESCAPE_IMPORT_PREFIX}${spec}`, `${VENDORED_PREFIX}${basename}`);
  }
  return map;
}

export function applyRewriteMap(content, rewriteMap) {
  let out = content;
  for (const [from, to] of rewriteMap) {
    out = out.split(from).join(to);
  }
  return out;
}

function listMjsFilesRecursive(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listMjsFilesRecursive(full));
    } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Vendor the escaped helpers into an already-extracted `package/` dir and rewrite the affected
 * imports in place. Pure filesystem transform — no tarball logic — so it is unit-testable.
 */
export function patchExtractedPackage({ extractedPackageDir, monorepoRoot }) {
  if (!existsSync(extractedPackageDir)) {
    throw new Error(`[postpack] extracted package dir missing: ${extractedPackageDir}`);
  }

  const vendoredDir = path.join(extractedPackageDir, ...VENDORED_DIR_REL.split(path.sep));
  mkdirSync(vendoredDir, { recursive: true });

  for (const spec of VENDOR_SPECS) {
    const src = path.join(monorepoRoot, ...spec.split('/'));
    if (!existsSync(src)) {
      throw new Error(`[postpack] missing vendor source: ${src}`);
    }
    const content = readFileSync(src, 'utf8');
    writeFileSync(path.join(vendoredDir, path.basename(spec)), rewriteBackToUtilsImport(content));
  }

  const rewriteMap = buildEscapeRewriteMap();
  for (const file of listMjsFilesRecursive(path.join(extractedPackageDir, 'scripts'))) {
    const original = readFileSync(file, 'utf8');
    const rewritten = applyRewriteMap(original, rewriteMap);
    if (rewritten !== original) {
      writeFileSync(file, rewritten);
    }
  }
}

export function findMonorepoRootFrom(startDir) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 12; i++) {
    if (existsSync(path.join(dir, 'package.json')) && existsSync(path.join(dir, 'yarn.lock'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function normalizePackNameForFilename(name) {
  const raw = String(name ?? '').trim();
  if (!raw) return '';
  return raw.replace(/^@/, '').replaceAll('/', '-');
}

export function resolveTarballPathFromEnv(env, cwd = process.cwd()) {
  const destRaw = String(env?.npm_config_pack_destination ?? '').trim();
  const destDir = destRaw ? path.resolve(cwd, destRaw) : cwd;
  const name = normalizePackNameForFilename(env?.npm_package_name);
  const version = String(env?.npm_package_version ?? '').trim();
  if (name && version) {
    const candidate = path.join(destDir, `${name}-${version}.tgz`);
    if (existsSync(candidate)) return candidate;
  }
  try {
    const newest = readdirSync(destDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.tgz'))
      .map((entry) => ({ name: entry.name, mtimeMs: statSync(path.join(destDir, entry.name)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    if (newest) return path.join(destDir, newest.name);
  } catch {
    // ignore
  }
  return '';
}

/**
 * Patch the tarball produced by `npm pack` in place. Invoked as the stack package's `postpack`
 * lifecycle script (npm sets npm_package_name / npm_package_version / npm_config_pack_destination).
 * Also accepts explicit options for testing.
 */
export function patchPackedTarballForWorkspaces(options = {}) {
  const env = options.env ?? process.env;
  const tarballPath = String(options.tarballPath ?? '').trim() || resolveTarballPathFromEnv(env);
  if (!tarballPath) {
    throw new Error('[postpack] could not resolve packed tarball path (missing npm env?)');
  }
  if (!existsSync(tarballPath)) {
    throw new Error(`[postpack] packed tarball not found: ${tarballPath}`);
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const monorepoRoot = options.monorepoRoot ?? findMonorepoRootFrom(scriptDir);
  if (!monorepoRoot) {
    throw new Error('[postpack] could not locate monorepo root (package.json + yarn.lock)');
  }

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'happier-stack-postpack-'));
  try {
    execFileSync('tar', ['-xzf', tarballPath, '-C', tmpDir], { stdio: 'pipe' });
    const extractedPackageDir = path.join(tmpDir, 'package');
    if (!existsSync(extractedPackageDir)) {
      throw new Error(`[postpack] tarball did not contain package/: ${tarballPath}`);
    }

    patchExtractedPackage({ extractedPackageDir, monorepoRoot });

    const outTarball = path.join(tmpDir, path.basename(tarballPath));
    execFileSync('tar', ['-czf', outTarball, '-C', tmpDir, 'package'], { stdio: 'pipe' });

    // Replace the original tarball. copyFileSync + unlink is cross-device safe (the tmp dir may be
    // on a different mount than the pack destination); fs.renameSync would throw EXDEV there.
    copyFileSync(outTarball, tarballPath);
    unlinkSync(outTarball);

    return { tarballPath, vendored: VENDOR_SPECS.map((spec) => path.basename(spec)) };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return path.resolve(argv1) === path.resolve(fileURLToPath(import.meta.url));
})();

if (invokedAsMain) {
  try {
    const result = patchPackedTarballForWorkspaces();
    // eslint-disable-next-line no-console
    console.log(`[postpack] vendored workspace helpers into ${path.basename(result.tarballPath)}: ${result.vendored.join(', ')}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
