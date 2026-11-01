import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  DEFAULT_CPU_SAMPLE_INTERVAL_MS,
  DEFAULT_PROFILE_DURATION_MS,
  DEFAULT_PROFILE_INTERVAL_MS,
  parseDurationMs,
  parsePositiveInteger,
  resolveProcessTarget,
  runProcessProfile,
} from './process_profiler.mjs';

export const DEFAULT_MOBILE_PROFILE_APP_PROCESS = 'Happierinternaldev';
export const DEFAULT_MOBILE_PROFILE_METRO_PORT = 18829;
export const DEFAULT_MOBILE_PROFILE_FLOW_DIR = '.argent/flows';
export const DEFAULT_MOBILE_PROFILE_START_DELAY_MS = 1_000;
export const DEFAULT_MOBILE_PROFILE_READY_TIMEOUT_MS = 10_000;

function flowName(name) {
  return `happier-${name}-profile`;
}

function echo(message) {
  return { echo: message };
}

function tap(label, { x, y, delayMs = null }) {
  return { label, tool: 'gesture-tap', delayMs, args: { x, y } };
}

function tapReactTestId(label, { testID, delayMs = null }) {
  return { label, tool: 'tap-react-test-id', delayMs, args: { testID } };
}

function swipe(label, { fromX, fromY, toX, toY, durationMs = 550, delayMs = null }) {
  return { label, tool: 'gesture-swipe', delayMs, args: { fromX, fromY, toX, toY, durationMs } };
}

function describe(label, { delayMs = null, expect = null } = {}) {
  return { label, tool: 'describe', delayMs, args: {}, expectDescription: expect };
}

function screenshot(label, { delayMs = null } = {}) {
  return { label, tool: 'screenshot', delayMs, args: {} };
}

const SCENARIOS = [
  {
    name: 'ios-session-list',
    flowName: flowName('ios-session-list'),
    description: 'Session list scrolling with visible live/working rows.',
    prerequisite:
      'iOS simulator <udid> is booted, Happier dev client is loaded from Metro <metroPort>, user is authenticated, root session list is visible, no modal or keyboard is open, and the list has multiple rows including any active streaming/working sessions available for this run.',
    steps: [
      describe('Confirm session list is visible before list profiling', { expect: 'sessions-list' }),
      swipe('Scroll session list down', { fromX: 0.52, fromY: 0.82, toX: 0.52, toY: 0.32, delayMs: 1_000 }),
      swipe('Scroll session list further down', { fromX: 0.52, fromY: 0.82, toX: 0.52, toY: 0.32, delayMs: 1_000 }),
      swipe('Scroll session list back up', { fromX: 0.52, fromY: 0.32, toX: 0.52, toY: 0.82, delayMs: 1_000 }),
      swipe('Scroll session list back to the starting region', { fromX: 0.52, fromY: 0.32, toX: 0.52, toY: 0.82, delayMs: 1_000 }),
      describe('Confirm session list remains visible after scrolling', { expect: 'sessions-list' }),
    ],
  },
  {
    name: 'ios-root-tabs',
    flowName: flowName('ios-root-tabs'),
    description: 'Root bottom tab switching between sessions/inbox and settings without opening a session.',
    prerequisite:
      'iOS simulator <udid> is booted, Happier dev client is loaded from Metro <metroPort>, user is authenticated, root bottom tab bar is visible, the session list has rendered rows, and no modal or keyboard is open.',
    steps: [
      describe('Confirm root tab bar and starting surface are visible', { expect: 'sessions-list' }),
      tapReactTestId('Open Settings root tab', { testID: 'tabbar-tab-settings', delayMs: 2_500 }),
      tapReactTestId('Reselect Settings root tab to normalize nested settings routes', {
        testID: 'tabbar-tab-settings',
        delayMs: 1_500,
      }),
      describe('Confirm Settings surface is visible', { delayMs: 2_500, expect: 'settings-surface' }),
      tapReactTestId('Return to sessions/list root tab', { testID: 'tabbar-tab-sessions', delayMs: 2_500 }),
      describe('Confirm session list is visible after returning from Settings', { delayMs: 2_500, expect: 'sessions-list' }),
      tapReactTestId('Open Settings root tab again', { testID: 'tabbar-tab-settings', delayMs: 2_500 }),
      tapReactTestId('Reselect Settings root tab again before returning to Sessions', {
        testID: 'tabbar-tab-settings',
        delayMs: 1_500,
      }),
      tapReactTestId('Return to sessions/list root tab again', { testID: 'tabbar-tab-sessions', delayMs: 2_500 }),
      describe('Confirm repeated tab switch ends on visible session list', { delayMs: 2_500, expect: 'sessions-list' }),
    ],
  },
  {
    name: 'ios-idle-session',
    flowName: flowName('ios-idle-session'),
    description: 'Open a non-streaming session view and idle on it.',
    prerequisite:
      'iOS simulator <udid> is booted, Happier dev client is loaded from Metro <metroPort>, user is authenticated, root session list is visible, and the tap target row is a known idle/non-streaming session.',
    steps: [
      describe('Confirm idle session row is visible before opening', { expect: 'sessions-list' }),
      tap('Open the target idle session row', { x: 0.5, y: 0.542, delayMs: 1_000 }),
      describe('Confirm idle session view is visible', { delayMs: 5_000, expect: 'session-view' }),
      screenshot('Idle session view checkpoint', { delayMs: 10_000 }),
      describe('Confirm idle session remains stable after wait', { expect: 'session-view' }),
    ],
  },
  {
    name: 'ios-streaming-session',
    flowName: flowName('ios-streaming-session'),
    description: 'Open a currently streaming/working session view and wait while updates arrive.',
    prerequisite:
      'iOS simulator <udid> is booted, Happier dev client is loaded from Metro <metroPort>, user is authenticated, root session list is visible, the tap target row is actively streaming/working, and live updates are arriving.',
    steps: [
      describe('Confirm active streaming row is visible before opening', { expect: 'sessions-list' }),
      tap('Open the target streaming session row', { x: 0.5, y: 0.681, delayMs: 1_000 }),
      describe('Confirm streaming session view is visible', { delayMs: 5_000, expect: 'session-view' }),
      screenshot('Streaming session wait checkpoint', { delayMs: 15_000 }),
      describe('Confirm streaming session is still visible after updates', { expect: 'session-view' }),
    ],
  },
  {
    name: 'ios-cockpit-tabs',
    flowName: flowName('ios-cockpit-tabs'),
    description: 'Switch between cockpit tabs inside an already-open session.',
    prerequisite:
      'iOS simulator <udid> is booted, Happier dev client is loaded from Metro <metroPort>, user is authenticated, a session view is open, the cockpit bottom tab bar is visible, and no keyboard is open.',
    steps: [
      describe('Confirm cockpit tab bar is visible before switching', { expect: 'session-view' }),
      tap('Open cockpit tab 2', { x: 0.501, y: 0.946, delayMs: 1_000 }),
      describe('Confirm cockpit tab 2 surface', { delayMs: 1_500, expect: 'session-view' }),
      tap('Open cockpit tab 3', { x: 0.64, y: 0.946, delayMs: 1_000 }),
      describe('Confirm cockpit tab 3 surface', { delayMs: 1_500, expect: 'session-view' }),
      tap('Open cockpit tab 4', { x: 0.779, y: 0.946, delayMs: 1_000 }),
      describe('Confirm cockpit tab 4 surface', { delayMs: 1_500, expect: 'session-view' }),
      tap('Return to cockpit tab 1/chat', { x: 0.361, y: 0.946, delayMs: 1_000 }),
      describe('Confirm cockpit tab 1/chat surface after round trip', { delayMs: 1_500, expect: 'session-view' }),
    ],
  },
  {
    name: 'ios-back-swipe',
    flowName: flowName('ios-back-swipe'),
    description: 'Native edge-swipe back from session view to a still-visible session list.',
    prerequisite:
      'iOS simulator <udid> is booted, Happier dev client is loaded from Metro <metroPort>, user is authenticated, a session opened from the root list is visible, the native back gesture is available, and no keyboard is open.',
    steps: [
      describe('Confirm session view is visible before edge-swipe back', { expect: 'session-view' }),
      swipe('Perform native left-edge back swipe to return to the list', {
        fromX: 0.01,
        fromY: 0.52,
        toX: 0.86,
        toY: 0.52,
        durationMs: 650,
        delayMs: 1_000,
      }),
      describe('Confirm session list is immediately visible after edge-swipe', { delayMs: 2_000, expect: 'sessions-list' }),
    ],
  },
  {
    name: 'ios-long-idle-tail',
    flowName: flowName('ios-long-idle-tail'),
    description: 'Post-flow idle checkpoints for retained CPU/RSS and background streaming workload observation.',
    prerequisite:
      'iOS simulator <udid> is booted, Happier dev client is loaded from Metro <metroPort>, user is authenticated, the app is in the chosen post-flow state, profilers are running externally, and no manual interaction should occur during the idle tail.',
    steps: [
      describe('Idle tail baseline state before waiting'),
      screenshot('Idle tail checkpoint after 60 seconds', { delayMs: 60_000 }),
      screenshot('Idle tail checkpoint after 180 seconds', { delayMs: 120_000 }),
      describe('Idle tail final state after checkpoints'),
    ],
  },
  {
    name: 'ios-long-session-root-cockpit-cycle',
    flowName: flowName('ios-long-session-root-cockpit-cycle'),
    description: 'Composite priority flow: list scroll, root tabs, session open, cockpit tabs, and back-swipe.',
    prerequisite:
      'iOS simulator <udid> is booted, Happier dev client is loaded from Metro <metroPort>, user is authenticated, root session list is visible with active rows, no modal or keyboard is open, and the target row can open a cockpit-enabled session.',
    steps: [
      describe('Composite flow starts on visible session list', { expect: 'sessions-list' }),
      swipe('Composite: scroll list down', { fromX: 0.52, fromY: 0.82, toX: 0.52, toY: 0.32, delayMs: 1_000 }),
      swipe('Composite: scroll list back up', { fromX: 0.52, fromY: 0.32, toX: 0.52, toY: 0.82, delayMs: 1_000 }),
      tap('Composite: open Settings root tab', { x: 0.64, y: 0.946, delayMs: 1_000 }),
      tap('Composite: normalize Settings stack to its root if it resumed a nested settings screen', { x: 0.15, y: 0.096, delayMs: 1_000 }),
      tap('Composite: return to session list root tab', { x: 0.501, y: 0.946, delayMs: 1_500 }),
      describe('Composite: confirm list before opening session', { delayMs: 1_500, expect: 'sessions-list' }),
      tap('Composite: open target session row', { x: 0.5, y: 0.424, delayMs: 1_000 }),
      describe('Composite: confirm session view opened', { delayMs: 2_000, expect: 'session-view' }),
      tap('Composite: cockpit tab 2', { x: 0.501, y: 0.946, delayMs: 1_000 }),
      tap('Composite: cockpit tab 3', { x: 0.64, y: 0.946, delayMs: 1_000 }),
      tap('Composite: cockpit tab 4', { x: 0.779, y: 0.946, delayMs: 1_000 }),
      tap('Composite: return cockpit tab 1/chat', { x: 0.361, y: 0.946, delayMs: 1_000 }),
      swipe('Composite: native edge-swipe back to list', {
        fromX: 0.01,
        fromY: 0.52,
        toX: 0.86,
        toY: 0.52,
        durationMs: 650,
        delayMs: 1_000,
      }),
      describe('Composite: confirm visible list after session back-swipe', { delayMs: 2_000, expect: 'sessions-list' }),
    ],
  },
];

const SCENARIO_BY_NAME = new Map(SCENARIOS.map((scenario) => [scenario.name, scenario]));

function cloneScenario(scenario) {
  return {
    name: scenario.name,
    flowName: scenario.flowName,
    description: scenario.description,
    prerequisite: scenario.prerequisite,
    steps: scenario.steps.map((step) => ({
      ...step,
      args: step.args ? { ...step.args } : undefined,
    })),
  };
}

export function listMobileProfileScenarios() {
  return SCENARIOS.map(cloneScenario);
}

export function resolveMobileProfileScenario(name) {
  const key = String(name ?? '').trim();
  if (!key) {
    throw new Error(`Pass --scenario. Available scenarios: ${SCENARIOS.map((scenario) => scenario.name).join(', ')}`);
  }
  const scenario = SCENARIO_BY_NAME.get(key);
  if (!scenario) {
    throw new Error(`Unknown mobile profiling scenario "${key}". Available scenarios: ${SCENARIOS.map((entry) => entry.name).join(', ')}`);
  }
  return cloneScenario(scenario);
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ''));
}

function formatScalar(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return yamlString(value);
}

function renderFlowStep(step, { udid }) {
  if (Object.prototype.hasOwnProperty.call(step, 'echo')) {
    return [`  - echo: ${yamlString(step.echo)}`];
  }
  const lines = [`  - echo: ${yamlString(step.label)}`, `  - tool: ${step.tool}`];
  if (step.delayMs != null) {
    lines.push(`    delayMs: ${parsePositiveInteger(step.delayMs, 'delayMs')}`);
  }
  lines.push('    args:');
  lines.push(`      udid: ${yamlString(udid)}`);
  for (const [key, value] of Object.entries(step.args ?? {})) {
    lines.push(`      ${key}: ${formatScalar(value)}`);
  }
  return lines;
}

const DESCRIPTION_MATCHERS = {
  'sessions-list': {
    label: 'sessions-list',
    match: (description) => description.includes('AXStaticText "Sessions"') && description.includes('Search sessions'),
  },
  'session-view': {
    label: 'session-view',
    match: (description) => description.includes('Open session actions') && description.includes('Session Info'),
  },
  'settings-surface': {
    label: 'settings-surface',
    match: (description) =>
      description.includes('AXGroup "Settings"') ||
      description.includes('AXGroup "Keyboard shortcuts"') ||
      description.includes('AXStaticText "KEYBOARD CONTROLS"'),
  },
};

function expectedDescriptionChecks(scenario) {
  const checks = [];
  for (const step of scenario.steps) {
    if (step.tool === 'describe' && step.expectDescription) {
      checks.push({ label: step.label, expected: step.expectDescription });
    }
  }
  return checks;
}

function flowResultSteps(flowResult) {
  if (Array.isArray(flowResult?.json?.steps)) return flowResult.json.steps;
  if (typeof flowResult?.stdout !== 'string' || !flowResult.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(flowResult.stdout);
    return Array.isArray(parsed?.steps) ? parsed.steps : [];
  } catch {
    return [];
  }
}

function descriptionExcerpt(description) {
  return String(description ?? '')
    .split('\n')
    .filter((line) => line.includes('AXStaticText') || line.includes('AXGroup') || line.includes('AXButton'))
    .slice(0, 8)
    .join('\n');
}

export function validateMobileProfileFlowResult({ scenario, flowResult } = {}) {
  const expectations = expectedDescriptionChecks(scenario ?? { steps: [] });
  if (!expectations.length) return { ok: true, checks: [] };

  if (!flowResult?.ok) {
    return {
      ok: false,
      checks: expectations.map((entry) => ({ ...entry, ok: false, reason: 'flow execution failed before checkpoint validation' })),
    };
  }

  const steps = flowResultSteps(flowResult);
  const pending = new Map(expectations.map((entry) => [entry.label, []]));
  for (const expectation of expectations) {
    pending.get(expectation.label).push(expectation);
  }

  const checks = [];
  let lastEcho = null;
  for (const step of steps) {
    if (step?.kind === 'echo') {
      lastEcho = String(step.message ?? '');
      continue;
    }
    if (step?.kind !== 'tool' || step.tool !== 'describe' || !lastEcho) continue;
    const entries = pending.get(lastEcho);
    if (!entries?.length) continue;
    const expectation = entries.shift();
    const expected = expectation.expected;
    const matcher = DESCRIPTION_MATCHERS[expected];
    const description = String(step.result?.description ?? '');
    const ok = typeof matcher?.match === 'function' ? matcher.match(description) : false;
    checks.push({
      label: expectation.label,
      expected,
      ok,
      excerpt: ok ? null : descriptionExcerpt(description),
    });
  }

  for (const entries of pending.values()) {
    for (const expectation of entries) {
      checks.push({ ...expectation, ok: false, reason: 'matching describe checkpoint was not found in flow result' });
    }
  }

  return { ok: checks.every((check) => check.ok), checks };
}

function materializePrerequisite(template, { udid, metroPort }) {
  return String(template).replaceAll('<udid>', udid).replaceAll('<metroPort>', String(metroPort));
}

export function buildArgentFlowYaml({
  scenario,
  scenarioName = null,
  udid,
  metroPort = DEFAULT_MOBILE_PROFILE_METRO_PORT,
} = {}) {
  const resolved = scenario ?? resolveMobileProfileScenario(scenarioName);
  const normalizedUdid = String(udid ?? '').trim();
  if (!normalizedUdid) {
    throw new Error('Pass --udid to generate an Argent flow.');
  }
  const normalizedMetroPort = parsePositiveInteger(metroPort, 'metroPort');
  const lines = [
    `executionPrerequisite: ${yamlString(materializePrerequisite(resolved.prerequisite, { udid: normalizedUdid, metroPort: normalizedMetroPort }))}`,
    'steps:',
  ];
  for (const step of resolved.steps) {
    lines.push(...renderFlowStep(step, { udid: normalizedUdid }));
  }
  return lines.join('\n') + '\n';
}

function safeFileName(raw) {
  const value = String(raw ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return value || 'happier-mobile-profile';
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '').replace('T', '-').replace('Z', 'Z');
}

export async function writeArgentFlowFile({
  projectRoot,
  flowDir = DEFAULT_MOBILE_PROFILE_FLOW_DIR,
  scenario,
  scenarioName = null,
  udid,
  metroPort = DEFAULT_MOBILE_PROFILE_METRO_PORT,
} = {}) {
  const resolved = scenario ?? resolveMobileProfileScenario(scenarioName);
  const root = String(projectRoot ?? '').trim() ? resolve(projectRoot) : process.cwd();
  const dir = resolve(root, flowDir);
  const yaml = buildArgentFlowYaml({ scenario: resolved, udid, metroPort });
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${safeFileName(resolved.flowName)}.yaml`);
  await writeFile(file, yaml, 'utf-8');
  return { scenario: resolved, flowName: resolved.flowName, file, yaml };
}

function runJsonCommand(command, args, { cwd, env = process.env, timeoutMs = 0 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let didTimeout = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            didTimeout = true;
            try {
              child.kill('SIGTERM');
            } catch {
              // ignore
            }
          }, timeoutMs)
        : null;
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ ok: false, command, args, error: error.message, stdout, stderr, timedOut: didTimeout });
    });
    child.on('exit', (code, signal) => {
      if (timer) clearTimeout(timer);
      let json = null;
      if (stdout.trim()) {
        try {
          json = JSON.parse(stdout);
        } catch {
          json = null;
        }
      }
      resolvePromise({
        ok: code === 0,
        exitCode: code,
        signal: signal ?? null,
        command,
        args,
        stdout,
        stderr,
        json,
        timedOut: didTimeout,
      });
    });
  });
}

export async function executeArgentFlow({
  projectRoot,
  flowName,
  flowFile = null,
  argentBin = 'argent',
  env = process.env,
  timeoutMs = 0,
  runCommand = runJsonCommand,
} = {}) {
  const root = String(projectRoot ?? '').trim() ? resolve(projectRoot) : process.cwd();
  const args = ['run', 'flow-execute', '--name', flowName, '--project_root', root, '--prerequisiteAcknowledged', '--json'];
  if (flowFile) {
    args.push('--flow_file', flowFile);
  }
  return runCommand(argentBin, args, { cwd: root, env, timeoutMs });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function findReactTestIdTapCoordinates(componentTree, testID) {
  const treeText =
    typeof componentTree === 'string'
      ? componentTree
      : typeof componentTree?.tree === 'string'
        ? componentTree.tree
        : typeof componentTree?.description === 'string'
          ? componentTree.description
          : typeof componentTree?.stdout === 'string'
            ? componentTree.stdout
            : '';
  const pattern = new RegExp(`\\[testID=${escapeRegExp(testID)}\\][^\\n]*\\(tap:\\s*(-?\\d+(?:\\.\\d+)?),\\s*(-?\\d+(?:\\.\\d+)?)\\)`);
  for (const line of treeText.split('\n')) {
    const match = line.match(pattern);
    if (!match) continue;
    const x = Number(match[1]);
    const y = Number(match[2]);
    if (Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1) {
      return { x, y, line: line.trim() };
    }
  }
  return null;
}

function isSemanticScenarioStep(step) {
  return step?.tool === 'tap-react-test-id';
}

function scenarioNeedsSemanticExecutor(scenario) {
  return scenario.steps.some(isSemanticScenarioStep);
}

function commandResultPayload(result) {
  return result?.json ?? result?.stdout ?? null;
}

function buildArgentToolArgs({ step, udid, metroPort }) {
  if (step.tool === 'describe') {
    return ['run', 'describe', '--udid', udid, '--json'];
  }
  if (step.tool === 'screenshot') {
    return ['run', 'screenshot', '--udid', udid, '--json'];
  }
  if (step.tool === 'gesture-tap') {
    return ['run', 'gesture-tap', '--udid', udid, '--x', String(step.args.x), '--y', String(step.args.y), '--json'];
  }
  if (step.tool === 'gesture-swipe') {
    return [
      'run',
      'gesture-swipe',
      '--udid',
      udid,
      '--fromX',
      String(step.args.fromX),
      '--fromY',
      String(step.args.fromY),
      '--toX',
      String(step.args.toX),
      '--toY',
      String(step.args.toY),
      '--durationMs',
      String(step.args.durationMs),
      '--json',
    ];
  }
  if (step.tool === 'debugger-component-tree') {
    return ['run', 'debugger-component-tree', '--device_id', udid, '--port', String(metroPort), '--json'];
  }
  return null;
}

function failedScenarioStepResult({ steps, commandResult = null, error }) {
  return {
    ok: false,
    error,
    command: commandResult?.command ?? null,
    args: commandResult?.args ?? null,
    stdout: JSON.stringify({ steps, error }) + '\n',
    stderr: commandResult?.stderr ?? '',
    json: { steps, error },
  };
}

export async function executeMobileProfileScenarioSteps({
  projectRoot,
  scenario,
  udid,
  metroPort = DEFAULT_MOBILE_PROFILE_METRO_PORT,
  argentBin = 'argent',
  env = process.env,
  timeoutMs = 0,
  runCommand = runJsonCommand,
  sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
} = {}) {
  const root = String(projectRoot ?? '').trim() ? resolve(projectRoot) : process.cwd();
  const normalizedMetroPort = parsePositiveInteger(metroPort, 'metroPort');
  const steps = [];
  const tapCoordinateCache = new Map();

  for (const step of scenario.steps) {
    steps.push({ kind: 'echo', message: step.label });
    if (step.delayMs != null) {
      await sleep(parseDurationMs(step.delayMs, 'delayMs') ?? 0);
    }

    if (step.tool === 'tap-react-test-id') {
      let coordinates = tapCoordinateCache.get(step.args.testID) ?? null;
      if (!coordinates) {
        const treeArgs = buildArgentToolArgs({ step: { tool: 'debugger-component-tree' }, udid, metroPort: normalizedMetroPort });
        const treeResult = await runCommand(argentBin, treeArgs, { cwd: root, env, timeoutMs });
        steps.push({
          kind: 'tool',
          tool: 'debugger-component-tree',
          args: { udid, metroPort: normalizedMetroPort },
          ok: treeResult.ok,
          result: commandResultPayload(treeResult),
        });
        if (!treeResult.ok) {
          return failedScenarioStepResult({
            steps,
            commandResult: treeResult,
            error: `Could not resolve React testID "${step.args.testID}" because debugger-component-tree failed.`,
          });
        }
        coordinates = findReactTestIdTapCoordinates(commandResultPayload(treeResult), step.args.testID);
        if (!coordinates) {
          return failedScenarioStepResult({
            steps,
            commandResult: treeResult,
            error: `Could not find a visible tap coordinate for React testID "${step.args.testID}".`,
          });
        }
        tapCoordinateCache.set(step.args.testID, coordinates);
      }
      const tapStep = { tool: 'gesture-tap', args: { x: coordinates.x, y: coordinates.y } };
      const tapArgs = buildArgentToolArgs({ step: tapStep, udid, metroPort: normalizedMetroPort });
      const tapResult = await runCommand(argentBin, tapArgs, { cwd: root, env, timeoutMs });
      steps.push({
        kind: 'tool',
        tool: 'gesture-tap',
        args: { udid, x: coordinates.x, y: coordinates.y, testID: step.args.testID },
        ok: tapResult.ok,
        result: commandResultPayload(tapResult),
      });
      if (!tapResult.ok) {
        return failedScenarioStepResult({
          steps,
          commandResult: tapResult,
          error: `Resolved React testID "${step.args.testID}" to (${coordinates.x}, ${coordinates.y}) but gesture-tap failed.`,
        });
      }
      continue;
    }

    const args = buildArgentToolArgs({ step, udid, metroPort: normalizedMetroPort });
    if (!args) {
      return failedScenarioStepResult({ steps, error: `Unsupported mobile profile scenario tool "${step.tool}".` });
    }
    const result = await runCommand(argentBin, args, { cwd: root, env, timeoutMs });
    steps.push({
      kind: 'tool',
      tool: step.tool,
      args: { udid, ...(step.args ?? {}) },
      ok: result.ok,
      result: commandResultPayload(result),
    });
    if (!result.ok) {
      return failedScenarioStepResult({ steps, commandResult: result, error: `Argent tool "${step.tool}" failed.` });
    }
  }

  return { ok: true, stdout: JSON.stringify({ steps }) + '\n', stderr: '', json: { steps } };
}

function createDeferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function waitForProfileReadiness(profileReadyPromise, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`Process profiler did not capture its first sample within ${timeoutMs}ms.`));
    }, timeoutMs);
    profileReadyPromise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

export async function runMobileProfileScenario({
  projectRoot,
  scenarioName,
  udid,
  metroPort = DEFAULT_MOBILE_PROFILE_METRO_PORT,
  flowDir = DEFAULT_MOBILE_PROFILE_FLOW_DIR,
  executeFlow = false,
  profileProcess = false,
  pid = null,
  commandMatch = null,
  label = null,
  outputDir = join(tmpdir(), 'happier-mobile-profile-scenarios'),
  durationMs = DEFAULT_PROFILE_DURATION_MS,
  intervalMs = DEFAULT_PROFILE_INTERVAL_MS,
  cpuProfileMs = 0,
  sampleIntervalMs = DEFAULT_CPU_SAMPLE_INTERVAL_MS,
  memoryMap = false,
  profileStartDelayMs = DEFAULT_MOBILE_PROFILE_START_DELAY_MS,
  profileReadyTimeoutMs = DEFAULT_MOBILE_PROFILE_READY_TIMEOUT_MS,
  argentBin = 'argent',
  env = process.env,
  flowTimeoutMs = 0,
  runProcessProfileFn = runProcessProfile,
  executeArgentFlowFn = executeArgentFlow,
  executeScenarioStepsFn = executeMobileProfileScenarioSteps,
  sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
  now = () => Date.now(),
} = {}) {
  const scenario = resolveMobileProfileScenario(scenarioName);
  const flow = await writeArgentFlowFile({ projectRoot, flowDir, scenario, udid, metroPort });
  const scenarioLabel = label ?? scenario.name;
  const startedAt = new Date(now()).toISOString();

  if (!executeFlow && !profileProcess) {
    const result = {
      version: 1,
      scenario: {
        name: scenario.name,
        flowName: scenario.flowName,
        description: scenario.description,
      },
      flow: { file: flow.file, name: flow.flowName },
      executed: false,
      profile: null,
      flowResult: null,
      flowValidation: null,
      artifacts: { manifest: null },
    };
    return writeMobileProfileManifest({ result, outputDir, label: scenarioLabel, now });
  }

  let profilePromise = null;
  const profileReady = profileProcess && executeFlow ? createDeferred() : null;
  if (profileProcess) {
    profilePromise = runProcessProfileFn({
      pid,
      commandMatch,
      label: scenarioLabel,
      outputDir,
      durationMs,
      intervalMs,
      cpuProfileMs,
      sampleIntervalMs,
      memoryMap,
      onFirstSample: profileReady
        ? (sample) => {
            profileReady.resolve(sample);
          }
        : null,
    });
    if (profileReady) {
      profilePromise.catch((error) => {
        profileReady.reject(error);
      });
    }
  }

  let flowResult = null;
  if (executeFlow) {
    if (profileReady) {
      await waitForProfileReadiness(profileReady.promise, parseDurationMs(profileReadyTimeoutMs, 'profileReadyTimeoutMs') ?? DEFAULT_MOBILE_PROFILE_READY_TIMEOUT_MS);
    }
    if (profilePromise) {
      await sleep(parseDurationMs(profileStartDelayMs, 'profileStartDelayMs') ?? DEFAULT_MOBILE_PROFILE_START_DELAY_MS);
    }
    flowResult = scenarioNeedsSemanticExecutor(scenario)
      ? await executeScenarioStepsFn({
          projectRoot,
          scenario,
          udid,
          metroPort,
          argentBin,
          env,
          timeoutMs: flowTimeoutMs,
          sleep,
        })
      : await executeArgentFlowFn({
          projectRoot,
          flowName: flow.flowName,
          flowFile: flow.file,
          argentBin,
          env,
          timeoutMs: flowTimeoutMs,
        });
  }
  const flowValidation = executeFlow ? validateMobileProfileFlowResult({ scenario, flowResult }) : null;

  const profile = profilePromise ? await profilePromise : null;
  const result = {
    version: 1,
    scenario: {
      name: scenario.name,
      flowName: scenario.flowName,
      description: scenario.description,
    },
    flow: { file: flow.file, name: flow.flowName },
    startedAt,
    endedAt: new Date(now()).toISOString(),
    executed: executeFlow,
    profile,
    flowResult,
    flowValidation,
    artifacts: { manifest: null },
  };
  return writeMobileProfileManifest({ result, outputDir, label: scenarioLabel, now });
}

export async function resolveMobileProfileTargetPlan({ pid = null, commandMatch = DEFAULT_MOBILE_PROFILE_APP_PROCESS } = {}) {
  return resolveProcessTarget({ pid, commandMatch });
}

async function writeMobileProfileManifest({ result, outputDir, label, now }) {
  const dir = String(outputDir ?? '').trim() ? outputDir : join(tmpdir(), 'happier-mobile-profile-scenarios');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${timestampForPath(new Date(now()))}-${safeFileName(label)}-mobile-profile-manifest.json`);
  const withArtifact = {
    ...result,
    artifacts: {
      ...(result.artifacts ?? {}),
      manifest: file,
    },
  };
  await writeFile(file, JSON.stringify(withArtifact, null, 2) + '\n', 'utf-8');
  return withArtifact;
}
