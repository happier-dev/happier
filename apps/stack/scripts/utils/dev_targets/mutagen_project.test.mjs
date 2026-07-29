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
    'target',
    '!packages/protocol/src/browser/target',
    '!packages/protocol/src/browser/target/**',
    'Pods',
    '.next',
    '.runner-snapshots',
    'package-dist',
    '.restore.*',
    '.dist.hstack-*',
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
  ]) {
    assert.ok(rendered.includes(`- "${ignored}"`));
  }
  assert.doesNotMatch(rendered, /beforeCreate|afterCreate|beforeTerminate|afterTerminate/);
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
