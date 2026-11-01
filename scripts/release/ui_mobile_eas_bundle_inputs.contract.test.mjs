import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const uiRoot = path.join(repoRoot, 'apps', 'ui');

const RELATIVE_IMPORT = /(?:from|import\(|require\()\s*['"](\.{1,2}\/[^'"]+)['"]/g;
const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST_FILE = /\.(test|spec)\.[jt]sx?$/;

/** Repository-relative targets inside apps/ui that shipped (non-test) sources import relatively. */
function collectRelativeImportTargets() {
  const targets = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(file);
        continue;
      }
      if (!SOURCE_FILE.test(entry.name) || TEST_FILE.test(entry.name)) continue;
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(RELATIVE_IMPORT)) {
        const absolute = path.resolve(path.dirname(file), match[1]);
        if (path.relative(uiRoot, absolute).startsWith('..')) continue;
        const target = path.relative(repoRoot, absolute).split(path.sep).join('/');
        if (!targets.has(target)) targets.set(target, path.relative(repoRoot, file));
      }
    }
  };
  walk(path.join(uiRoot, 'sources'));
  return targets;
}

/**
 * Ignore rule sets as eas-cli (git VCS mode) applies them when copying the project for a build:
 * a repository-root .easignore replaces everything; otherwise every .gitignore applies to paths
 * under its directory, and a path is skipped when ANY rule set ignores it.
 */
function easCopyRuleSets() {
  const rootEasignore = path.join(repoRoot, '.easignore');
  if (fs.existsSync(rootEasignore)) return [{ prefix: '', rules: fs.readFileSync(rootEasignore, 'utf8') }];
  // Like eas-cli's glob, every .gitignore outside node_modules (and the .git directory) applies.
  const ruleSets = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git') walk(path.join(dir, entry.name));
      } else if (entry.name === '.gitignore') {
        const prefix = path.relative(repoRoot, dir).split(path.sep).join('/');
        ruleSets.push({ prefix: prefix ? `${prefix}/` : '', rules: fs.readFileSync(path.join(dir, entry.name), 'utf8') });
      }
    }
  };
  walk(repoRoot);
  return ruleSets;
}

/** Evaluates one rule set with git's matcher in an empty sandbox, so paths are matched as plain paths. */
function listIgnoredBy(rules, relativePaths) {
  if (relativePaths.length === 0) return [];
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-eas-copy-'));
  try {
    execFileSync('git', ['init', '-q', sandbox]);
    fs.writeFileSync(path.join(sandbox, '.gitignore'), rules);
    try {
      return execFileSync('git', ['-C', sandbox, 'check-ignore', '--no-index', '--stdin'], {
        input: `${relativePaths.join('\n')}\n`,
        encoding: 'utf8',
      }).split('\n').filter(Boolean);
    } catch (error) {
      // git check-ignore exits 1 when no path is ignored.
      if (error.status === 1) return [];
      throw error;
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

/**
 * eas-cli copies the tree with a filter that tests every directory and file by its relative path
 * without a trailing slash, so an ignored ancestor directory drops its whole subtree even when a
 * directory-only negation ("dir/") re-includes it for git.
 */
function listExcludedFromEasCopy(targets) {
  const pathsToTest = new Set();
  for (const target of targets) {
    const segments = target.split('/');
    for (let index = 1; index <= segments.length; index += 1) pathsToTest.add(segments.slice(0, index).join('/'));
  }
  const ignored = new Set();
  for (const { prefix, rules } of easCopyRuleSets()) {
    const scoped = [...pathsToTest].filter((candidate) => candidate.startsWith(prefix) && candidate.length > prefix.length);
    for (const relative of listIgnoredBy(rules, scoped.map((candidate) => candidate.slice(prefix.length)))) {
      ignored.add(`${prefix}${relative}`);
    }
  }
  return targets.filter((target) => {
    const segments = target.split('/');
    return segments.some((_, index) => ignored.has(segments.slice(0, index + 1).join('/')));
  });
}

test('EAS build copies include every apps/ui module that shipped sources import', () => {
  const targets = collectRelativeImportTargets();
  const outsideSources = [...targets.keys()].filter((target) => !target.startsWith('apps/ui/sources/'));
  assert.ok(outsideSources.includes('apps/ui/public/vendor/kokoro/resolveKokoroVoice.js'),
    'expected the shared Kokoro voice resolver import to be inspected');
  const excluded = listExcludedFromEasCopy(outsideSources).map((target) => `${target} (imported by ${targets.get(target)})`);
  assert.deepEqual(excluded, [], 'native EAS bundles cannot resolve imports that the EAS project copy drops');
});
