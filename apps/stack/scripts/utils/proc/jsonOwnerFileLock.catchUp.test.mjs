import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { withJsonOwnerFileLock } from './jsonOwnerFileLock.mjs';

test('lost native notifications cannot let a newcomer bypass the earlier waiting caller', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-json-owner-catch-up-' });
  const lockPath = fixture.path('owner.lock');
  // Some filesystems cannot deliver native events. Exercise the owner's real
  // existing catch-up path while the OS notification boundary stays silent.
  t.mock.method(fs, 'watch', () => Object.assign(new EventEmitter(), { close() {} }));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  let release;
  const holder = withJsonOwnerFileLock(() => new Promise(resolve => { release = resolve; }), { lockPath });
  const order = [];
  let observed;
  const waiting = new Promise(resolve => { observed = resolve; });
  const early = withJsonOwnerFileLock(() => { order.push('early'); }, { lockPath, onWait: observed });
  await waiting;
  release();
  await holder;
  const later = withJsonOwnerFileLock(() => { order.push('later'); }, { lockPath });
  await Promise.all([early, later]);
  assert.deepEqual(order, ['early', 'later']);
});
