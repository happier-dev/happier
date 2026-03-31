#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import { ensureUiWorkspacePackagesBuilt } from '../ensureWorkspacePackagesBuilt.mjs';

import {
  appendTextArtifact,
  ensureDir,
  nowStamp,
  resolveWizardQaArtifactRoot,
  runTauriMcpCli,
  runTauriMcpCliJson,
  writeTextArtifact,
} from './tauriMcpCli.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(dirname(scriptDir));
const repoRoot = dirname(dirname(packageRoot));

const defaultTrackerPath = join(
  repoRoot,
  '.project',
  'plans',
  'todo',
  'bootstrap',
  'happier-bootstrap-qa-tracking-2026-03-30.md',
);

function readString(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function readNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function resolveCandidateDriverSessionPorts({ preferredPort, env = process.env } = {}) {
  const ports = [];
  const seen = new Set();

  function push(value) {
    const port = Number(value);
    if (!Number.isFinite(port) || port <= 0) return;
    const normalized = Math.floor(port);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    ports.push(normalized);
  }

  const preferred = readNumber(
    preferredPort
      ?? env.HAPPIER_TAURI_MCP_APP_IDENTIFIER
      ?? env.HAPPIER_TAURI_MCP_PORT
      ?? env.HAPPIER_TAURI_APP_PORT,
    0,
  );
  if (preferred) {
    push(preferred);
    push(preferred + 1);
    push(preferred + 2);
    push(preferred - 1);
  }

  // Include known defaults used in our repo scripts and the upstream CLI default.
  push(9225);
  push(9226);
  push(9227);
  push(9223);

  return ports;
}

function buildStepPlan() {
  return [
    {
      id: 'welcome',
      title: 'Welcome / root',
      selectors: [
        '[data-testid="onboarding-wizard"]',
        '[data-testid="onboarding-wizard-primary"]',
        '[data-testid="onboarding-wizard-scan"]',
        '[data-testid="onboarding-wizard-skip"]',
      ],
      screenshot: '01-welcome.png',
      domStructure: '01-welcome.structure.yml',
      domAccessibility: '01-welcome.a11y.yml',
      notes: ['capture the pre-auth landing surface before navigation'],
    },
    {
      id: 'auth_skip',
      title: 'Auth (via Skip)',
      selectors: [
        '[data-testid="welcome-restore"]',
        '[data-testid="welcome-create-account"]',
        '[data-testid="welcome-signup-provider"]',
        '[data-testid="welcome-mtls-login"]',
        '[data-testid="welcome-server-loading"]',
        '[data-testid="welcome-server-unavailable"]',
      ],
      screenshot: '02-auth-skip.png',
      domStructure: '02-auth-skip.structure.yml',
      domAccessibility: '02-auth-skip.a11y.yml',
      notes: ['capture the auth surface reached via Skip from the wizard'],
    },
    {
      id: 'relay',
      title: 'Relay selection',
      selectors: [
        '[data-testid="onboarding-wizard-relay-diagram"]',
        '[data-testid="onboarding-wizard-relay:cloud"]',
        '[data-testid="onboarding-wizard-relay:thisComputer"]',
        '[data-testid="onboarding-wizard-relay:customUrl"]',
      ],
      screenshot: '03-relay.png',
      domStructure: '03-relay.structure.yml',
      domAccessibility: '03-relay.a11y.yml',
      notes: ['validate relay diagram + selectable rows'],
    },
    {
      id: 'welcome_back',
      title: 'Welcome (after Back)',
      selectors: [
        '[data-testid="onboarding-wizard-welcome-body"]',
        '[data-testid="onboarding-wizard-primary"]',
        '[data-testid="onboarding-wizard-skip"]',
      ],
      screenshot: '04-welcome-back.png',
      domStructure: '04-welcome-back.structure.yml',
      domAccessibility: '04-welcome-back.a11y.yml',
      notes: ['capture the welcome surface after navigating back from relay'],
    },
    {
      id: 'auth',
      title: 'Auth / sign in actions',
      selectors: [
        '[data-testid="welcome-restore"]',
        '[data-testid="welcome-create-account"]',
        '[data-testid="welcome-signup-provider"]',
        '[data-testid="welcome-mtls-login"]',
        '[data-testid="welcome-server-loading"]',
        '[data-testid="welcome-server-unavailable"]',
      ],
      screenshot: '05-auth.png',
      domStructure: '05-auth.structure.yml',
      domAccessibility: '05-auth.a11y.yml',
      notes: ['capture the pre-auth auth action surface'],
    },
    {
      id: 'restore',
      title: 'Restore / add-device',
      selectors: [
        '[data-testid="restore-enter-pairing-link"]',
        '[data-testid="restore-open-manual"]',
        '[data-testid="restore-show-qr-instead"]',
        '[data-testid="restore-scan-cancel"]',
        '[data-testid="restore-open-lost-access"]',
      ],
      screenshot: '06-restore.png',
      domStructure: '06-restore.structure.yml',
      domAccessibility: '06-restore.a11y.yml',
      notes: ['capture restore surfaces and manual recovery affordances'],
    },
    {
      id: 'lost_access',
      title: 'Lost access / reset',
      selectors: ['[data-testid^="lost-access-provider-"]', '[data-testid="common.back"]', '[data-testid="common.cancel"]'],
      screenshot: '07-lost-access.png',
      domStructure: '07-lost-access.structure.yml',
      domAccessibility: '07-lost-access.a11y.yml',
      notes: ['capture provider reset affordances and the server-gated recovery list'],
    },
  ];
}

export function buildTauriOnboardingWizardQaPlan({ env = process.env } = {}) {
  const driverSessionPort = readNumber(
    env.HAPPIER_TAURI_MCP_APP_IDENTIFIER ?? env.HAPPIER_TAURI_MCP_PORT ?? env.HAPPIER_TAURI_APP_PORT,
    9225,
  );
  const trackerPathRaw = readString(env.HAPPIER_TAURI_QA_TRACKER_PATH, defaultTrackerPath);
  const artifactRootRaw = readString(
    env.HAPPIER_TAURI_QA_OUTDIR,
    resolveWizardQaArtifactRoot(repoRoot, { date: new Date(), runId: nowStamp() }),
  );

  const trackerPath = isAbsolute(trackerPathRaw) ? trackerPathRaw : join(repoRoot, trackerPathRaw);
  const artifactRoot = isAbsolute(artifactRootRaw) ? artifactRootRaw : join(repoRoot, artifactRootRaw);
  const stepPlan = buildStepPlan();

  return {
    repoRoot,
    packageRoot,
    artifactRoot,
    trackerPath,
    driverSessionPort,
    commandRunner: {
      command: 'yarn',
      baseArgs: ['-s', 'tauri:mcp:cli'],
    },
    driverSession: {
      command: 'yarn',
      baseArgs: ['-s', 'tauri:mcp:cli'],
      args: ['driver-session', 'start', '--port', String(driverSessionPort)],
    },
    steps: stepPlan,
    manual: [
      'Approve any OS camera / accessibility / permission dialog if the desktop app prompts for it.',
      'Complete login or provider reset manually if the current environment does not contain a seeded account.',
      'If a native picker or browser chooser appears, select the expected file / browser once and continue.',
    ],
  };
}

function tryParseDriverSessionStatus(response) {
  const raw = readString(response?.text, '');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function resolveAppIdentifierFromDriverStatus(status) {
  const singlePort = Number(status?.port ?? 0);
  if (Number.isFinite(singlePort) && singlePort > 0) {
    return Math.floor(singlePort);
  }
  const defaultPort = Number(status?.defaultPort ?? 0);
  if (Number.isFinite(defaultPort) && defaultPort > 0) {
    return Math.floor(defaultPort);
  }
  const apps = Array.isArray(status?.apps) ? status.apps : [];
  const defaultApp = apps.find((app) => app && app.isDefault === true && Number.isFinite(Number(app.port ?? 0)) && Number(app.port) > 0);
  if (defaultApp) {
    return Math.floor(Number(defaultApp.port));
  }
  const first = apps.find((app) => Number.isFinite(Number(app?.port ?? 0)) && Number(app.port) > 0);
  if (first) {
    return Math.floor(Number(first.port));
  }
  return null;
}

async function waitForAnySelector(step, { appIdentifier, env }) {
  for (const selector of step.selectors) {
    try {
      await runTauriMcpCli(
        [
          'webview-wait-for',
          '--type',
          'selector',
          '--strategy',
          'css',
          '--value',
          selector,
          '--timeout',
          '8000',
          '--app-identifier',
          String(appIdentifier),
        ],
        { cwd: packageRoot, env },
      );
      return selector;
    } catch {
      // try the next selector
    }
  }
  throw new Error(`Unable to find a matching selector for step ${step.id}: ${step.selectors.join(', ')}`);
}

async function withRetries(label, fn, { attempts = 3, delayMs = 250 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fn({ attempt });
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        // eslint-disable-next-line no-await-in-loop
        await delay(delayMs);
        continue;
      }
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${label} failed after ${attempts} attempts: ${message}`);
}

async function captureStep(step, { artifactRoot, appIdentifier, env }) {
  const screenshotPath = join(artifactRoot, step.screenshot);
  const structurePath = join(artifactRoot, step.domStructure);
  const a11yPath = join(artifactRoot, step.domAccessibility);

  await withRetries(
    `screenshot:${step.id}`,
    () => runTauriMcpCli(
      [
        'webview-screenshot',
        '--format',
        'png',
        '--file-path',
        screenshotPath,
        '--app-identifier',
        String(appIdentifier),
      ],
      { cwd: packageRoot, env },
    ),
    { attempts: 3, delayMs: 350 },
  );

  const structure = await withRetries(
    `dom-structure:${step.id}`,
    () => runTauriMcpCli(
      [
        'webview-dom-snapshot',
        '--type',
        'structure',
        '--app-identifier',
        String(appIdentifier),
      ],
      { cwd: packageRoot, env },
    ),
    { attempts: 2, delayMs: 250 },
  );
  await writeTextArtifact(structurePath, String(structure.stdout ?? ''));

  const accessibility = await withRetries(
    `dom-accessibility:${step.id}`,
    () => runTauriMcpCli(
      [
        'webview-dom-snapshot',
        '--type',
        'accessibility',
        '--app-identifier',
        String(appIdentifier),
      ],
      { cwd: packageRoot, env },
    ),
    { attempts: 2, delayMs: 250 },
  );
  await writeTextArtifact(a11yPath, String(accessibility.stdout ?? ''));

  return {
    screenshotPath,
    structurePath,
    a11yPath,
  };
}

async function captureOptionalStep(step, { artifactRoot, appIdentifier, env }) {
  try {
    await waitForAnySelector(step, { appIdentifier, env });
  } catch {
    return null;
  }
  return captureStep(step, { artifactRoot, appIdentifier, env });
}

async function isSelectorPresent(selector, { appIdentifier, env, timeoutMs = 1200 } = {}) {
  try {
    await runTauriMcpCli(
      [
        'webview-wait-for',
        '--type',
        'selector',
        '--strategy',
        'css',
        '--value',
        String(selector),
        '--timeout',
        String(timeoutMs),
        '--app-identifier',
        String(appIdentifier),
      ],
      { cwd: packageRoot, env, timeoutMs: Math.max(10_000, timeoutMs + 5_000) },
    );
    return true;
  } catch {
    return false;
  }
}

async function clickSelector(selector, { appIdentifier, env } = {}) {
  const rawSelector = String(selector);
  const normalizedSelector = rawSelector.replace(
    /^\[data-testid="([^"]+)"\]$/u,
    (_match, testId) => `[data-testid='${testId}']`,
  );
  await runTauriMcpCli(
    [
      'webview-wait-for',
      '--type',
      'selector',
      '--strategy',
      'css',
      '--value',
      normalizedSelector,
      '--timeout',
      '8000',
      '--app-identifier',
      String(appIdentifier),
    ],
    { cwd: packageRoot, env },
  );
  await runTauriMcpCli(
    [
      'webview-interact',
      '--action',
      'focus',
      '--selector',
      normalizedSelector,
      '--app-identifier',
      String(appIdentifier),
    ],
    { cwd: packageRoot, env },
  ).catch(() => {});
  await runTauriMcpCli(
    [
      'webview-interact',
      '--action',
      'click',
      '--selector',
      normalizedSelector,
      '--app-identifier',
      String(appIdentifier),
    ],
    { cwd: packageRoot, env },
  );
}

async function appendWarning(artifactRoot, text) {
  const warningPath = join(artifactRoot, '98-warnings.md');
  await appendTextArtifact(warningPath, `${text.trim()}\n`);
}

async function navigateWebviewToPath(pathname, { appIdentifier, env }) {
  const path = String(pathname ?? '').trim();
  if (!path.startsWith('/')) {
    throw new Error(`Expected an absolute pathname starting with "/": ${path}`);
  }
  const script = `(() => {
    try {
      const origin = window.location && window.location.origin ? window.location.origin : '';
      const next = origin ? origin + ${JSON.stringify(path)} : ${JSON.stringify(path)};
      window.location.href = next;
      return next;
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  })()`;
  await runTauriMcpCli(
    [
      'webview-execute-js',
      '--script',
      script,
      '--app-identifier',
      String(appIdentifier),
      '--json',
    ],
    { cwd: packageRoot, env },
  ).catch(() => {});
}

async function appendTrackerEvidence({ trackerPath, artifactRoot, stepArtifacts, driverSession, driverSessionStatus, backendState }) {
  const lines = [
    '',
    `- ${new Date().toISOString().slice(0, 10)}: Tauri onboarding wizard QA captured under \`${artifactRoot.replaceAll('\\', '/')}\`:`,
    `  - driver session: \`${driverSession.replaceAll('\\', '/')}\``,
    ...(driverSessionStatus ? [`  - status: \`${driverSessionStatus.replaceAll('\\', '/')}\``] : []),
    `  - backend state: \`${backendState.replaceAll('\\', '/')}\``,
  ];
  for (const [stepId, artifacts] of Object.entries(stepArtifacts)) {
    lines.push(`  - ${stepId}:`);
    lines.push(`    - screenshot: \`${artifacts.screenshotPath.replaceAll('\\', '/')}\``);
    lines.push(`    - structure: \`${artifacts.structurePath.replaceAll('\\', '/')}\``);
    lines.push(`    - accessibility: \`${artifacts.a11yPath.replaceAll('\\', '/')}\``);
  }
  lines.push('');
  await appendTextArtifact(trackerPath, `${lines.join('\n')}\n`);
}

async function appendJsonLineArtifact(filePath, data) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  await appendTextArtifact(filePath, `${payload}\n`);
}

async function main(argv = process.argv.slice(2)) {
  const plan = buildTauriOnboardingWizardQaPlan();
  const json = argv.includes('--json');
  const help = argv.includes('--help') || argv.includes('-h');

  if (help) {
    process.stdout.write([
      'Usage: node ./apps/ui/scripts/qa/tauriOnboardingWizardMcpQa.mjs [--json]',
      '',
      'Plan preview:',
      '  --json   Print the deterministic capture plan without driving the app',
      '',
      'Run mode (default):',
      '  - assumes `yarn --cwd apps/ui tauri:qa` is already running',
      '  - opens an MCP driver session',
      '  - captures screenshots + DOM snapshots for the onboarding wizard surfaces',
      '  - appends evidence paths to the bootstrap QA tracker',
    ].join('\n') + '\n');
    return;
  }

  if (json) {
    process.stdout.write(JSON.stringify({ ok: true, plan }, null, 2) + '\n');
    return;
  }

  // Ensure internal workspace packages have their `dist/` outputs built before we drive the
  // Tauri webview. This avoids Metro/Tauri crashes due to missing internal export entrypoints.
  await ensureUiWorkspacePackagesBuilt({ env: process.env });

  await ensureDir(plan.artifactRoot);

  const driverSessionAttemptsFile = join(plan.artifactRoot, '00-driver-session-attempts.jsonl');
  const candidatePorts = resolveCandidateDriverSessionPorts({ preferredPort: plan.driverSessionPort, env: process.env });

  let usedDriverSessionPort = null;
  let driverSessionResponse = null;
  let driverSessionStatusResponse = null;

  // Ensure we always start from a fresh driver session. Stale sessions can keep
  // the MCP bridge "connected" while the underlying plugin/webview connection is
  // dead, leading to `Not connected to plugin and reconnection failed`.
  for (const candidatePort of candidatePorts) {
    // eslint-disable-next-line no-await-in-loop
    await runTauriMcpCli(
      ['driver-session', 'stop', '--port', String(candidatePort)],
      { cwd: plan.packageRoot, env: process.env },
    ).catch(() => {});

    try {
      // eslint-disable-next-line no-await-in-loop
      driverSessionResponse = await runTauriMcpCliJson(['driver-session', 'start', '--port', String(candidatePort)], {
        cwd: plan.packageRoot,
        env: process.env,
      });
      // eslint-disable-next-line no-await-in-loop
      driverSessionStatusResponse = await runTauriMcpCliJson(
        ['driver-session', 'status', '--port', String(candidatePort)],
        { cwd: plan.packageRoot, env: process.env },
      );
      const parsed = tryParseDriverSessionStatus(driverSessionStatusResponse);
      const resolved = resolveAppIdentifierFromDriverStatus(parsed);
      if (resolved) {
        usedDriverSessionPort = candidatePort;
        // eslint-disable-next-line no-await-in-loop
        await appendJsonLineArtifact(driverSessionAttemptsFile, { ok: true, port: candidatePort, appIdentifier: resolved });
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      await appendJsonLineArtifact(driverSessionAttemptsFile, { ok: false, port: candidatePort, reason: 'no-app-identifier' });
    } catch (error) {
      // eslint-disable-next-line no-await-in-loop
      await appendJsonLineArtifact(driverSessionAttemptsFile, {
        ok: false,
        port: candidatePort,
        reason: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
  }

  if (!usedDriverSessionPort || !driverSessionResponse || !driverSessionStatusResponse) {
    throw new Error(`Unable to resolve a connected Tauri app identifier from driver-session status. Tried ports: ${candidatePorts.join(', ')}`);
  }

  const driverSessionCommand = ['yarn', ...plan.driverSession.baseArgs, 'driver-session', 'start', '--port', String(usedDriverSessionPort)].join(' ');
  const driverSessionResponseFile = join(plan.artifactRoot, '00-driver-session.json');
  await writeTextArtifact(driverSessionResponseFile, `${JSON.stringify(driverSessionResponse, null, 2)}\n`);

  const driverSessionStatusCommand = ['yarn', ...plan.driverSession.baseArgs, 'driver-session', 'status', '--port', String(usedDriverSessionPort)].join(' ');
  const driverSessionStatusResponseFile = join(plan.artifactRoot, '00-driver-session-status.json');
  await writeTextArtifact(driverSessionStatusResponseFile, `${JSON.stringify(driverSessionStatusResponse, null, 2)}\n`);

  const parsedStatus = tryParseDriverSessionStatus(driverSessionStatusResponse);
  const resolvedAppIdentifier = resolveAppIdentifierFromDriverStatus(parsedStatus);
  if (!resolvedAppIdentifier) {
    throw new Error('Unable to resolve a connected Tauri app identifier from driver-session status.');
  }

  const backendStateFile = join(plan.artifactRoot, '00-backend-state.json');
  const backendState = await runTauriMcpCli(
    ['ipc-get-backend-state', '--json', '--app-identifier', String(resolvedAppIdentifier)],
    { cwd: plan.packageRoot, env: process.env },
  );
  await writeTextArtifact(backendStateFile, String(backendState.stdout ?? ''));

  const stepsById = Object.fromEntries(plan.steps.map((step) => [step.id, step]));
  const stepArtifacts = {};

  async function captureRequired(stepId) {
    const step = stepsById[stepId];
    if (!step) throw new Error(`Unknown step id: ${stepId}`);
    await waitForAnySelector(step, { appIdentifier: resolvedAppIdentifier, env: process.env });
    const artifacts = await captureStep(step, { artifactRoot: plan.artifactRoot, appIdentifier: resolvedAppIdentifier, env: process.env });
    stepArtifacts[stepId] = artifacts;
    return artifacts;
  }

  async function captureBestEffort(stepId) {
    const step = stepsById[stepId];
    if (!step) throw new Error(`Unknown step id: ${stepId}`);
    const artifacts = await captureOptionalStep(step, { artifactRoot: plan.artifactRoot, appIdentifier: resolvedAppIdentifier, env: process.env });
    if (artifacts) {
      stepArtifacts[stepId] = artifacts;
    }
    return artifacts;
  }

  // Always attempt to start from a known route. If the app is sitting on a post-auth
  // screen or a previous route, this gives us a stable starting point.
  await navigateWebviewToPath('/', { appIdentifier: resolvedAppIdentifier, env: process.env });

  // 1) Welcome
  await captureRequired('welcome');

  // 2) Skip -> Auth (best-effort). This validates the skip affordance without relying on copy.
  if (await isSelectorPresent('[data-testid="onboarding-wizard-skip"]', { appIdentifier: resolvedAppIdentifier, env: process.env })) {
    try {
      await clickSelector('[data-testid="onboarding-wizard-skip"]', { appIdentifier: resolvedAppIdentifier, env: process.env });
    } catch (error) {
      await appendWarning(plan.artifactRoot, `- skip click failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await captureBestEffort('auth_skip');
  } else {
    await appendWarning(plan.artifactRoot, '- skip button not present on welcome surface; unable to validate skip navigation');
  }

  // Return to the wizard root to continue the main flow.
  await navigateWebviewToPath('/', { appIdentifier: resolvedAppIdentifier, env: process.env });
  await captureRequired('welcome');

  // 3) Advance to relay (if applicable)
  try {
    await clickSelector('[data-testid="onboarding-wizard-primary"]', { appIdentifier: resolvedAppIdentifier, env: process.env });
  } catch (error) {
    await appendWarning(plan.artifactRoot, `- welcome primary click failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const relayArtifacts = await captureBestEffort('relay');

  // 4) Relay -> Back -> Welcome capture (if relay step is present)
  if (relayArtifacts && await isSelectorPresent('[data-testid="onboarding-wizard-back"]', { appIdentifier: resolvedAppIdentifier, env: process.env })) {
    try {
      await clickSelector('[data-testid="onboarding-wizard-back"]', { appIdentifier: resolvedAppIdentifier, env: process.env });
    } catch (error) {
      await appendWarning(plan.artifactRoot, `- relay back click failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await captureBestEffort('welcome_back');
  } else if (!relayArtifacts) {
    await appendWarning(plan.artifactRoot, '- relay selection step not detected; unable to validate Back navigation from relay');
  } else {
    await appendWarning(plan.artifactRoot, '- back button not present on relay surface; unable to validate Back navigation');
  }

  // 5) Continue forward again to reach the auth entry surface (best-effort). Some states
  // may skip relay entirely, so attempt both relay + direct waits.
  try {
    if (await isSelectorPresent('[data-testid="onboarding-wizard-primary"]', { appIdentifier: resolvedAppIdentifier, env: process.env, timeoutMs: 1500 })) {
      await clickSelector('[data-testid="onboarding-wizard-primary"]', { appIdentifier: resolvedAppIdentifier, env: process.env });
    }
  } catch (error) {
    await appendWarning(plan.artifactRoot, `- primary click (post-back) failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // If relay is shown again, prefer selecting the cloud relay explicitly before continuing so
  // the auth surface isn't blocked by a stale/unsupported local relay URL.
  if (await isSelectorPresent('[data-testid="onboarding-wizard-relay-diagram"]', { appIdentifier: resolvedAppIdentifier, env: process.env, timeoutMs: 2500 })) {
    try {
      if (await isSelectorPresent('[data-testid="onboarding-wizard-relay:cloud"]', { appIdentifier: resolvedAppIdentifier, env: process.env, timeoutMs: 1500 })) {
        await clickSelector('[data-testid="onboarding-wizard-relay:cloud"]', { appIdentifier: resolvedAppIdentifier, env: process.env });
      }
      await clickSelector('[data-testid="onboarding-wizard-primary"]', { appIdentifier: resolvedAppIdentifier, env: process.env });
    } catch (error) {
      await appendWarning(plan.artifactRoot, `- relay primary click (resume) failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const authArtifacts = await captureBestEffort('auth');
  if (!authArtifacts) {
    await appendWarning(plan.artifactRoot, '- auth surface not detected; unable to validate restore / lost access drill-down');
  } else {
    // 6) Auth -> Lost access (preferred). This is the canonical entry point for recovery.
    // Some servers may not expose provider reset, so treat this as best-effort.
    if (await isSelectorPresent('[data-testid="onboarding-wizard-lost-access"]', { appIdentifier: resolvedAppIdentifier, env: process.env, timeoutMs: 2500 })) {
      try {
        await clickSelector('[data-testid="onboarding-wizard-lost-access"]', { appIdentifier: resolvedAppIdentifier, env: process.env });
      } catch (error) {
        await appendWarning(plan.artifactRoot, `- lost access click (auth) failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      await captureBestEffort('lost_access');
      // Navigate back to auth for the next drill-down.
      try {
        if (await isSelectorPresent('[data-testid="common.back"]', { appIdentifier: resolvedAppIdentifier, env: process.env, timeoutMs: 1500 })) {
          await clickSelector('[data-testid="common.back"]', { appIdentifier: resolvedAppIdentifier, env: process.env });
        } else if (await isSelectorPresent('[data-testid="common.cancel"]', { appIdentifier: resolvedAppIdentifier, env: process.env, timeoutMs: 1500 })) {
          await clickSelector('[data-testid="common.cancel"]', { appIdentifier: resolvedAppIdentifier, env: process.env });
        }
      } catch (error) {
        await appendWarning(plan.artifactRoot, `- navigation back from lost access failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      await appendWarning(plan.artifactRoot, '- lost access button not present on auth surface; skipping lost access drill-down');
    }

    // 6) Auth -> Restore
    if (await isSelectorPresent('[data-testid="welcome-restore"]', { appIdentifier: resolvedAppIdentifier, env: process.env, timeoutMs: 2500 })) {
      try {
        await clickSelector('[data-testid="welcome-restore"]', { appIdentifier: resolvedAppIdentifier, env: process.env });
      } catch (error) {
        await appendWarning(plan.artifactRoot, `- restore click failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      await appendWarning(plan.artifactRoot, '- restore button not present on auth surface; skipping restore drill-down');
    }

    const restoreArtifacts = await captureBestEffort('restore');
    if (!restoreArtifacts) {
      await appendWarning(plan.artifactRoot, '- restore surface not detected after clicking restore');
    } else {
      // 7) Restore -> Lost access
      if (await isSelectorPresent('[data-testid="restore-open-lost-access"]', { appIdentifier: resolvedAppIdentifier, env: process.env, timeoutMs: 2500 })) {
        try {
          await clickSelector('[data-testid="restore-open-lost-access"]', { appIdentifier: resolvedAppIdentifier, env: process.env });
        } catch (error) {
          await appendWarning(plan.artifactRoot, `- lost access click failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        await appendWarning(plan.artifactRoot, '- lost access button not present on restore surface; skipping lost access drill-down');
      }
      await captureBestEffort('lost_access');
    }
  }

  const optionalSetupStep = {
    id: 'setup',
    title: 'Setup wizard / post-auth',
    selectors: [
      '[data-testid="setupWizard.surface"]',
      '[data-testid="setupWizard-branch:local"]',
      '[data-testid="setupWizard-branch:remote"]',
      '[data-testid="setupWizard.surface-primary"]',
    ],
    screenshot: '08-setup.png',
    domStructure: '08-setup.structure.yml',
    domAccessibility: '08-setup.a11y.yml',
    notes: ['capture the post-auth setup wizard when the authenticated runtime exposes it'],
  };

  const optionalSetupArtifacts = await captureOptionalStep(optionalSetupStep, {
    artifactRoot: plan.artifactRoot,
    appIdentifier: resolvedAppIdentifier,
    env: process.env,
  });

  // If we're authenticated but currently not on the setup wizard route, try to
  // navigate there once and capture it (best-effort).
  const optionalSetupArtifactsRetried = optionalSetupArtifacts
    ? null
    : (await (async () => {
      await navigateWebviewToPath('/setup/wizard', { appIdentifier: resolvedAppIdentifier, env: process.env });
      return captureOptionalStep(optionalSetupStep, {
        artifactRoot: plan.artifactRoot,
        appIdentifier: resolvedAppIdentifier,
        env: process.env,
      });
    })());

  if (optionalSetupArtifacts || optionalSetupArtifactsRetried) {
    stepArtifacts[optionalSetupStep.id] = optionalSetupArtifacts ?? optionalSetupArtifactsRetried;
  }

  const consoleLogs = await runTauriMcpCli(
    ['read-logs', '--source', 'console', '--json', '--app-identifier', String(resolvedAppIdentifier)],
    { cwd: plan.packageRoot, env: process.env },
  );
  await writeTextArtifact(join(plan.artifactRoot, '99-console-logs.json'), String(consoleLogs.stdout ?? ''));

  await writeTextArtifact(
    join(plan.artifactRoot, 'manual-steps.md'),
    [
      '# Manual steps',
      '',
      ...plan.manual.map((entry) => `- [manual] ${entry}`),
      '',
    ].join('\n'),
  );

  await appendTrackerEvidence({
    trackerPath: plan.trackerPath,
    artifactRoot: plan.artifactRoot,
    stepArtifacts,
    driverSession: `${driverSessionCommand} -> ${driverSessionResponseFile}`,
    driverSessionStatus: `${driverSessionStatusCommand} -> ${driverSessionStatusResponseFile}`,
    backendState: backendStateFile,
  });

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        artifactRoot: plan.artifactRoot,
        trackerPath: plan.trackerPath,
        appIdentifier: resolvedAppIdentifier,
        steps: Object.keys(stepArtifacts),
      },
      null,
      2,
    ) + '\n',
  );
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && process.argv[1] === currentFilePath) {
  main().catch((error) => {
    process.stderr.write(`[tauri-onboarding-wizard-qa] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
