#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import process from 'node:process';

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

function buildStepPlan() {
  return [
    {
      id: 'welcome',
      title: 'Welcome / root',
      selectors: ['[data-testid="onboarding-wizard"]', '[data-testid="onboarding-wizard-primary"]', '[data-testid="onboarding-wizard-scan"]'],
      screenshot: '01-welcome.png',
      domStructure: '01-welcome.structure.yml',
      domAccessibility: '01-welcome.a11y.yml',
      notes: ['capture the pre-auth landing surface before navigation'],
    },
    {
      id: 'relay',
      title: 'Relay selection',
      selectors: [
        '[data-testid="onboarding-wizard-relay-diagram"]',
        '[data-testid="onboarding-wizard-relay:cloud"]',
        '[data-testid="onboarding-wizard-relay:thisMac"]',
        '[data-testid="onboarding-wizard-relay:customUrl"]',
        '[data-testid="onboarding-wizard-relay-url-input"]',
      ],
      screenshot: '02-setup.png',
      domStructure: '02-setup.structure.yml',
      domAccessibility: '02-setup.a11y.yml',
      notes: ['validate relay diagram + selectable rows'],
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
      screenshot: '03-auth.png',
      domStructure: '03-auth.structure.yml',
      domAccessibility: '03-auth.a11y.yml',
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
      screenshot: '04-restore.png',
      domStructure: '04-restore.structure.yml',
      domAccessibility: '04-restore.a11y.yml',
      notes: ['capture restore surfaces and manual recovery affordances'],
    },
    {
      id: 'lost_access',
      title: 'Lost access / reset',
      selectors: ['[data-testid^="lost-access-provider-"]', '[data-testid="common.back"]', '[data-testid="common.cancel"]'],
      screenshot: '05-lost-access.png',
      domStructure: '05-lost-access.structure.yml',
      domAccessibility: '05-lost-access.a11y.yml',
      notes: ['capture provider reset affordances and the server-gated recovery list'],
    },
  ];
}

export function buildTauriOnboardingWizardQaPlan({ env = process.env } = {}) {
  const driverSessionPort = readNumber(
    env.HAPPIER_TAURI_MCP_APP_IDENTIFIER ?? env.HAPPIER_TAURI_MCP_PORT ?? env.HAPPIER_TAURI_APP_PORT,
    9223,
  );
  const trackerPath = readString(env.HAPPIER_TAURI_QA_TRACKER_PATH, defaultTrackerPath);
  const artifactRoot = readString(
    env.HAPPIER_TAURI_QA_OUTDIR,
    resolveWizardQaArtifactRoot(repoRoot, { date: new Date(), runId: nowStamp() }),
  );
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

async function captureStep(step, { artifactRoot, appIdentifier, env }) {
  const screenshotPath = join(artifactRoot, step.screenshot);
  const structurePath = join(artifactRoot, step.domStructure);
  const a11yPath = join(artifactRoot, step.domAccessibility);

  await runTauriMcpCli(
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
  );

  const structure = await runTauriMcpCli(
    [
      'webview-dom-snapshot',
      '--type',
      'structure',
      '--app-identifier',
      String(appIdentifier),
    ],
    { cwd: packageRoot, env },
  );
  await writeTextArtifact(structurePath, String(structure.stdout ?? ''));

  const accessibility = await runTauriMcpCli(
    [
      'webview-dom-snapshot',
      '--type',
      'accessibility',
      '--app-identifier',
      String(appIdentifier),
    ],
    { cwd: packageRoot, env },
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

  // Ensure we always start from a fresh driver session. Stale sessions can keep
  // the MCP bridge "connected" while the underlying plugin/webview connection is
  // dead, leading to `Not connected to plugin and reconnection failed`.
  await runTauriMcpCli(
    [
      'driver-session',
      'stop',
      '--port',
      String(plan.driverSessionPort),
    ],
    { cwd: plan.packageRoot, env: process.env },
  ).catch(() => {});

  const driverSessionResponse = await runTauriMcpCliJson(plan.driverSession.args, {
    cwd: plan.packageRoot,
    env: {
      ...process.env,
      HAPPIER_TAURI_MCP_APP_IDENTIFIER: String(plan.driverSessionPort),
    },
  });
  const driverSessionCommand = ['yarn', ...plan.driverSession.baseArgs, ...plan.driverSession.args].join(' ');
  const driverSessionResponseFile = join(plan.artifactRoot, '00-driver-session.json');
  await writeTextArtifact(driverSessionResponseFile, `${JSON.stringify(driverSessionResponse, null, 2)}\n`);

  const driverSessionStatusResponse = await runTauriMcpCliJson(
    ['driver-session', 'status', '--port', String(plan.driverSessionPort)],
    { cwd: plan.packageRoot, env: process.env },
  );
  const driverSessionStatusCommand = ['yarn', ...plan.driverSession.baseArgs, 'driver-session', 'status', '--port', String(plan.driverSessionPort)].join(' ');
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

  const stepArtifacts = {};

  for (const step of plan.steps) {
    let artifacts = await captureOptionalStep(step, {
      artifactRoot: plan.artifactRoot,
      appIdentifier: resolvedAppIdentifier,
      env: process.env,
    });

    // If the wizard isn't currently visible (for example: app is sitting on /setup
    // after a previous run), try navigating back to / once and retry.
    if (!artifacts && step.id === 'welcome') {
      await navigateWebviewToPath('/', { appIdentifier: resolvedAppIdentifier, env: process.env });
      artifacts = await captureOptionalStep(step, {
        artifactRoot: plan.artifactRoot,
        appIdentifier: resolvedAppIdentifier,
        env: process.env,
      });
    }

    if (!artifacts) {
      continue;
    }

    stepArtifacts[step.id] = artifacts;

    if (step.id === 'welcome') {
      await runTauriMcpCli(
        [
          'webview-interact',
          '--action',
          'click',
          '--selector',
          '[data-testid="onboarding-wizard-primary"]',
          '--app-identifier',
          String(resolvedAppIdentifier),
        ],
        { cwd: plan.packageRoot, env: process.env },
      ).catch(() => {});
    }

    if (step.id === 'relay') {
      await runTauriMcpCli(
        [
          'webview-interact',
          '--action',
          'click',
          '--selector',
          '[data-testid="onboarding-wizard-primary"]',
          '--app-identifier',
          String(resolvedAppIdentifier),
        ],
        { cwd: plan.packageRoot, env: process.env },
      ).catch(() => {});
    }

    if (step.id === 'auth') {
      await runTauriMcpCli(
        [
          'webview-interact',
          '--action',
          'click',
          '--selector',
          '[data-testid="welcome-restore"]',
          '--app-identifier',
          String(resolvedAppIdentifier),
        ],
        { cwd: plan.packageRoot, env: process.env },
      ).catch(() => {});
    }

    if (step.id === 'restore') {
      await runTauriMcpCli(
        [
          'webview-interact',
          '--action',
          'click',
          '--selector',
          '[data-testid="restore-open-lost-access"]',
          '--app-identifier',
          String(resolvedAppIdentifier),
        ],
        { cwd: plan.packageRoot, env: process.env },
      ).catch(() => {});
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
    screenshot: '06-setup.png',
    domStructure: '06-setup.structure.yml',
    domAccessibility: '06-setup.a11y.yml',
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
