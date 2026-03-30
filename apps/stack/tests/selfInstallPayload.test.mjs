import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('hstack self __install-payload installs an extracted hstack payload into the first-party runtime layout', () => {
  const testsDir = dirname(fileURLToPath(import.meta.url));
  const stackRoot = dirname(testsDir);
  const tmp = mkdtempSync(join(tmpdir(), 'hstack-self-install-payload-'));
  const happyHomeDir = join(tmp, 'happy-home');
  const payloadRoot = join(tmp, 'payload');
  mkdirSync(payloadRoot, { recursive: true });

  const binaryPath = join(payloadRoot, 'hstack');
  writeFileSync(binaryPath, '#!/bin/sh\nexit 0\n', 'utf8');
  chmodSync(binaryPath, 0o755);

  const result = spawnSync(
    process.execPath,
    [join(stackRoot, 'scripts', 'self.mjs'), '__install-payload', '--component', 'hstack', '--payload-root', payloadRoot, '--version', '1.2.3'],
    {
      cwd: stackRoot,
      env: {
        ...process.env,
        HAPPIER_HOME_DIR: happyHomeDir,
      },
      encoding: 'utf8',
    }
  );

  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.equal(existsSync(join(happyHomeDir, 'stack', 'current', 'hstack')), true);
  assert.equal(existsSync(join(happyHomeDir, 'bin', 'hstack')), true);
});
