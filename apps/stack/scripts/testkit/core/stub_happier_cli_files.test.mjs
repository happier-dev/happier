import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createTempFixture } from './temp_fixture.mjs';
import { writeStubHappierCliFiles } from './stub_happier_cli_files.mjs';

test('writeStubHappierCliFiles writes package.json when requested', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-stub-happier-cli-files-' });

  await writeStubHappierCliFiles(fixture.root, {
    packageJsonContent: '{\"name\":\"stub-cli\"}\n',
    distIndexScript: 'process.exit(0);\n',
    binHappierScript: 'process.exit(0);\n',
  });

  const packageJson = await readFile(join(fixture.root, 'apps', 'cli', 'package.json'), 'utf-8');
  assert.equal(packageJson, '{"name":"stub-cli"}\n');
});
