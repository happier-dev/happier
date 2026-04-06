import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
    ['welcome', 'auth_skip', 'relay', 'welcome_back', 'auth', 'restore', 'lost_access'],
  );
  assert.deepEqual(
    payload.plan.steps.find((step) => step.id === 'welcome')?.selectors,
    [
      '[data-testid="onboarding-wizard"]',
      '[data-testid="onboarding-wizard-primary"]',
      '[data-testid="onboarding-wizard-scan"]',
      '[data-testid="onboarding-wizard-skip"]',
    ],
  );
  assert.equal(payload.plan.steps.find((step) => step.id === 'auth_skip')?.screenshot, '02-auth-skip.png');
  assert.deepEqual(
    payload.plan.steps.find((step) => step.id === 'relay')?.selectors,
    [
      '[data-testid="onboarding-wizard-relay-diagram"]',
      '[data-testid="onboarding-wizard-relay:cloud"]',
      '[data-testid="onboarding-wizard-relay:thisComputer"]',
      '[data-testid="onboarding-wizard-relay:customUrl"]',
    ],
  );
  assert.equal(payload.plan.steps.find((step) => step.id === 'welcome_back')?.screenshot, '04-welcome-back.png');
  assert.equal(payload.plan.commandRunner.command, 'yarn');
  assert.deepEqual(payload.plan.commandRunner.baseArgs, ['-s', 'tauri:mcp:cli']);
  assert.deepEqual(payload.plan.timeouts, { selectorWaitMs: 8000, cliSelectorWaitTimeoutMs: 20000, cliInteractTimeoutMs: 20000 });
  assert.equal(payload.plan.driverSession.command, 'yarn');
  assert.deepEqual(payload.plan.driverSession.baseArgs, ['-s', 'tauri:mcp:cli']);
  assert.deepEqual(payload.plan.driverSession.args, ['driver-session', 'start', '--port', '9225']);
});

test('tauri onboarding wizard QA can derive fallback MCP ports', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const scriptPath = join(scriptsDir, 'tauriOnboardingWizardMcpQa.mjs');
  const module = await import(pathToFileURL(scriptPath).href);

  assert.equal(typeof module.resolveCandidateDriverSessionPorts, 'function');
  const ports = module.resolveCandidateDriverSessionPorts({ preferredPort: 9225, env: {} });
  assert.deepEqual(ports.slice(0, 5), [9225, 9223, 9224, 9226, 9227]);
  assert.equal(ports.includes(9226), true);
  assert.equal(ports.includes(9223), true);
});

test('tauri onboarding wizard QA only accepts the preferred connected app when multiple apps are reported', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const scriptPath = join(scriptsDir, 'tauriOnboardingWizardMcpQa.mjs');
  const module = await import(pathToFileURL(scriptPath).href);

  assert.equal(typeof module.resolveConnectedAppIdentifierFromDriverStatus, 'function');
  assert.equal(typeof module.resolvePreferredAppIdentifierFromDriverStatus, 'function');

  const status = {
    connected: true,
    apps: [
      { name: 'Tauri App (localhost:9223)', identifier: 'dev.happier.app.publicdev', host: 'localhost', port: 9223, isDefault: true },
      { name: 'Tauri App (localhost:9224)', identifier: 'com.happier.stack.activity-surfaces-qa', host: 'localhost', port: 9224, isDefault: false },
    ],
    totalCount: 2,
    defaultPort: 9223,
  };

  assert.equal(module.resolveConnectedAppIdentifierFromDriverStatus(status), 9223);
  assert.equal(module.resolvePreferredAppIdentifierFromDriverStatus(status, 9224), 9224);
  assert.equal(module.resolvePreferredAppIdentifierFromDriverStatus(status, 9225), null);
});

test('tauri onboarding wizard QA only accepts a driver session that resolves to the requested port', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const scriptPath = join(scriptsDir, 'tauriOnboardingWizardMcpQa.mjs');
  const module = await import(pathToFileURL(scriptPath).href);

  assert.equal(typeof module.resolveExactDriverSessionTarget, 'function');
  assert.deepEqual(
    module.resolveExactDriverSessionTarget(
      { connected: true, port: 9224, apps: [] },
      9224,
    ),
    {
      port: 9224,
      identifier: null,
      host: null,
      name: null,
      isDefault: false,
    },
  );
  assert.equal(
    module.resolveExactDriverSessionTarget(
      { connected: true, port: 9223, apps: [] },
      9224,
    ),
    null,
  );
});

test('tauri onboarding wizard QA builds the debug relay selection deep-link', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const scriptPath = join(scriptsDir, 'tauriOnboardingWizardMcpQa.mjs');
  const module = await import(pathToFileURL(scriptPath).href);

  assert.equal(module.buildOnboardingWizardPath(), '/?happier_hmr=0');
  assert.equal(module.buildOnboardingWizardPath('relay_select'), '/?happier_wizard_step=relay_select&happier_hmr=0');
});

test('tauri onboarding wizard QA resolves relative outdir against repo root', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const scriptPath = join(scriptsDir, 'tauriOnboardingWizardMcpQa.mjs');

  const relativeOutdir = '.project/logs/bootstrap-qa/tauri-onboarding-wizard-test-relative';
  const { stdout } = await execFileAsync(process.execPath, [scriptPath, '--json'], {
    cwd: dirname(dirname(scriptsDir)),
    env: { ...process.env, HAPPIER_TAURI_QA_OUTDIR: relativeOutdir },
    encoding: 'utf8',
  });

  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.plan.artifactRoot, join(payload.plan.repoRoot, relativeOutdir));
});
