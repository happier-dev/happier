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
  throwIfTauriMcpCliError,
  writeTextArtifact,
} from './tauriMcpCli.mjs';
import {
  resolveDefaultDriverSessionPort,
  resolveCandidateDriverSessionPorts,
  startTargetedDriverSession,
} from './tauriDriverSessionSelection.mjs';
import { appendTauriQaHmrOptOut } from './tauriQaPathing.mjs';
import { summarizeQaStepArtifactsProof } from './tauriQaProofSummary.mjs';
export {
  doesDriverSessionStatusMatchRequestedPort,
  resolveCandidateDriverSessionPorts,
  resolveConnectedAppIdentifierFromDriverStatus,
  resolveExactDriverSessionTarget,
  resolvePreferredAppIdentifierFromDriverStatus,
} from './tauriDriverSessionSelection.mjs';

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

const selectorWaitMs = 8000;
const cliSelectorWaitTimeoutMs = 20000;
const cliInteractTimeoutMs = 20000;
const proofChannelTransientRetryAttempts = 3;
const proofChannelTransientRetryDelayMs = 250;
const proofChannelInitialSettleMs = 250;

function readString(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function isTransientWebviewConnectionError(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.includes('Not connected to plugin') || message.includes('reconnection failed');
}

export function resolveOnboardingWizardMcpCliEnv(env = process.env, appIdentifier = null) {
  const resolvedEnv = { ...env };
  const explicitIdentifier = readString(resolvedEnv.HAPPIER_STACK_TAURI_IDENTIFIER);
  if (explicitIdentifier && !readString(resolvedEnv.HAPPIER_TAURI_MCP_APP_IDENTIFIER)) {
    resolvedEnv.HAPPIER_TAURI_MCP_APP_IDENTIFIER = explicitIdentifier;
  }
  const identifier = String(appIdentifier ?? '').trim();
  if (identifier) {
    resolvedEnv.HAPPIER_TAURI_MCP_APP_IDENTIFIER = identifier;
  }
  return resolvedEnv;
}

async function runOnboardingWizardMcpCli(args, { appIdentifier = null, env = process.env, timeoutMs } = {}) {
  return runTauriMcpCli(args, {
    cwd: packageRoot,
    env: resolveOnboardingWizardMcpCliEnv(env, appIdentifier),
    timeoutMs,
  });
}

async function runOnboardingWizardMcpCliJson(args, options = {}) {
  return runTauriMcpCliJson(args, {
    cwd: packageRoot,
    env: resolveOnboardingWizardMcpCliEnv(options.env ?? process.env, options.appIdentifier ?? null),
    timeoutMs: options.timeoutMs,
  });
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

export function buildOnboardingWizardPath(stepId = null) {
    void stepId;
    return appendTauriQaHmrOptOut('/');
}

export function buildTauriOnboardingWizardQaPlan({ env = process.env } = {}) {
  const driverSessionPort = resolveDefaultDriverSessionPort({ env });
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
    timeouts: {
      selectorWaitMs,
      cliSelectorWaitTimeoutMs,
      cliInteractTimeoutMs,
    },
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

export async function waitForAnySelector(
  step,
  {
    appIdentifier,
    env,
    runCli = runOnboardingWizardMcpCli,
    wait = delay,
    attempts = proofChannelTransientRetryAttempts,
    delayMs = proofChannelTransientRetryDelayMs,
  } = {},
) {
  for (const selector of step.selectors) {
    // eslint-disable-next-line no-await-in-loop
    if (await isSelectorPresent(selector, {
      appIdentifier,
      env,
      runCli,
      wait,
      attempts,
      delayMs,
      timeoutMs: selectorWaitMs,
    })) {
      return selector;
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
  return captureSnapshotArtifacts({
    screenshotPath: join(artifactRoot, step.screenshot),
    structurePath: join(artifactRoot, step.domStructure),
    a11yPath: join(artifactRoot, step.domAccessibility),
    label: step.id,
    appIdentifier,
    env,
  });
}

async function captureSnapshotArtifacts({ screenshotPath, structurePath, a11yPath, label, appIdentifier, env }) {
    await withRetries(
        `screenshot:${label}`,
        () => runOnboardingWizardMcpCli(
            [
                'webview-screenshot',
                '--format',
                'png',
                '--file-path',
                screenshotPath,
                '--app-identifier',
                String(appIdentifier),
            ],
            { appIdentifier, env },
        ),
        { attempts: 3, delayMs: 350 },
    );

    const structure = await withRetries(
        `dom-structure:${label}`,
        () => runOnboardingWizardMcpCli(
            [
                'webview-dom-snapshot',
                '--type',
                'structure',
                '--app-identifier',
                String(appIdentifier),
            ],
            { appIdentifier, env },
        ),
        { attempts: 2, delayMs: 250 },
    );
    await writeTextArtifact(structurePath, String(structure.stdout ?? ''));

    const accessibility = await withRetries(
        `dom-accessibility:${label}`,
        () => runOnboardingWizardMcpCli(
            [
                'webview-dom-snapshot',
                '--type',
                'accessibility',
                '--app-identifier',
                String(appIdentifier),
            ],
            { appIdentifier, env },
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

async function captureRelayChoiceArtifacts({ artifactRoot, appIdentifier, env, choiceId }) {
  const slug = String(choiceId ?? '').trim() || 'unknown';
  return captureSnapshotArtifacts({
    screenshotPath: join(artifactRoot, `03-relay-${slug}.png`),
    structurePath: join(artifactRoot, `03-relay-${slug}.structure.yml`),
    a11yPath: join(artifactRoot, `03-relay-${slug}.a11y.yml`),
    label: `relay:${slug}`,
    appIdentifier,
    env,
  });
}

async function captureOptionalStep(step, { artifactRoot, appIdentifier, env }) {
  try {
    await waitForAnySelector(step, { appIdentifier, env });
  } catch {
    return null;
  }
  return captureStep(step, { artifactRoot, appIdentifier, env });
}

export async function isSelectorPresent(
  selector,
  {
    appIdentifier,
    env,
    timeoutMs = 1200,
    attempts = proofChannelTransientRetryAttempts,
    delayMs = proofChannelTransientRetryDelayMs,
    wait = delay,
    runCli = runOnboardingWizardMcpCli,
  } = {},
) {
  let transientDisconnect = null;
  const normalizedAttempts = Math.max(1, Number(attempts) || 1);
  const normalizedDelayMs = Math.max(0, Number(delayMs) || 0);

  for (let attempt = 1; attempt <= normalizedAttempts; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await runCli(
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
        { appIdentifier, env, timeoutMs: Math.max(10_000, timeoutMs + 5_000) },
      );
      return true;
    } catch (error) {
      if (!isTransientWebviewConnectionError(error)) {
        return false;
      }
      transientDisconnect = error;
      if (attempt < normalizedAttempts) {
        // eslint-disable-next-line no-await-in-loop
        await wait(normalizedDelayMs);
      }
    }
  }

  return transientDisconnect ? false : false;
}

export async function resolvePostAuthBootstrapSurface({
  appIdentifier,
  env,
  isSelectorPresent: isSelectorPresentFn = isSelectorPresent,
  wait = delay,
  settleDelayMs = proofChannelInitialSettleMs,
  attempts = 6,
  delayMs = 1000,
} = {}) {
  const setupWizardSurfaceSelector = '[data-testid="setupWizard.surface"]';
  const onboardingWizardRootSelector = '[data-testid="onboarding-wizard"]';

  const normalizedAttempts = Math.max(1, Number(attempts) || 1);
  const normalizedDelayMs = Math.max(0, Number(delayMs) || 0);
  const normalizedSettleDelayMs = Math.max(0, Number(settleDelayMs) || 0);

  if (normalizedSettleDelayMs > 0) {
    await wait(normalizedSettleDelayMs);
  }

  for (let attempt = 0; attempt < normalizedAttempts; attempt += 1) {
    try {
      if (await isSelectorPresentFn(setupWizardSurfaceSelector, { appIdentifier, env, timeoutMs: selectorWaitMs })) {
        return {
          kind: 'setupWizard',
          selector: setupWizardSurfaceSelector,
        };
      }
    } catch (error) {
      if (!isTransientWebviewConnectionError(error)) {
        throw error;
      }
    }

    try {
      if (await isSelectorPresentFn(onboardingWizardRootSelector, { appIdentifier, env, timeoutMs: selectorWaitMs })) {
        return {
          kind: 'onboardingWizard',
          selector: onboardingWizardRootSelector,
        };
      }
    } catch (error) {
      if (!isTransientWebviewConnectionError(error)) {
        throw error;
      }
    }

    if (attempt + 1 < normalizedAttempts) {
      await wait(normalizedDelayMs);
    }
  }

  return {
    kind: 'missing',
    selector: null,
  };
}

export async function readBackendStateWithRetries({
  appIdentifier,
  env,
  attempts = 3,
  delayMs = 750,
  settleDelayMs = proofChannelInitialSettleMs,
  runCli = runOnboardingWizardMcpCli,
  wait = delay,
} = {}) {
  const normalizedAttempts = Math.max(1, Number(attempts) || 1);
  const normalizedDelayMs = Math.max(0, Number(delayMs) || 0);
  const normalizedSettleDelayMs = Math.max(0, Number(settleDelayMs) || 0);
  let lastError = null;
  let sawTransientProofChannelDisconnect = false;

  if (normalizedSettleDelayMs > 0) {
    await wait(normalizedSettleDelayMs);
  }

  for (let attempt = 1; attempt <= normalizedAttempts; attempt += 1) {
    try {
      const response = await runCli(
        ['ipc-get-backend-state', '--json', '--app-identifier', String(appIdentifier)],
        { appIdentifier, env },
      );
      throwIfTauriMcpCliError(response);
      return response;
    } catch (error) {
      lastError = error;
      sawTransientProofChannelDisconnect = sawTransientProofChannelDisconnect || isTransientWebviewConnectionError(error);
      if (attempt < normalizedAttempts) {
        await wait(normalizedDelayMs);
      }
    }
  }

  const result = {
    ok: false,
    error: lastError instanceof Error ? lastError.message : String(lastError ?? 'backend state unavailable'),
  };
  if (sawTransientProofChannelDisconnect) {
    result.blocker = 'proof_channel_disconnect';
  }
  return result;
}

export function summarizeTauriOnboardingWizardQaProof({ stepArtifacts = {} } = {}) {
  return summarizeQaStepArtifactsProof({
    stepArtifacts,
    requiredStepIds: buildStepPlan().map((step) => step.id),
  });
}

async function clickSelector(selector, { appIdentifier, env } = {}) {
    const rawSelector = String(selector);
    const normalizedSelector = rawSelector.replace(
        /^\[data-testid="([^"]+)"\]$/u,
        (_match, testId) => `[data-testid='${testId}']`,
    );
    await runOnboardingWizardMcpCli(
        [
            'webview-wait-for',
            '--type',
            'selector',
            '--strategy',
            'css',
            '--value',
            normalizedSelector,
            '--timeout',
            String(selectorWaitMs),
            '--app-identifier',
            String(appIdentifier),
        ],
        { appIdentifier, env, timeoutMs: cliSelectorWaitTimeoutMs },
    );
    await runOnboardingWizardMcpCli(
        [
            'webview-interact',
            '--action',
            'focus',
            '--selector',
            normalizedSelector,
            '--app-identifier',
            String(appIdentifier),
        ],
        { appIdentifier, env, timeoutMs: cliInteractTimeoutMs },
    ).catch(() => {});
    await runOnboardingWizardMcpCli(
        [
            'webview-interact',
            '--action',
            'click',
            '--selector',
            normalizedSelector,
            '--app-identifier',
            String(appIdentifier),
        ],
        { appIdentifier, env, timeoutMs: cliInteractTimeoutMs },
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
  await runOnboardingWizardMcpCli(
    [
      'webview-execute-js',
      '--script',
      script,
      '--app-identifier',
      String(appIdentifier),
      '--json',
    ],
    { appIdentifier, env },
  ).catch(() => {});
}

async function navigateToWizardStep(stepId, { appIdentifier, env }) {
  await navigateWebviewToPath(buildOnboardingWizardPath(stepId), { appIdentifier, env });
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

export async function main(
  argv = process.argv.slice(2),
  {
    runCapture = null,
    stdout = process.stdout,
    stderr = process.stderr,
    processApi = process,
  } = {},
) {
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
    stdout.write(JSON.stringify({ ok: true, plan }, null, 2) + '\n');
    return;
  }

  if (typeof runCapture === 'function') {
    const result = await runCapture({ plan, env: process.env });
    stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (!result.ok) {
      processApi.exitCode = 1;
    }
    return;
  }

  // Ensure internal workspace packages have their `dist/` outputs built before we drive the
  // Tauri webview. This avoids Metro/Tauri crashes due to missing internal export entrypoints.
  await ensureUiWorkspacePackagesBuilt({ env: process.env });

  await ensureDir(plan.artifactRoot);

  const driverSessionAttemptsFile = join(plan.artifactRoot, '00-driver-session-attempts.jsonl');
  const candidatePorts = resolveCandidateDriverSessionPorts({ preferredPort: plan.driverSessionPort, env: process.env });
  const targetedDriverSession = await startTargetedDriverSession({
    candidatePorts,
    runCliJson: (args) => runOnboardingWizardMcpCliJson(args, { env: process.env }),
    appendAttempt: (entry) => appendJsonLineArtifact(driverSessionAttemptsFile, entry),
  });

  const {
    driverSessionPort: usedDriverSessionPort,
    driverSessionResponse,
    driverSessionStatusResponse,
    resolvedAppTarget,
  } = targetedDriverSession;

  const driverSessionCommand = ['yarn', ...plan.driverSession.baseArgs, 'driver-session', 'start', '--port', String(usedDriverSessionPort)].join(' ');
  const driverSessionResponseFile = join(plan.artifactRoot, '00-driver-session.json');
  await writeTextArtifact(driverSessionResponseFile, `${JSON.stringify(driverSessionResponse, null, 2)}\n`);

  const driverSessionStatusCommand = ['yarn', ...plan.driverSession.baseArgs, 'driver-session', 'status', '--port', String(usedDriverSessionPort)].join(' ');
  const driverSessionStatusResponseFile = join(plan.artifactRoot, '00-driver-session-status.json');
  await writeTextArtifact(driverSessionStatusResponseFile, `${JSON.stringify(driverSessionStatusResponse, null, 2)}\n`);

  if (!resolvedAppTarget) {
    throw new Error('Unable to resolve a connected Tauri app identifier from driver-session status.');
  }
  const resolvedAppIdentifier = resolvedAppTarget.port;

  const backendStateFile = join(plan.artifactRoot, '00-backend-state.json');
  const backendState = await readBackendStateWithRetries({
    appIdentifier: resolvedAppIdentifier,
    env: process.env,
  });
  await writeTextArtifact(
    backendStateFile,
    backendState && backendState.ok === false
      ? `${JSON.stringify(backendState, null, 2)}\n`
      : String(backendState.stdout ?? ''),
  );
  if (backendState && backendState.ok === false) {
    const backendStateFailureReason = backendState.blocker === 'proof_channel_disconnect'
      ? `proof-channel disconnect: ${backendState.error}`
      : backendState.error;
    await appendWarning(plan.artifactRoot, `- backend state probe failed: ${backendStateFailureReason}`);
  }

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

  const bootstrapSurface = await resolvePostAuthBootstrapSurface({
    appIdentifier: resolvedAppIdentifier,
    env: process.env,
  });
  const onboardingRootPresent = bootstrapSurface.kind === 'onboardingWizard';
  const setupWizardPresent = bootstrapSurface.kind === 'setupWizard';
  if (!onboardingRootPresent && !setupWizardPresent) {
    await appendWarning(plan.artifactRoot, '- onboarding wizard root not present at /; trying the debug relay selection deep-link and continuing with setup surfaces if needed');
    await navigateToWizardStep('relay_select', { appIdentifier: resolvedAppIdentifier, env: process.env });
  }

  // 1) Welcome
  if (onboardingRootPresent) {
    await captureRequired('welcome');
  }

  // 2) Skip -> Auth (best-effort). This validates the skip affordance without relying on copy.
  if (onboardingRootPresent && await isSelectorPresent('[data-testid="onboarding-wizard-skip"]', { appIdentifier: resolvedAppIdentifier, env: process.env })) {
    try {
      await clickSelector('[data-testid="onboarding-wizard-skip"]', { appIdentifier: resolvedAppIdentifier, env: process.env });
    } catch (error) {
      await appendWarning(plan.artifactRoot, `- skip click failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await captureBestEffort('auth_skip');
  } else if (onboardingRootPresent) {
    await appendWarning(plan.artifactRoot, '- skip button not present on welcome surface; unable to validate skip navigation');
  }

  // Return to the wizard root to continue the main flow.
  if (onboardingRootPresent) {
    await navigateWebviewToPath('/', { appIdentifier: resolvedAppIdentifier, env: process.env });
    await captureRequired('welcome');
  }

  // 3) Advance to relay (if applicable)
  if (onboardingRootPresent) {
    try {
      await clickSelector('[data-testid="onboarding-wizard-primary"]', { appIdentifier: resolvedAppIdentifier, env: process.env });
    } catch (error) {
      await appendWarning(plan.artifactRoot, `- welcome primary click failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const relayArtifacts = await captureBestEffort('relay');
  const relayChoiceSelectors = [
    { choiceId: 'cloud', selector: '[data-testid="onboarding-wizard-relay:cloud"]' },
    { choiceId: 'thisComputer', selector: '[data-testid="onboarding-wizard-relay:thisComputer"]' },
    { choiceId: 'customUrl', selector: '[data-testid="onboarding-wizard-relay:customUrl"]' },
  ];
  if (relayArtifacts) {
    for (const choice of relayChoiceSelectors) {
      // eslint-disable-next-line no-await-in-loop
      if (await isSelectorPresent(choice.selector, { appIdentifier: resolvedAppIdentifier, env: process.env, timeoutMs: 1200 })) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await clickSelector(choice.selector, { appIdentifier: resolvedAppIdentifier, env: process.env });
          // eslint-disable-next-line no-await-in-loop
          const choiceArtifacts = await captureRelayChoiceArtifacts({ artifactRoot: plan.artifactRoot, appIdentifier: resolvedAppIdentifier, env: process.env, choiceId: choice.choiceId });
          stepArtifacts[`relay:${choice.choiceId}`] = choiceArtifacts;
        } catch (error) {
          // eslint-disable-next-line no-await-in-loop
          await appendWarning(plan.artifactRoot, `- relay choice ${choice.choiceId} click/capture failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

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
  } else if (!onboardingRootPresent && !setupWizardPresent) {
    await navigateToWizardStep('relay_select', { appIdentifier: resolvedAppIdentifier, env: process.env });
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

  let optionalSetupArtifacts = null;
  try {
    optionalSetupArtifacts = await captureOptionalStep(optionalSetupStep, {
      artifactRoot: plan.artifactRoot,
      appIdentifier: resolvedAppIdentifier,
      env: process.env,
    });
  } catch (error) {
    await appendWarning(plan.artifactRoot, `- setup surface capture failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // If we're authenticated but currently not on the setup wizard route, try to
  // navigate there once and capture it (best-effort).
  let optionalSetupArtifactsRetried = null;
  if (!optionalSetupArtifacts) {
    try {
      await navigateWebviewToPath('/setup/wizard', { appIdentifier: resolvedAppIdentifier, env: process.env });
      optionalSetupArtifactsRetried = await captureOptionalStep(optionalSetupStep, {
        artifactRoot: plan.artifactRoot,
        appIdentifier: resolvedAppIdentifier,
        env: process.env,
      });
    } catch (error) {
      await appendWarning(plan.artifactRoot, `- setup surface retry capture failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (optionalSetupArtifacts || optionalSetupArtifactsRetried) {
    stepArtifacts[optionalSetupStep.id] = optionalSetupArtifacts ?? optionalSetupArtifactsRetried;
  }

  const proofSummary = summarizeTauriOnboardingWizardQaProof({ stepArtifacts });
  if (!proofSummary.ok) {
    const warning = proofSummary.blocker === 'no_step_artifacts_captured'
      ? '- no step artifacts were captured during the native proof run; the live stack still is not exposing the expected post-auth surfaces'
      : '- required step artifacts were incomplete during the native proof run; the live stack is not authoritative yet';
    await appendWarning(plan.artifactRoot, warning);
  }

  const consoleLogs = await runOnboardingWizardMcpCli(
    ['read-logs', '--source', 'console', '--json', '--app-identifier', String(resolvedAppIdentifier)],
    { appIdentifier: resolvedAppIdentifier, env: process.env },
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
        ok: proofSummary.ok,
        artifactRoot: plan.artifactRoot,
        trackerPath: plan.trackerPath,
        appIdentifier: resolvedAppIdentifier,
        blocker: proofSummary.blocker,
        steps: proofSummary.steps,
      },
      null,
      2,
    ) + '\n',
  );

  if (!proofSummary.ok) {
    process.exitCode = 1;
  }
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && process.argv[1] === currentFilePath) {
  main().catch((error) => {
    process.stderr.write(`[tauri-onboarding-wizard-qa] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
