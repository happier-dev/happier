// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * @param {string} version
 * @returns {{ major: number; minor: number; patch: number }}
 */
function parseStableSemver(version) {
  const raw = String(version ?? '').trim();
  const m = raw.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) {
    fail(`version must be a stable semver like '1.2.3' (got: ${JSON.stringify(version)})`);
  }
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * @param {string} version
 * @param {'patch'|'minor'|'major'} bump
 */
function bumpStableSemver(version, bump) {
  const parsed = parseStableSemver(version);
  if (bump === 'patch') return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
  if (bump === 'minor') return `${parsed.major}.${parsed.minor + 1}.0`;
  if (bump === 'major') return `${parsed.major + 1}.0.0`;
  fail(`--bump must be 'patch', 'minor', or 'major' (got: ${bump})`);
}

/**
 * @param {string} filePath
 * @returns {any}
 */
function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

/**
 * @param {string} filePath
 * @param {any} value
 */
function writeJson(filePath, value) {
  const out = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(filePath, out, 'utf8');
}

function main() {
  const repoRoot = path.resolve(process.cwd());
  const { values } = parseArgs({
    options: {
      bump: { type: 'string', default: '' },
      version: { type: 'string', default: '' },
      'package-json': { type: 'string', default: 'apps/ui/package.json' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const bump = String(values.bump ?? '').trim().toLowerCase();
  const version = String(values.version ?? '').trim();
  const packageJsonRel = String(values['package-json'] ?? '').trim() || 'apps/ui/package.json';
  const dryRun = values['dry-run'] === true;

  if (!bump && !version) {
    fail("Either --bump or --version is required.");
  }
  if (bump && version) {
    fail('Pass only one of --bump or --version (not both).');
  }
  if (bump && bump !== 'patch' && bump !== 'minor' && bump !== 'major') {
    fail(`--bump must be 'patch', 'minor', or 'major' (got: ${bump})`);
  }

  const packageJsonAbs = path.isAbsolute(packageJsonRel) ? packageJsonRel : path.join(repoRoot, packageJsonRel);
  if (!fs.existsSync(packageJsonAbs)) {
    fail(`Missing package.json at: ${packageJsonAbs}`);
  }

  const pkg = readJson(packageJsonAbs);
  const current = String(pkg?.version ?? '').trim();
  if (!current) {
    fail(`Missing package.json version at: ${packageJsonAbs}`);
  }

  const next = version ? parseStableSemver(version) && version : bumpStableSemver(current, /** @type {any} */ (bump));

  if (!dryRun) {
    pkg.version = next;
    writeJson(packageJsonAbs, pkg);
  }

  const printable = path.relative(repoRoot, packageJsonAbs) || packageJsonAbs;
  console.log(
    JSON.stringify(
      {
        ok: true,
        file: printable,
        current,
        next,
        dryRun,
      },
      null,
      2,
    ),
  );
}

main();

