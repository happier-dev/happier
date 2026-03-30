import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

test('tauri onboarding wizard QA exposes a deterministic capture plan', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const scriptPath = join(scriptsDir, 'tauriOnboardingWizardMcpQa.mjs');

  const { stdout } = await execFileAsync(process.execPath, [scriptPath, '--json'], {
    cwd: dirname(dirname(scriptsDir)),
    env: { ...process.env },
    encoding: 'utf8',
  });

  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, true);
  assert.match(String(payload.plan.artifactRoot), /bootstrap-qa[\\/]tauri-onboarding-wizard/);
  assert.equal(Array.isArray(payload.plan.steps), true);
  assert.deepEqual(
    payload.plan.steps.map((step) => step.id),
    ['welcome', 'relay', 'auth', 'restore', 'lost_access'],
  );
  assert.deepEqual(
    payload.plan.steps.find((step) => step.id === 'welcome')?.selectors,
    ['[data-testid="onboarding-wizard"]', '[data-testid="onboarding-wizard-primary"]', '[data-testid="onboarding-wizard-scan"]'],
  );
  assert.deepEqual(
    payload.plan.steps.find((step) => step.id === 'relay')?.selectors,
    [
      '[data-testid="onboarding-wizard-relay-diagram"]',
      '[data-testid="onboarding-wizard-relay:cloud"]',
      '[data-testid="onboarding-wizard-relay:thisMac"]',
      '[data-testid="onboarding-wizard-relay:customUrl"]',
      '[data-testid="onboarding-wizard-relay-url-input"]',
    ],
  );
  assert.equal(payload.plan.commandRunner.command, 'yarn');
  assert.deepEqual(payload.plan.commandRunner.baseArgs, ['-s', 'tauri:mcp:cli']);
  assert.equal(payload.plan.driverSession.command, 'yarn');
  assert.deepEqual(payload.plan.driverSession.baseArgs, ['-s', 'tauri:mcp:cli']);
  assert.deepEqual(payload.plan.driverSession.args, ['driver-session', 'start', '--port', '9223']);
});
