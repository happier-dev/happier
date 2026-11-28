import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { delimiter } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { createTempFixture } from '../../apps/stack/scripts/testkit/core/temp_fixture.mjs';
import { EXTENDED_DB_OWNER_LABEL, extendedDbOwnerToken, selectOrphanedExtendedDbContainers } from '../../packages/tests/scripts/extended-db-docker.ownership.mjs';

const execFileAsync = promisify(execFile);

test('a stranded direct Workbench container can be identified by the existing owner reaper',
  { skip: process.platform === 'win32' }, async t => {
    const fixture = await createTempFixture(t, { prefix: 'happier-dbw-docker-ownership-' });
    const labelPath = fixture.path('owned-label');
    const stranded = '123456789abc';
    const active = '123456789def';
    await writeFile(fixture.path('docker'), `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
switch (args[0]) {
  case 'run': {
    const label = args.find(arg => arg.startsWith(${JSON.stringify(EXTENDED_DB_OWNER_LABEL + '=')}));
    writeFileSync(${JSON.stringify(labelPath)}, label?.split('=')[1] ?? '');
    console.log(${JSON.stringify(stranded)});
    break;
  }
  case 'port': console.log('127.0.0.1:54320'); break;
  case 'exec': break;
  default: process.exitCode = 2;
}
`, { mode: 0o700 });
    const owner = new URL('../../packages/tests/src/testkit/process/databaseWorkbenchPostgres.ts', import.meta.url).href;
    await execFileAsync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', `
      import { startDatabaseWorkbenchPostgres } from ${JSON.stringify(owner)};
      await startDatabaseWorkbenchPostgres();
    `], { env: { ...process.env, PATH: [fixture.root, process.env.PATH].join(delimiter) } });

    const label = await readFile(labelPath, 'utf8');
    assert.deepEqual(selectOrphanedExtendedDbContainers(
      `${stranded} ${label}\n${active} ${extendedDbOwnerToken()}\n`,
    ), [stranded]);
  });
