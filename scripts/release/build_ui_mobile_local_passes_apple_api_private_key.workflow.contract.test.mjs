import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('build-ui-mobile-local workflow passes APPLE_API_PRIVATE_KEY for iOS submit', () => {
  const src = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'build-ui-mobile-local.yml'), 'utf8');
  assert.match(src, /workflow_call:[\s\S]*?secrets:[\s\S]*?APPLE_API_PRIVATE_KEY:/);
  assert.match(src, /submit_ios:[\s\S]*?env:/);
  assert.match(src, /APPLE_API_PRIVATE_KEY:\s*\$\{\{\s*secrets\.APPLE_API_PRIVATE_KEY\s*\}\}/);
});

test('build-ui-mobile-local validation jobs use release-shared so environment secrets are available', () => {
  const src = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'build-ui-mobile-local.yml'), 'utf8');
  const expoBlock = src.match(/validate_expo_token:\n([\s\S]*?)\n  validate_apple_api_private_key:/)?.[1] ?? '';
  const appleBlock = src.match(/validate_apple_api_private_key:\n([\s\S]*?)\n  build_android:/)?.[1] ?? '';

  assert.match(expoBlock, /\benvironment:\s*release-shared/);
  assert.match(appleBlock, /\benvironment:\s*release-shared/);
});
