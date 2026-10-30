import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { pickNewestFile } from './notarize-macos-artifacts.mjs';

test('pickNewestFile selects the newest real signature and the later entry on equal mtimes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-tauri-notary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = path.join(dir, 'Happier Dev.app.tar.gz.sig');
  const b = path.join(dir, 'Happier (dev).app.tar.gz.sig');

  fs.writeFileSync(a, 'a');
  fs.writeFileSync(b, 'b');

  // Ensure deterministic mtimes: a is older, b is newer.
  const now = Date.now() / 1000;
  fs.utimesSync(a, now - 10, now - 10);
  fs.utimesSync(b, now, now);

  assert.equal(pickNewestFile([a, b]), b);
  fs.utimesSync(a, now, now);
  assert.equal(pickNewestFile([a, b]), b);
  assert.equal(pickNewestFile([b, a]), a);
});

