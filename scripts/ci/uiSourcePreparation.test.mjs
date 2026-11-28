import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { promisify } from 'node:util';

import { createTempFixture } from '../../apps/stack/scripts/testkit/core/temp_fixture.mjs';
const execFileAsync = promisify(execFile);

test('focused UI validation publishes source assets through the checkout asset owner once', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-ui-source-preparation-' });
  const events = fixture.path('compiler-events');
  const boundary = (entryPoint, name) => `import { appendFileSync } from 'node:fs';
export async function ${entryPoint}() { appendFileSync(${JSON.stringify(events)}, '${name}\\n'); }`;
  await mkdir(fixture.path('apps/ui/tools/atmosphere'), { recursive: true });
  await mkdir(fixture.path('apps/ui/scripts'), { recursive: true });
  await writeFile(fixture.path('apps/ui/tools/atmosphere/buildAtmosphereRenderers.mjs'),
    boundary('buildAtmosphereRenderers', 'standalone compiler'));
  await writeFile(fixture.path('apps/ui/scripts/prepareSourceUiAssets.mjs'),
    boundary('prepareSourceUiAssets', 'source asset publisher'));

  const workspaceOwner = new URL('../../apps/stack/scripts/utils/dev_targets/remote_validation_workspace.mjs', import.meta.url).href;
  await execFileAsync(process.execPath, ['--input-type=module', '--eval', `
    import { prepareRemoteValidationWorkspace } from ${JSON.stringify(workspaceOwner)};
    await prepareRemoteValidationWorkspace({ repoDir: process.argv[1], componentRelativeDir: 'apps/ui',
      validationKind: 'source-test', focusedTest: true });
  `, fixture.root]);

  assert.equal(await readFile(events, 'utf8'), 'source asset publisher\n');
});
