import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { runNodeCapture } from '../testkit/core/run_node_capture.mjs';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';

const script = fileURLToPath(new URL('./concurrent_command.mjs', import.meta.url));

test('concurrent benchmark helper launches the requested number of identical commands', async (t) => {
  const fixture = await createTempFixture(t);
  const result = await runNodeCapture([
    script,
    '--count=3',
    '--',
    process.execPath,
    '-e',
    'require("node:fs").writeFileSync(require("node:path").join(process.argv[1], String(process.pid)), "started")',
    fixture.root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await readdir(fixture.root)).length, 3);
});

test('concurrent benchmark helper fails when one identical command fails and another succeeds', async (t) => {
  const fixture = await createTempFixture(t);
  const command = `
    const fs = require('node:fs');
    const { join } = require('node:path');
    const root = process.argv[1];
    let code = 7;
    try {
      fs.writeFileSync(join(root, 'claim'), '', { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      code = 0;
    }
    fs.writeFileSync(join(root, String(code)), '');
    process.exit(code);
  `;
  const result = await runNodeCapture([script, '--count=2', '--', process.execPath, '-e', command, fixture.root]);
  assert.equal(result.code, 7);
  assert.deepEqual((await readdir(fixture.root)).sort(), ['0', '7', 'claim']);
});
