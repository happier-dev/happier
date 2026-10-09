import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as projection from '../release/release-notes/project-release-notes.mjs';

const binding = { sourceSha: 'a'.repeat(40), releaseId: '2026-10-07.1', appVersion: '0.2.16', platform: 'ios' };
const bundle = () => ({ schemaVersion: 2, kind: projection.RELEASE_NOTES_BUNDLE_KIND,
  release: { id: binding.releaseId, sourceSha: binding.sourceSha, components: { ui: binding.appVersion } },
  projections: { appStore: { whatsNew: 'Approved Apple copy.' }, playStore: { whatsNew: 'Approved Play copy.' } } });

test('store publication consumes exact approved text only for the bound source, release and UI version', async (t) => {
  // This is the release projection consumer contract; no internal logic is mocked.
  assert.equal(typeof projection.readBoundStoreNotes, 'function', 'projection owner must validate store publication binding');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-notes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bundlePath = path.join(dir, 'notes.json');
  fs.writeFileSync(bundlePath, JSON.stringify(bundle()));
  assert.equal(projection.readBoundStoreNotes({ bundlePath, ...binding }), 'Approved Apple copy.');
  assert.equal(projection.readBoundStoreNotes({ bundlePath, ...binding, platform: 'android' }), 'Approved Play copy.');
  for (const mismatch of [{ sourceSha: 'b'.repeat(40) }, { releaseId: '2026-10-08.1' }, { appVersion: '0.2.17' }]) {
    assert.throws(() => projection.readBoundStoreNotes({ bundlePath, ...binding, ...mismatch }), { code: 'invalid_release_notes_binding' });
  }
});

test('missing and overlong store projections fail closed rather than using regenerated prose', (t) => {
  assert.equal(typeof projection.readBoundStoreNotes, 'function');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-notes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bundlePath = path.join(dir, 'notes.json');
  for (const notes of [undefined, { whatsNew: '' }, { whatsNew: 'x'.repeat(4001) }]) {
    const value = bundle();
    value.projections.appStore = notes;
    fs.writeFileSync(bundlePath, JSON.stringify(value));
    assert.throws(() => projection.readBoundStoreNotes({ bundlePath, ...binding }), { code: 'missing_store_release_notes' });
  }
});
