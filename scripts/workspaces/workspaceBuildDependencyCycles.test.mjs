import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { withPatchedProcessEnv } from '../../apps/stack/scripts/testkit/core/env_scope.mjs';
import { createTempFixtureSync } from '../../apps/stack/scripts/testkit/core/temp_fixture.mjs';
import { prepareRemoteValidationWorkspace } from '../../apps/stack/scripts/utils/dev_targets/remote_validation_preparation.mjs';
import { ensureWorkspacePackagesBuiltForComponent } from './ensureWorkspacePackagesBuilt.mjs';

test('component preparation settles concurrent roots sharing a workspace dependency cycle', async (t) => {
  for (const peerCycle of [false, true]) {
    await t.test(peerCycle ? 'admitted peer cycle' : 'dependency cycle', async (t) => {
      const { root } = createTempFixtureSync(t, { prefix: 'happier-workspace-cycle-' });
      withPatchedProcessEnv(t, { HAPPIER_STACK_REPO_DIR: root, HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR: null });
      const { packageManager } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
      writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, packageManager }));
      writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
      for (const app of ['cli', 'ui', 'server']) {
        const dir = join(root, 'apps', app);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@fixture/${app}`,
          dependencies: { '@happier-dev/first': 'workspace:*', '@happier-dev/second': 'workspace:*' } }));
      }
      // Both packages are already source-consumable. Preparation must still
      // traverse their real graph, including an already admitted peer edge.
      for (const [name, dependency] of [['first', 'second'], ['second', 'first']]) {
        const dir = join(root, 'packages', name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@happier-dev/${name}`,
          [peerCycle ? 'peerDependencies' : 'dependencies']: { [`@happier-dev/${dependency}`]: 'workspace:*' } }));
      }
      const result = peerCycle
        ? await prepareRemoteValidationWorkspace({ repoDir: root, componentRelativeDir: 'apps/cli' })
        : await ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'cli'));
      assert.equal(result.ok, true);
      assert.deepEqual(result.built, []);
    });
  }
});
