import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

type PackageJson = Readonly<{
  scripts?: Readonly<Record<string, string>>;
}>;

type FallowConfig = Readonly<{
  $schema?: string;
  entry?: readonly string[];
  ignoreDependencies?: readonly string[];
  duplicates?: Readonly<{
    ignoreImports?: boolean;
  }>;
  audit?: Readonly<{
    gate?: string;
  }>;
}>;

const FALLOW_VERSION = '2.62.0';

function readJsonFile<T>(path: string): T {
  assert.equal(existsSync(path), true, `${path} must exist`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

test('root package exposes pinned local Fallow utility scripts', () => {
  const packageJson = readJsonFile<PackageJson>('package.json');
  const scripts = packageJson.scripts ?? {};

  const fallowScripts = [
    'fallow',
    'fallow:changed',
    'fallow:changed:json',
    'fallow:dead',
    'fallow:dupes',
    'fallow:health',
    'fallow:fix:dry',
    'fallow:baseline:save',
    'fallow:baseline:check',
  ];

  for (const scriptName of fallowScripts) {
    assert.match(scripts[scriptName] ?? '', new RegExp(`\\bfallow@${FALLOW_VERSION}\\b`), `${scriptName} must use the pinned Fallow version`);
  }
});

test('Fallow config is checked in while generated local state stays ignored', () => {
  const config = readJsonFile<FallowConfig>('.fallowrc.jsonc');
  const gitignore = readFileSync('.gitignore', 'utf8');

  assert.match(config.$schema ?? '', /fallow-rs\/fallow/);
  assert.equal(config.audit?.gate, 'new-only');
  assert.equal(config.duplicates?.ignoreImports, true);
  assert.ok(config.entry?.includes('scripts/**/*.{js,mjs,cjs,ts,tsx}'));
  assert.ok(config.entry?.includes('apps/*/scripts/**/*.{js,mjs,cjs,ts,tsx}'));
  assert.ok(config.ignoreDependencies?.includes('node:sqlite'));
  assert.match(gitignore, /^\/\.fallow\/$/m);
});
