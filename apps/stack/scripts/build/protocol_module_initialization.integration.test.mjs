import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createWorkspaceSourceResolver, readWorkspacePackages } from '../../../../packages/cli-common/sourceRuntimeEntries.mjs';

test('bundled public Protocol initializes Action admission and WorkBoard preview contracts', async () => {
  const repoDir = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
  const workspacePackages = await readWorkspacePackages(repoDir);
  const result = await build({
    absWorkingDir: repoDir,
    stdin: {
      resolveDir: repoDir,
      contents: `
        import * as protocol from './packages/protocol/src/index.ts';
        import { PluginInvocableActionIdSchema, PLUGIN_INVOCABLE_ACTION_IDS } from './packages/protocol/src/actions/pluginActionSurface.ts';
        import { WorkBoardPreviewLayoutV1Schema, buildWorkBoardPreviewLayoutV1 } from './packages/protocol/src/boards/workBoardArtifactV1.ts';
        import { createWorkBoardV1 } from './packages/protocol/src/boards/workBoardV1.ts';
        import assert from 'node:assert/strict';
        assert.equal(protocol.HAPPY_PROTOCOL_PACKAGE, '@happier-dev/protocol');
        assert.equal(PluginInvocableActionIdSchema.parse('session.permission.respond'), 'session.permission.respond');
        assert.equal(PLUGIN_INVOCABLE_ACTION_IDS.includes('session.permission.respond'), true);
        assert.equal(PluginInvocableActionIdSchema.safeParse('session.handoff.commit').success, false);
        const preview = buildWorkBoardPreviewLayoutV1(createWorkBoardV1({ id: 'qa-board', name: 'QA' }));
        assert.deepEqual(WorkBoardPreviewLayoutV1Schema.parse(preview), preview);
        assert.equal(WorkBoardPreviewLayoutV1Schema.safeParse({ ...preview, mode: 'invalid' }).success, false);
      `,
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    plugins: [createWorkspaceSourceResolver({
      workspacePackages,
      requireFromProject: createRequire(new URL('../../../../packages/protocol/package.json', import.meta.url)),
    })],
  });
  const loaded = spawnSync(process.execPath, ['--input-type=commonjs'], {
    cwd: repoDir,
    input: result.outputFiles[0].text,
    encoding: 'utf8',
  });
  assert.equal(loaded.status, 0, loaded.stderr);
});
