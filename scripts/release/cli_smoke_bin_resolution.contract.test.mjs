import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveInstalledBinPath } from '../pipeline/smoke/resolveInstalledBinPath.mjs';

test('resolveInstalledBinPath falls back to the installed package bin when npm prefix shims are absent', () => {
  const prefixDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-smoke-prefix-'));
  const packageBinDir = path.join(prefixDir, 'lib', 'node_modules', '@happier-dev', 'cli', 'bin');
  fs.mkdirSync(packageBinDir, { recursive: true });

  const binPath = path.join(packageBinDir, 'happier.mjs');
  fs.writeFileSync(binPath, '#!/usr/bin/env node\n', 'utf8');

  const resolved = resolveInstalledBinPath(prefixDir, { platform: 'darwin' });
  assert.equal(resolved, binPath);
});
