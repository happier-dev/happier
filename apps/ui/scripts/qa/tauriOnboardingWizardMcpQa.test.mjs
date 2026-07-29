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

test('tauri onboarding wizard QA resolves the MCP CLI env with the resolved app identifier', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const scriptPath = join(scriptsDir, 'tauriOnboardingWizardMcpQa.mjs');
  const module = await import(pathToFileURL(scriptPath).href);

  assert.equal(typeof module.resolveOnboardingWizardMcpCliEnv, 'function');

  const env = module.resolveOnboardingWizardMcpCliEnv(
    {
      EXISTING: 'value',
      HAPPIER_STACK_TAURI_IDENTIFIER: 'com.happier.stack.activity-surfaces-qa',
    },
    9224,
  );

  assert.equal(env.EXISTING, 'value');
  assert.equal(env.HAPPIER_STACK_TAURI_IDENTIFIER, 'com.happier.stack.activity-surfaces-qa');
  assert.equal(env.HAPPIER_TAURI_MCP_APP_IDENTIFIER, '9224');
});

test('tauri onboarding wizard QA prefers the setup wizard surface over the legacy onboarding root after auth', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const scriptPath = join(scriptsDir, 'tauriOnboardingWizardMcpQa.mjs');
  const module = await import(pathToFileURL(scriptPath).href);

  assert.equal(typeof module.resolvePostAuthBootstrapSurface, 'function');

  const probes = [];
  const result = await module.resolvePostAuthBootstrapSurface({
    appIdentifier: 9224,
    env: { EXISTING: 'value' },
    isSelectorPresent: async (selector, options) => {
      probes.push({ selector, options });
      return selector === '[data-testid="setupWizard.surface"]';
    },
  });

  assert.deepEqual(result, {
    kind: 'setupWizard',
    selector: '[data-testid="setupWizard.surface"]',
  });
  assert.deepEqual(probes, [
    {
      selector: '[data-testid="setupWizard.surface"]',
      options: {
        appIdentifier: 9224,
        env: { EXISTING: 'value' },
        timeoutMs: 8000,
      },
    },
  ]);
});

test('tauri onboarding wizard QA retries backend state probing before giving up', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const scriptPath = join(scriptsDir, 'tauriOnboardingWizardMcpQa.mjs');
  const module = await import(pathToFileURL(scriptPath).href);

  assert.equal(typeof module.readBackendStateWithRetries, 'function');

  const calls = [];
  let attempts = 0;
  const result = await module.readBackendStateWithRetries({
    appIdentifier: 9224,
    env: { EXISTING: 'value' },
    attempts: 3,
    delayMs: 0,
    runCli: async (args, options) => {
      calls.push({ args, options });
      attempts += 1;
      if (attempts < 3) {
        throw new Error(`backend-state unavailable on attempt ${attempts}`);
      }
      return { stdout: '{"ok":true}' };
    },
  });

  assert.deepEqual(result, { stdout: '{"ok":true}' });
  assert.deepEqual(calls.map((entry) => entry.args), [
    ['ipc-get-backend-state', '--json', '--app-identifier', '9224'],
    ['ipc-get-backend-state', '--json', '--app-identifier', '9224'],
    ['ipc-get-backend-state', '--json', '--app-identifier', '9224'],
  ]);
  assert.equal(calls.every((entry) => entry.options.appIdentifier === 9224), true);
  assert.equal(calls.every((entry) => entry.options.env.EXISTING === 'value'), true);
});

test('tauri onboarding wizard QA treats MCP JSON error envelopes as backend-state probe failures', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const scriptPath = join(scriptsDir, 'tauriOnboardingWizardMcpQa.mjs');
  const module = await import(pathToFileURL(scriptPath).href);

  assert.equal(typeof module.readBackendStateWithRetries, 'function');

  let attempts = 0;
  const result = await module.readBackendStateWithRetries({
    appIdentifier: 9224,
    env: { EXISTING: 'value' },
    attempts: 2,
    delayMs: 0,
    runCli: async () => {
      attempts += 1;
      return {
        stdout: JSON.stringify({
          text: 'Error: Failed to get backend state: Unknown error',
          markdown: null,
          structuredContent: null,
          content: [{ type: 'text', text: 'Error: Failed to get backend state: Unknown error' }],
          files: [],
        }),
      };
    },
    wait: async () => {},
  });

  assert.equal(attempts, 2);
  assert.deepEqual(result, {
    ok: false,
    error: 'Error: Failed to get backend state: Unknown error',
  });
});

test('tauri onboarding wizard QA waits before the first backend-state probe when a settle delay is configured', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const scriptPath = join(scriptsDir, 'tauriOnboardingWizardMcpQa.mjs');
  const module = await import(pathToFileURL(scriptPath).href);

  assert.equal(typeof module.readBackendStateWithRetries, 'function');

  const calls = [];
  const result = await module.readBackendStateWithRetries({
    appIdentifier: 9224,
    env: { EXISTING: 'value' },
    attempts: 1,
    delayMs: 0,
    settleDelayMs: 250,
    runCli: async (args, options) => {
      calls.push({ kind: 'runCli', args, options });
      return { stdout: '{"ok":true}' };
    },
    wait: async (ms) => {
      calls.push({ kind: 'wait', ms });
    },
  });

  assert.deepEqual(result, { stdout: '{"ok":true}' });
  assert.deepEqual(calls[0], { kind: 'wait', ms: 250 });
  assert.equal(calls[1]?.kind, 'runCli');
  assert.deepEqual(calls[1]?.args, ['ipc-get-backend-state', '--json', '--app-identifier', '9224']);
});

test('tauri onboarding wizard QA waits before the post-auth surface probe when a settle delay is configured', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const scriptPath = join(scriptsDir, 'tauriOnboardingWizardMcpQa.mjs');
  const module = await import(pathToFileURL(scriptPath).href);

  assert.equal(typeof module.resolvePostAuthBootstrapSurface, 'function');

  const calls = [];
  const result = await module.resolvePostAuthBootstrapSurface({
    appIdentifier: 9224,
    env: { EXISTING: 'value' },
    attempts: 1,
    delayMs: 0,
    settleDelayMs: 250,
    isSelectorPresent: async (selector, options) => {
      calls.push({ kind: 'probe', selector, options });
      return false;
    },
    wait: async (ms) => {
      calls.push({ kind: 'wait', ms });
    },
  });

  assert.deepEqual(result, {
    kind: 'missing',
    selector: null,
  });
  assert.deepEqual(calls[0], { kind: 'wait', ms: 250 });
  assert.equal(calls[1]?.kind, 'probe');
  assert.deepEqual(calls[1]?.selector, '[data-testid="setupWizard.surface"]');
});

test('tauri onboarding wizard QA retries transient webview disconnects while waiting for the first matching selector', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const scriptPath = join(scriptsDir, 'tauriOnboardingWizardMcpQa.mjs');
  const module = await import(pathToFileURL(scriptPath).href);

  assert.equal(typeof module.waitForAnySelector, 'function');

  const calls = [];
  let attempts = 0;
  const result = await module.waitForAnySelector(
    {
      id: 'setup',
      selectors: ['[data-testid="setupWizard.surface"]'],
    },
    {
      appIdentifier: 9224,
      env: { EXISTING: 'value' },
      attempts: 2,
      delayMs: 0,
      runCli: async (args, options) => {
        calls.push({ args, options });
        attempts += 1;
        if (attempts === 1) {
          throw new Error('WebView execution failed: Not connected to plugin and reconnection failed');
        }
        return { stdout: '' };
      },
      wait: async () => {},
    },
  );

  assert.equal(result, '[data-testid="setupWizard.surface"]');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((entry) => entry.args[0]), ['webview-wait-for', 'webview-wait-for']);
  assert.equal(calls.every((entry) => entry.options.appIdentifier === 9224), true);
  assert.equal(calls.every((entry) => entry.options.env.EXISTING === 'value'), true);
});

test('tauri onboarding wizard QA marks exhausted transient backend-state probes as a proof-channel disconnect', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const scriptPath = join(scriptsDir, 'tauriOnboardingWizardMcpQa.mjs');
  const module = await import(pathToFileURL(scriptPath).href);

  assert.equal(typeof module.readBackendStateWithRetries, 'function');

  const result = await module.readBackendStateWithRetries({
    appIdentifier: 9224,
    env: { EXISTING: 'value' },
    attempts: 2,
    delayMs: 0,
    runCli: async () => {
      throw new Error('WebView execution failed: Not connected to plugin and reconnection failed');
    },
    wait: async () => {},
  });

  assert.deepEqual(result, {
    ok: false,
    blocker: 'proof_channel_disconnect',
    error: 'WebView execution failed: Not connected to plugin and reconnection failed',
  });
});

test('tauri onboarding wizard QA marks a proof run with no captured steps as incomplete', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const scriptPath = join(scriptsDir, 'tauriOnboardingWizardMcpQa.mjs');
  const module = await import(pathToFileURL(scriptPath).href);

  assert.equal(typeof module.summarizeTauriOnboardingWizardQaProof, 'function');

  assert.deepEqual(module.summarizeTauriOnboardingWizardQaProof({ stepArtifacts: {} }), {
    ok: false,
    blocker: 'no_step_artifacts_captured',
    steps: [],
  });
});

test('tauri onboarding wizard QA marks partially captured proof artifacts as incomplete', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const scriptPath = join(scriptsDir, 'tauriOnboardingWizardMcpQa.mjs');
  const module = await import(pathToFileURL(scriptPath).href);

  assert.equal(typeof module.summarizeTauriOnboardingWizardQaProof, 'function');

  assert.deepEqual(module.summarizeTauriOnboardingWizardQaProof({
    stepArtifacts: {
      welcome: { screenshotPath: '/tmp/welcome.png', structurePath: '/tmp/welcome.structure.yml' },
    },
  }), {
    ok: false,
    blocker: 'missing_required_step_artifacts',
    steps: ['welcome'],
  });
});

test('tauri onboarding wizard QA exits non-zero when main receives incomplete proof', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const scriptPath = join(scriptsDir, 'tauriOnboardingWizardMcpQa.mjs');
  const module = await import(pathToFileURL(scriptPath).href);

  assert.equal(typeof module.main, 'function');

  const processApi = { exitCode: 0 };
  const writes = [];
  await module.main([], {
    runCapture: async () => ({
      ok: false,
      blocker: 'missing_required_step_artifacts',
      steps: [],
    }),
    stdout: {
      write: (text) => {
        writes.push(text);
      },
    },
    stderr: {
      write: (text) => {
        writes.push(text);
      },
    },
    processApi,
  });

  assert.equal(processApi.exitCode, 1);
  assert.equal(writes.length > 0, true);
});

test('tauri onboarding wizard QA keeps probing until the setup wizard surface appears after auth', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const scriptPath = join(scriptsDir, 'tauriOnboardingWizardMcpQa.mjs');
  const module = await import(pathToFileURL(scriptPath).href);

  assert.equal(typeof module.resolvePostAuthBootstrapSurface, 'function');

  const probes = [];
  let callCount = 0;
  const result = await module.resolvePostAuthBootstrapSurface({
    appIdentifier: 9224,
    env: { EXISTING: 'value' },
    isSelectorPresent: async (selector, options) => {
      probes.push({ selector, options });
      callCount += 1;
      if (callCount < 3) {
        return false;
      }
      return selector === '[data-testid="setupWizard.surface"]';
    },
    wait: async () => {},
  });

  assert.deepEqual(result, {
    kind: 'setupWizard',
    selector: '[data-testid="setupWizard.surface"]',
  });
  assert.equal(probes.length >= 3, true);
  assert.deepEqual(probes.slice(0, 3).map((entry) => entry.selector), [
    '[data-testid="setupWizard.surface"]',
    '[data-testid="onboarding-wizard"]',
    '[data-testid="setupWizard.surface"]',
  ]);
});

test('tauri onboarding wizard QA retries transient webview disconnects while probing the post-auth surface', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const scriptPath = join(scriptsDir, 'tauriOnboardingWizardMcpQa.mjs');
  const module = await import(pathToFileURL(scriptPath).href);

  assert.equal(typeof module.resolvePostAuthBootstrapSurface, 'function');

  const probes = [];
  let callCount = 0;
  const result = await module.resolvePostAuthBootstrapSurface({
    appIdentifier: 9224,
    env: { EXISTING: 'value' },
    isSelectorPresent: async (selector, options) => {
      probes.push({ selector, options });
      callCount += 1;
      if (callCount === 1) {
        throw new Error('WebView execution failed: Not connected to plugin and reconnection failed');
      }
      return selector === '[data-testid="setupWizard.surface"]';
    },
    wait: async () => {},
    attempts: 2,
  });

  assert.deepEqual(result, {
    kind: 'setupWizard',
    selector: '[data-testid="setupWizard.surface"]',
  });
  assert.equal(probes.length >= 2, true);
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

  assert.equal(module.resolveConnectedAppIdentifierFromDriverStatus(status), 'dev.happier.app.publicdev');
  assert.equal(module.resolvePreferredAppIdentifierFromDriverStatus(status, 9224), 'com.happier.stack.activity-surfaces-qa');
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

test('tauri onboarding wizard QA builds the onboarding root path', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriOnboardingWizardMcpQa.mjs');
    const module = await import(pathToFileURL(scriptPath).href);

    assert.equal(module.buildOnboardingWizardPath(), '/?happier_hmr=0');
    assert.equal(module.buildOnboardingWizardPath('relay_select'), '/?happier_hmr=0');
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
