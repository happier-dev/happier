import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { readSourceSelectionRollbackPaths, recordSourceSelectionRollback, restoreSourceSelectionRollback,
  settleSourceSelectionRollback } from './source_selection_rollback.mjs';

// P03 ORCH 2026-11-17: a reload whose replacement fails readiness after the
// incumbent's retirement restarts the incumbent's revision, which is still prepared.
test('a reload restores the selection it replaced, and only while that revision still exists', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-rollback-' });
  const stackBaseDir = fixture.path('stack');
  const sourceRoot = join(stackBaseDir, 'source-runtime');
  await mkdir(sourceRoot, { recursive: true });
  const entry = async name => { const path = fixture.path(`${name}/main.mjs`); await mkdir(fixture.path(name), { recursive: true }); await writeFile(path, ''); return path; };
  const selection = component => join(sourceRoot, `selected-${component}.json`);
  const read = async component => JSON.parse(await readFile(selection(component), 'utf8'));
  const incumbentServer = await entry('incumbent-server');
  await writeFile(selection('server'), JSON.stringify({ entrypoint: incumbentServer }));

  await assert.rejects(restoreSourceSelectionRollback({ stackBaseDir }), { code: 'ESOURCEROLLBACKUNAVAILABLE' });
  await recordSourceSelectionRollback({ stackBaseDir });
  assert.deepEqual(readSourceSelectionRollbackPaths(stackBaseDir), [incumbentServer]);
  // Activation then selects the replacement, including a component the incumbent never had.
  await writeFile(selection('server'), JSON.stringify({ entrypoint: await entry('replacement-server') }));
  await writeFile(selection('daemon'), JSON.stringify({ entrypoint: await entry('replacement-daemon') }));

  assert.deepEqual(await restoreSourceSelectionRollback({ stackBaseDir }), ['server', 'daemon']);
  assert.deepEqual(await read('server'), { entrypoint: incumbentServer });
  await assert.rejects(readFile(selection('daemon')), { code: 'ENOENT' });

  await settleSourceSelectionRollback({ stackBaseDir });
  assert.deepEqual(readSourceSelectionRollbackPaths(stackBaseDir), []);
  await assert.rejects(restoreSourceSelectionRollback({ stackBaseDir }), { code: 'ESOURCEROLLBACKUNAVAILABLE' });

  // A released incumbent revision cannot be restarted: refuse rather than select it.
  await recordSourceSelectionRollback({ stackBaseDir });
  await writeFile(selection('server'), JSON.stringify({ entrypoint: await entry('next-server') }));
  await rm(incumbentServer);
  await assert.rejects(restoreSourceSelectionRollback({ stackBaseDir }), { code: 'ESOURCEROLLBACKUNAVAILABLE' });
  assert.notEqual((await read('server')).entrypoint, incumbentServer, 'a refused restore keeps the current selection');
});
