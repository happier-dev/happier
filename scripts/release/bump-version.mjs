#!/usr/bin/env node
/**
 * Bump versions for independent components.
 *
 * CI-oriented behavior:
 * - Updates versions on the currently checked-out branch (typically main),
 * - so workflows can then promote that commit to deploy branches.
 *
 * Supported:
 * - --component app|cli|server|website (required)
 * - --bump none|patch|minor|major (required)
 *
 * For "app", this updates:
 * - packages/app/package.json version
 * - packages/app/app.config.js expo.version (string literal)
 * - packages/app/src-tauri/*.json (if present) top-level "version"
 */
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const out = new Map();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const v = argv[i + 1];
    if (v && !v.startsWith('--')) {
      out.set(a, v);
      i++;
    } else {
      out.set(a, 'true');
    }
  }
  return out;
}

function fail(msg) {
  process.stderr.write(`[bump-version] ${msg}\n`);
  process.exit(1);
}

function normalizeSemverBase(raw) {
  const s = String(raw ?? '').trim();
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/.exec(s);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function bumpSemver(raw, bump) {
  const base = normalizeSemverBase(raw);
  if (!base) fail(`Invalid semver "${raw}"`);
  const next = { ...base };
  if (bump === 'major') {
    next.major += 1;
    next.minor = 0;
    next.patch = 0;
  } else if (bump === 'minor') {
    next.minor += 1;
    next.patch = 0;
  } else if (bump === 'patch') {
    next.patch += 1;
  } else {
    fail(`Unknown bump "${bump}"`);
  }
  return `${next.major}.${next.minor}.${next.patch}`;
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, `${JSON.stringify(obj, null, 2)}\n`);
}

function updatePackageJsonVersion(pkgDir, nextVersion) {
  const pkgPath = path.join(pkgDir, 'package.json');
  const pkg = readJson(pkgPath);
  pkg.version = nextVersion;
  writeJson(pkgPath, pkg);
}

function updateExpoAppConfigVersion(appDir, nextVersion) {
  const filePath = path.join(appDir, 'app.config.js');
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, 'utf8');

  const re = /(\bversion\s*:\s*["'])([^"']+)(["'])/;
  const m = re.exec(raw);
  if (!m) fail(`Unable to find expo.version string literal in ${filePath}`);

  const updated = raw.replace(re, `$1${nextVersion}$3`);
  fs.writeFileSync(filePath, updated);
}

function updateTauriVersions(appDir, nextVersion) {
  const tauriDir = path.join(appDir, 'src-tauri');
  if (!fs.existsSync(tauriDir)) return;
  const files = fs.readdirSync(tauriDir).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    const p = path.join(tauriDir, f);
    const obj = readJson(p);
    if (typeof obj?.version === 'string') {
      obj.version = nextVersion;
      writeJson(p, obj);
    }
  }
}

function getAppCurrentVersion(appDir) {
  const configPath = path.join(appDir, 'app.config.js');
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf8');
    const re = /(\bversion\s*:\s*["'])([^"']+)(["'])/;
    const m = re.exec(raw);
    if (m) return m[2];
  }
  const pkgPath = path.join(appDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = readJson(pkgPath);
    if (typeof pkg.version === 'string' && pkg.version.trim()) return pkg.version.trim();
  }
  return null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const component = String(args.get('--component') ?? '').trim();
  const bump = String(args.get('--bump') ?? '').trim();

  const repoRoot = process.cwd();
  const componentDirByName = {
    app: path.join(repoRoot, 'packages', 'app'),
    cli: path.join(repoRoot, 'packages', 'cli'),
    server: path.join(repoRoot, 'packages', 'server'),
    website: path.join(repoRoot, 'packages', 'website'),
  };

  if (!component || !(component in componentDirByName)) {
    fail(`--component must be one of: ${Object.keys(componentDirByName).join(', ')}`);
  }
  if (!bump || !['none', 'patch', 'minor', 'major'].includes(bump)) {
    fail(`--bump must be one of: none, patch, minor, major`);
  }

  const dir = componentDirByName[component];
  if (!fs.existsSync(dir)) fail(`Missing component directory: ${dir}`);

  if (bump === 'none') {
    process.stdout.write(`SKIP\n`);
    return;
  }

  let currentVersion = null;
  if (component === 'app') {
    currentVersion = getAppCurrentVersion(dir);
  } else {
    const pkg = readJson(path.join(dir, 'package.json'));
    currentVersion = String(pkg.version ?? '').trim() || null;
  }
  if (!currentVersion) fail(`Unable to determine current version for ${component}`);

  const nextVersion = bumpSemver(currentVersion, bump);

  if (component === 'app') {
    updatePackageJsonVersion(dir, nextVersion);
    updateExpoAppConfigVersion(dir, nextVersion);
    updateTauriVersions(dir, nextVersion);
  } else {
    updatePackageJsonVersion(dir, nextVersion);
  }

  process.stdout.write(`${nextVersion}\n`);
}

main();
