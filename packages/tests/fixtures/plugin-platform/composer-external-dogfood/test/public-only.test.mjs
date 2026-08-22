import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('Composer dogfood evaluates through its public non-UI entrypoints', async () => {
  const [{ activate, manifest, readAcceptedMessageLocalIds }, composerHelpers] = await Promise.all([
    import('happier-composer-external-dogfood'),
    import('happier-composer-external-dogfood/composer'),
  ]);

  assert.equal(manifest.id, 'acme.composer.issue-dogfood');
  assert.equal(typeof activate, 'function');
  assert.equal(typeof readAcceptedMessageLocalIds, 'function');
  assert.equal(typeof composerHelpers.attachIssueWithoutControl, 'function');
  assert.equal(typeof composerHelpers.attachDaemonIssueMediaFromCurrentComposer, 'function');
  assert.equal(typeof composerHelpers.attachIssueMediaFromCurrentComposer, 'function');
  assert.equal(typeof composerHelpers.inspectAndReleaseIssueMediaFromCurrentComposer, 'function');
});

test('Composer dogfood package boundary has no workspace or private-package dependency', async () => {
  const packageJson = JSON.parse(await readFile(join(fixtureRoot, 'package.json'), 'utf8'));

  assert.equal(packageJson.private, true);
  assert.deepEqual(packageJson.files, ['.happier-plugin/plugin.json', 'dist', 'src']);
  assert.deepEqual(packageJson.exports, {
    '.': './src/index.mjs',
    './composer': './src/issueComposer.mjs',
    './ui': './src/issueSurface.mjs',
  });
  assert.equal(packageJson.dependencies['@happier-dev/protocol'], undefined);
  assert.equal(packageJson.dependencies['@happier-dev/plugin-sdk'].startsWith('workspace:'), false);
  assert.equal(packageJson.dependencies['@happier-dev/plugin-ui'].startsWith('workspace:'), false);
});

test('Composer dogfood public source and typecheck config contain no workspace aliases or private substitutions', async () => {
  const publicTsconfig = JSON.parse(await readFile(join(fixtureRoot, 'tsconfig.public.json'), 'utf8'));
  assert.equal(publicTsconfig.compilerOptions?.paths, undefined);
  assert.equal(publicTsconfig.compilerOptions?.typeRoots, undefined);

  for (const sourceFile of [
    'src/index.mjs',
    'src/issueComposer.mjs',
    'src/issueSurface.mjs',
    'src/uiBuildIdentity.mjs',
  ]) {
    const source = await readFile(join(fixtureRoot, sourceFile), 'utf8');
    assert.doesNotMatch(source, /(?:from\s+|import\s*\()['"](?:@happier-dev\/protocol|@\/|apps\/|[^'"]*\/src\/)/u);
  }
});
