import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMutagenProjectArgs,
  renderMutagenProject,
  resolveMutagenSessionName,
} from './mutagen_project.mjs';

const targets = [
  {
    name: 'linux',
    platform: 'posix',
    ssh: 'happier-stack-linux',
    repoDir: '/home/dev/happier',
    cliHomeDir: '/home/dev/.happier-stack/dev-targets/linux',
    remoteServerPort: null,
  },
  {
    name: 'windows',
    platform: 'windows',
    ssh: 'happier-stack-windows',
    repoDir: 'C:/Users/test_qa/happier',
    cliHomeDir: 'C:/Users/test_qa/.happier-stack/dev-targets/windows',
    remoteServerPort: null,
  },
];

test('renderMutagenProject creates one-way source replicas while retaining target-local build state', () => {
  const rendered = renderMutagenProject({
    sourceDir: '/Users/dev/happier',
    targets,
  });

  assert.match(rendered, /mode: "one-way-replica"/);
  assert.doesNotMatch(rendered, /flushOnCreate/);
  assert.ok(rendered.includes('alpha: "/Users/dev/happier"'));
  assert.ok(rendered.includes('beta: "happier-stack-linux:/home/dev/happier"'));
  assert.ok(rendered.includes('beta: "happier-stack-windows:C:/Users/test_qa/happier"'));
  assert.equal(
    rendered.match(/configurationBeta:\n\s+watch:\n\s+mode: "no-watch"/g)?.length,
    targets.length,
    'one-way replicas must not watch target-local build and cache writes',
  );
  assert.match(rendered, /vcs: true/);
  for (const ignored of [
    'node_modules',
    'dist',
    'dist.staging.*',
    'dist.__finalize_backup__.*',
    'dist.__sync_tmp__.*',
    'dist.__sync_backup__.*',
    'package-dist.__sync_tmp__.*',
    'package-dist.__sync_backup__.*',
    '.*.__sync_tmp__.*',
    '.*.__sync_backup__.*',
    '.tmp.*',
    '.backup.*',
    '.happier-plugin-ui-build-*',
    'packages/brand/brand',
    '.project',
    '.happier',
    'coverage',
    '/output',
    '.reviews',
    '.agent-contexts',
    '.dev',
    '.clawpatch',
    '.playwright-mcp',
    '.antigravitycli',
    'evidence',
    'graphify-out',
    '/workspace',
    '.expo',
    '.turbo',
    '.slopo',
    'target',
    '!packages/protocol/src/browser/target',
    '!packages/protocol/src/browser/target/**',
    'Pods',
    '.next',
    '.runner-snapshots',
    'package-dist',
    '.restore.*',
    '.dist.hstack-*',
    '.dist.build.*',
    '.dist.backup.*',
    '.tsbuildinfo.build.*',
    '*.tsbuildinfo',
    '.cxx',
    'apps/ui/ios/build',
    'apps/ui/android/app/build',
    'apps/ui/android/build',
    'apps/ui/android/.gradle',
    'packages/*/android/build',
    'apps/cli/tmp',
    'apps/cli/tools/unpacked',
    'apps/cli/*:*',
    'subagents/dev-plugin-projection-runtime-closure',
    '*.trace',
    '!apps/cli/src/plugins/testkit/fixtures/packed-external-voice-provider/dist',
    '!apps/cli/src/plugins/testkit/fixtures/packed-external-voice-provider/dist/**',
    '!/.project',
    '/.project/*',
    '!/.project/plans',
    '!/.project/plans/**',
    '!/.project/tasks',
    '!/.project/tasks/**',
    '!/.project/scripts',
    '!/.project/scripts/**',
    '!/.project/*.md',
    '/.project/plans/runtime-unification-v2/_validation/source-reality-review/qa/lane-A/repo-importers-map.json',
    '/.project/plans/plugin-sdk-author-surface-convergence/CLAUDE-AUDIT-JOURNAL.md',
    '/.project/plans/**/*.har',
    '/.project/plans/**/*.png',
    '/.project/plans/**/*.webm',
    '/.project/plans/**/*.pyc',
    '/.project/plans/**/*.log',
    '/.project/plans/**/*.trace',
    '/.project/plans/**/.DS_Store',
  ]) {
    assert.ok(rendered.includes(`- "${ignored}"`));
  }

  for (const replicaOwnedProjection of [
    'apps/cli/src/plugins/projection/registry/sources/generatedBundledPluginArtifacts.ts',
    'apps/ui/sources/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts.ts',
    'apps/ui/sources/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts.web.ts',
    'apps/ui/sources/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts.ios.ts',
    'apps/ui/sources/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts.android.ts',
  ]) {
    assert.ok(rendered.includes(`- "${replicaOwnedProjection}"`));
  }
  assert.ok(
    !rendered.includes('- "apps/cli/src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts"'),
    'serialized manifest facts must reach command-only targets through the source replica',
  );
  assert.ok(
    rendered.indexOf('- "/.project/*"')
      < rendered.indexOf('- "!/.project/plans"'),
    'the project root must be traversable before searchable children are selected',
  );
  assert.ok(
    rendered.indexOf('- "!/.project/plans/**"')
      < rendered.indexOf('- "/.project/plans/**/*.har"'),
    'binary and sensitive plan exclusions must be applied after the searchable plan exception',
  );
  assert.doesNotMatch(
    rendered,
    /^\s+- "!\.project"$/m,
    'the root exception must not re-include nested package .project directories',
  );
  assert.doesNotMatch(rendered, /beforeCreate|afterCreate|beforeTerminate|afterTerminate/);
});

test('renderMutagenProject re-includes tracked source coverage without unignoring generated coverage', () => {
  const rendered = renderMutagenProject({
    sourceDir: '/Users/dev/happier',
    targets,
  });

  assert.deepEqual(
    rendered
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('coverage')),
    [
      '- "coverage"',
      '- "!packages/triage-qa/src/coverage"',
      '- "!packages/triage-qa/src/coverage/**"',
    ],
    'the generic generated-coverage ignore must precede the tracked source exception',
  );
});

test('renderMutagenProject re-includes tracked fixture target directories without unignoring build output', () => {
  const rendered = renderMutagenProject({
    sourceDir: '/Users/dev/happier',
    targets,
  });

  assert.deepEqual(
    rendered
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /target(?:\/\*\*)?"$/.test(line)),
    [
      '- "target"',
      '- "!packages/protocol/src/browser/target"',
      '- "!packages/protocol/src/browser/target/**"',
      '- "!packages/plugin-sdk/fixtures/external-targeted-packages/target"',
      '- "!packages/plugin-sdk/fixtures/external-targeted-packages/target/**"',
      '- "!packages/tests/fixtures/plugin-platform/packed-targeted-contribution-projection/target"',
      '- "!packages/tests/fixtures/plugin-platform/packed-targeted-contribution-projection/target/**"',
    ],
    'the Rust build-output ignore must not swallow tracked fixture directories named `target`',
  );
});

test('buildMutagenProjectArgs isolates global configuration and addresses the generated project explicitly', () => {
  assert.deepEqual(buildMutagenProjectArgs('start', '/tmp/stack/mutagen.yml'), [
    'project',
    'start',
    '--paused',
    '--no-global-configuration',
    '--project-file',
    '/tmp/stack/mutagen.yml',
  ]);
  assert.deepEqual(buildMutagenProjectArgs('list', '/tmp/stack/mutagen.yml'), [
    'project',
    'list',
    '--project-file',
    '/tmp/stack/mutagen.yml',
  ]);
});

test('resolveMutagenSessionName matches the generated project session key', () => {
  assert.equal(resolveMutagenSessionName('linux'), 'happier-linux');
  const distinctNames = ['qa.linux', 'qa-linux', 'qa_linux'].map(resolveMutagenSessionName);
  assert.equal(new Set(distinctNames).size, distinctNames.length);
  assert.ok(distinctNames.every((name) => /^[A-Za-z][A-Za-z0-9-]*$/.test(name)));
  const escapedName = resolveMutagenSessionName('qa.linux');
  assert.match(
    renderMutagenProject({ sourceDir: '/source', targets: [{ ...targets[0], name: 'qa.linux' }] }),
    new RegExp(`${escapedName}:`),
  );
});
