import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('the e2e heartbeat owner drops passing run logs and retains failed run logs', t => {
  const parent = mkdtempSync(join(tmpdir(), 'happier-e2e-log-retention-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  writeFileSync(join(parent, 'other-run.log'), 'keep');
  const evidenceDir = join(parent, 'evidence');
  mkdirSync(evidenceDir);
  for (const { label, code, configured, retained } of [
    { label: 'default-pass', code: 0, retained: false },
    { label: 'default-fail', code: 1, retained: true },
    { label: 'evidence-pass', code: 0, configured: evidenceDir, retained: true },
    { label: 'empty-explicit-pass', code: 0, configured: '' },
  ]) {
    const capture = join(parent, label);
    const command = `
      const { writeFileSync } = require('node:fs');
      const { join } = require('node:path');
      const owned = process.env.HAPPIER_E2E_OWNED_RUN_LOGS_DIR;
      const root = process.env.HAPPIER_E2E_LOGS_DIR || owned;
      writeFileSync(process.argv[1], JSON.stringify({ root, owned, configured: process.env.HAPPIER_E2E_LOGS_DIR }));
      if (root) writeFileSync(join(root, 'test.log'), 'test output');
      process.exit(Number(process.argv[2]));
    `;
    const wrapper = `
      import { runHeartbeatWrappedCommand } from ${JSON.stringify(new URL('./runPlaywrightWithHeartbeat.shared.mjs', import.meta.url).href)};
      await runHeartbeatWrappedCommand({
        toolName: 'vitest', command: process.execPath,
        args: ['-e', ${JSON.stringify(command)}, ${JSON.stringify(capture)}, ${code}],
        runLogBaseDir: ${JSON.stringify(parent)}, spawnOptions: { stdio: 'inherit', env: process.env },
        resolveExitCode: result => result.code,
      });
    `;
    const env = { ...process.env };
    if (configured !== undefined) env.HAPPIER_E2E_LOGS_DIR = configured;
    else delete env.HAPPIER_E2E_LOGS_DIR;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', wrapper], {
      encoding: 'utf8', env,
    });
    assert.equal(result.status, code, result.stderr);
    const { root: runDir, owned, configured: configuredInChild } = JSON.parse(readFileSync(capture, 'utf8'));
    assert.equal(configuredInChild, configured, 'only caller-set overrides reach setup cache readers');
    if (configured !== undefined) assert.equal(owned, undefined, 'caller-defined overrides never create an owned run');
    if (runDir) assert.equal(existsSync(join(runDir, 'test.log')), retained, label);
    if (configured) assert.equal(runDir, configured);
  }
  assert.equal(readFileSync(join(parent, 'other-run.log'), 'utf8'), 'keep');
});
