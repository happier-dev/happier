import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { pickNewestFile } from './notarize-macos-artifacts.mjs';

test('pickNewestFile returns the path with the newest mtime', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-tauri-notary-'));
  const a = path.join(dir, 'a.sig');
  const b = path.join(dir, 'b.sig');

  fs.writeFileSync(a, 'a');
  fs.writeFileSync(b, 'b');

  // Ensure deterministic mtimes: a is older, b is newer.
  const now = Date.now() / 1000;
  fs.utimesSync(a, now - 10, now - 10);
  fs.utimesSync(b, now, now);

  assert.equal(pickNewestFile([a, b]), b);

  fs.rmSync(dir, { recursive: true, force: true });
});

