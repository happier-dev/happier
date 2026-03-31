import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

test('tauri MCP QA plan includes wizard QA as the default run mode', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriMcpQa.mjs');

    const { stdout } = await execFileAsync(process.execPath, [scriptPath, '--json'], {
        cwd: dirname(scriptsDir),
        env: { ...process.env },
        encoding: 'utf8',
    });

    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, true);
    assert.equal(typeof payload.plan.runWizard, 'boolean');
    assert.equal(payload.plan.runWizard, true);
    assert.equal(typeof payload.plan.keepRunning, 'boolean');
    assert.equal(payload.plan.keepRunning, false);
    assert.equal(typeof payload.plan.logDir, 'string');
    assert.match(payload.plan.logDir, /bootstrap-qa[\\/]tauri-qa-/);
    assert.equal(typeof payload.plan.wizardQa, 'object');
    assert.equal(payload.plan.wizardQa?.script, 'scripts/qa/tauriOnboardingWizardMcpQa.mjs');
});

test('tauri MCP QA --serve disables wizard one-shot mode', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriMcpQa.mjs');

    const { stdout } = await execFileAsync(process.execPath, [scriptPath, '--json', '--serve'], {
        cwd: dirname(scriptsDir),
        env: { ...process.env },
        encoding: 'utf8',
    });

    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.plan.keepRunning, true);
    assert.equal(payload.plan.runWizard, false);
});
