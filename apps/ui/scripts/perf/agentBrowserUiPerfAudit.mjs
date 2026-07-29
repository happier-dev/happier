#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createRuntimeLimitMeasurementCaptureFromEnv,
  recordAgentBrowserPerfMeasurements,
} from '../../../../packages/tests/scripts/plugin-platform/runtime-limit-measurement.mjs';

const APP_URL_ENV_NAME = 'HAPPIER_UI_PERF_APP_URL';
const DEV_KEY_ENV_NAME = 'HAPPIER_UI_PERF_DEV_KEY';
const DEFAULT_AGENT_BROWSER_SESSION = 'happier-ui-perf';
export const SYNC_TUNING_STORAGE_KEY = 'HAPPIER_SYNC_TUNING_JSON';
const AUDIT_GLOBAL = '__HAPPIER_AGENT_BROWSER_PERF_AUDIT__';
const SCROLL_GLOBAL = '__HAPPIER_AGENT_BROWSER_PERF_SCROLL__';

const DEFAULT_STRESS_TEST_PROMPT = `STRESS TOOLS TESTS

please generate some very very very very long markdown content so I can test markdown streaming into our app
Please instead generate multiple markdown messages instead of one long markdown message. And in between run different
commands and tools. Can you please try to execute all of the tools that you have in your arsenal, including:
- bash
- write
- diff
- patch
- edit
- remove
- launching subagents
- doing web searches
- doing web fetches
Everything that you have in your arsenal, and trying to do a real stress test of everything, because you have been
integrated inside of our app. I actually would like to validate that everything works exactly as it should and that you
are correctly integrated and that all of the tools are correctly displayed and that the combination of all of these tools
is correctly working.
Actually trying to launch subagents, monitor the subagents, ask the subagents to also execute all of these tools. In the
meantime, execute commands, launch some new subagents, execute commands again, trying to nudge the subagents and send
them new messages. Really trying to perform a real deep stress test of all of the features that you have and all of the
features that are integrated inside of your implementation, so that we can validate that everything works exactly as it
should and everything is perfectly integrated inside our app.`;

const VIEWPORTS = Object.freeze({
  desktop: { width: 1440, height: 1000 },
  mobile: { width: 390, height: 844 },
});

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;
}

function normalizePositiveInt(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.trunc(number);
}

function normalizeNonNegativeInt(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.trunc(number);
}

export function parseSyncTuningOverrideJson(rawJson) {
  const trimmed = String(rawJson ?? '').trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--sync-tuning-json must be a JSON object');
  }
  const sanitized = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
    sanitized[key] = value;
  }
  return sanitized;
}

export function buildSyncTuningOverride(options = {}) {
  return {
    ...(options.syncTuningOverrides ?? {}),
    syncPerformanceTelemetryEnabled: true,
    syncPerformanceTelemetrySlowThresholdMs: 16,
    syncPerformanceTelemetryFlushIntervalMs: normalizePositiveInt(options.flushIntervalMs, 30000),
    jsThreadLagTelemetrySampleIntervalMs: 50,
    jsThreadLagTelemetryThresholdMs: 50,
    jsThreadLagTelemetryMaxSamples: 2048,
    transcriptViewportTelemetryEnabled: true,
    transcriptViewportTelemetryMaxEvents: 2048,
  };
}

export function buildLiveTelemetryConfigureScript(options = {}) {
  const flushIntervalMs = normalizePositiveInt(options.flushIntervalMs, 30000);
  return `(() => {
    const target = window.__HAPPIER_SYNC_PERFORMANCE__;
    if (!target || typeof target.configure !== 'function') return false;
    target.configure({ enabled: true, slowThresholdMs: 16, flushIntervalMs: ${JSON.stringify(flushIntervalMs)} });
    return true;
  })()`;
}

export function buildSafeStressPrompt({ scratchDir, basePrompt = DEFAULT_STRESS_TEST_PROMPT }) {
  const safeScratchDir = String(scratchDir ?? '').trim() || '/tmp/happier-ui-perf-stress';
  return [
    'IMPORTANT SAFETY BOUNDARY FOR THIS UI PERFORMANCE STRESS TEST:',
    `- Use only this scratch directory for every file operation: ${safeScratchDir}`,
    '- Before any write/edit/patch/remove command, create that directory if needed and operate only inside it.',
    '- Do not modify, remove, patch, or overwrite repository files, user files, dotfiles, credentials, or files outside that scratch directory.',
    '- If a requested destructive operation would touch anything outside the scratch directory, simulate it inside the scratch directory instead and explain that you protected the real workspace.',
    '- Prefer harmless commands that produce visible tool activity and long markdown output.',
    '',
    basePrompt,
  ].join('\n');
}

export function buildDefaultPerfAuditPlan(options = {}) {
  const defaultDurationMs = normalizePositiveInt(options.defaultDurationMs, 20000);
  const scenario = (id, title, action, extra = {}) => ({
    id,
    title,
    action,
    durationMs: normalizePositiveInt(extra.durationMs, defaultDurationMs),
    viewport: extra.viewport ?? 'desktop',
    trace: extra.trace === true,
    profiler: extra.profiler === true,
    requiresTargetSession: extra.requiresTargetSession === true,
    requiresStressSessions: extra.requiresStressSessions === true,
    requiresColdAuth: extra.requiresColdAuth === true,
    defaultIncluded: extra.defaultIncluded !== false,
  });

  return {
    version: 1,
    generatedAt: new Date(0).toISOString(),
    scenarios: [
      scenario('desktop.sessionList.idle', 'Desktop session list idle', 'sessionListIdle', { trace: true }),
      scenario('desktop.sessionList.scroll', 'Desktop session list scroll', 'sessionListScroll', { trace: true, profiler: true }),
      scenario('desktop.sessionList.search', 'Desktop session list search/filter', 'sessionListSearch'),
      scenario('desktop.newSession.open', 'Desktop new-session screen open/idle', 'newSessionOpen', { trace: true }),
      scenario('desktop.newSession.composerTyping', 'Desktop new-session composer typing/autocomplete', 'newSessionComposerTyping', { trace: true, profiler: true }),
      scenario('desktop.sessionView.idle', 'Desktop session view idle', 'sessionViewIdle', { requiresTargetSession: true, trace: true }),
      scenario('desktop.sessionView.streamingIdle', 'Desktop session view active streaming idle', 'sessionViewStreamingIdle', { requiresTargetSession: true, trace: true, profiler: true }),
      scenario('desktop.sessionView.transcriptScroll', 'Desktop session transcript scroll', 'sessionViewTranscriptScroll', { requiresTargetSession: true, trace: true, profiler: true }),
      scenario('desktop.sessionView.tabs', 'Desktop session right-pane tab switching', 'sessionViewTabs', { requiresTargetSession: true, trace: true, profiler: true }),
      scenario('desktop.multiSessionStreaming.sidebarVisible', 'Desktop multi-session streaming with sidebar visible', 'multiSessionStreamingSidebarVisible', { requiresTargetSession: true, trace: true, profiler: true }),
      scenario('mobile.sessionList.hiddenMounted', 'Mobile session list remains mounted while hidden in a session', 'mobileHiddenSessionList', { viewport: 'mobile', requiresTargetSession: true, trace: true, profiler: true }),
      scenario('desktop.sessionList.coldAuthHydration', 'Desktop cold auth session-list hydration', 'coldAuthSessionListHydration', { trace: true, profiler: true, requiresColdAuth: true, defaultIncluded: false }),
    ],
  };
}

export function summarizeBrowserProbe(raw) {
  const startedAtMs = Number(raw?.startedAtMs ?? 0);
  const finishedAtMs = Number(raw?.finishedAtMs ?? startedAtMs);
  const longTasks = Array.isArray(raw?.longTasks) ? raw.longTasks : [];
  const frameGaps = Array.isArray(raw?.frameGaps) ? raw.frameGaps : [];
  const blockingLongTasks = longTasks
    .map((entry) => Number(entry?.duration ?? entry ?? 0))
    .filter((duration) => Number.isFinite(duration) && duration >= 50);
  const significantFrameGaps = frameGaps
    .map((entry) => Number(entry?.gapMs ?? entry ?? 0))
    .filter((gap) => Number.isFinite(gap) && gap >= 24);
  return {
    durationMs: round(Math.max(0, finishedAtMs - startedAtMs)),
    longTaskCount: blockingLongTasks.length,
    longTaskTotalMs: round(blockingLongTasks.reduce((total, duration) => total + duration, 0)),
    maxLongTaskMs: round(blockingLongTasks.reduce((max, duration) => Math.max(max, duration), 0)),
    frameGapCount: significantFrameGaps.length,
    maxFrameGapMs: round(significantFrameGaps.reduce((max, gap) => Math.max(max, gap), 0)),
  };
}

function threadKey(event) {
  return `${event?.pid ?? ''}:${event?.tid ?? ''}`;
}

function classifyThread(name) {
  const normalized = String(name ?? '').toLowerCase();
  if (normalized.includes('crrenderermain') || normalized.includes('renderer main')) return 'rendererMain';
  if (normalized.includes('compositor') && !normalized.includes('viz')) return 'compositor';
  if (normalized.includes('viz') || normalized.includes('gpu')) return 'gpuViz';
  return 'other';
}

export function isAgentBrowserCaptureAlreadyActiveError(message) {
  return /Profiling\/tracing already active/i.test(String(message ?? ''));
}

export function isAgentBrowserOperationTimeoutError(message) {
  const normalized = String(message ?? '');
  return /\b(?:operation\s+)?timed out\b/i.test(normalized);
}

export function isBrowserLocationAtTargetUrl(currentUrl, targetUrl) {
  try {
    return new URL(String(currentUrl ?? '')).href === new URL(String(targetUrl ?? '')).href;
  } catch {
    return false;
  }
}

function createChromeTraceSummaryAccumulator() {
  const threadNames = new Map();
  const byName = new Map();
  const byThread = new Map();
  let totalCompleteEventMs = 0;

  return {
    add(event) {
      if (event?.ph === 'M' && event.name === 'thread_name') {
        threadNames.set(threadKey(event), event.args?.name ?? '');
      }
      if (event?.ph !== 'X' || typeof event.dur !== 'number' || !Number.isFinite(event.dur) || event.dur <= 0) return;
      const durationMs = event.dur / 1000;
      totalCompleteEventMs += durationMs;
      const key = threadKey(event);
      byThread.set(key, (byThread.get(key) ?? 0) + durationMs);
      const name = String(event.name ?? 'unknown');
      const current = byName.get(name) ?? { name, totalMs: 0, count: 0, maxMs: 0 };
      current.totalMs += durationMs;
      current.count += 1;
      current.maxMs = Math.max(current.maxMs, durationMs);
      byName.set(name, current);
    },
    snapshot() {
      const threadGroups = { rendererMain: 0, compositor: 0, gpuViz: 0, other: 0 };
      for (const [key, durationMs] of byThread) {
        const group = classifyThread(threadNames.get(key));
        threadGroups[group] += durationMs;
      }
      return {
        totalCompleteEventMs: round(totalCompleteEventMs),
        threadGroups: Object.fromEntries(Object.entries(threadGroups).map(([key, value]) => [key, round(value)])),
        topEvents: Array.from(byName.values())
          .map((event) => ({ ...event, totalMs: round(event.totalMs), maxMs: round(event.maxMs) }))
          .sort((left, right) => right.totalMs - left.totalMs || right.maxMs - left.maxMs || left.name.localeCompare(right.name))
          .slice(0, 40),
      };
    },
  };
}

export function summarizeChromeTrace(trace) {
  const traceEvents = Array.isArray(trace?.traceEvents) ? trace.traceEvents : [];
  const accumulator = createChromeTraceSummaryAccumulator();
  for (const event of traceEvents) accumulator.add(event);
  return accumulator.snapshot();
}

export async function summarizeChromeTraceFile(tracePath, options = {}) {
  const accumulator = createChromeTraceSummaryAccumulator();
  await streamChromeTraceEvents(tracePath, (event) => accumulator.add(event), options);
  return accumulator.snapshot();
}

export function parseDevToolsActivePortFile(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const port = Number(lines[0]);
  const browserPath = lines[1] ?? '';
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || !browserPath.startsWith('/devtools/browser/')) {
    throw new Error('Invalid DevToolsActivePort file');
  }
  return { port, browserPath };
}

function normalizeUrlForComparison(value) {
  try {
    return new URL(String(value ?? '')).href;
  } catch {
    return null;
  }
}

export function selectV8ProfileCdpTarget(targets, currentUrl) {
  const pages = (Array.isArray(targets) ? targets : []).filter((target) => (
    target?.type === 'page' &&
    typeof target.webSocketDebuggerUrl === 'string' &&
    target.webSocketDebuggerUrl.length > 0
  ));
  if (pages.length === 0) return null;

  const normalizedCurrentUrl = normalizeUrlForComparison(currentUrl);
  if (normalizedCurrentUrl) {
    const exact = pages.find((target) => normalizeUrlForComparison(target.url) === normalizedCurrentUrl);
    if (exact) return exact;
  }

  return pages.find((target) => {
    const url = String(target?.url ?? '');
    return url.length > 0 && url !== 'about:blank';
  }) ?? pages[0] ?? null;
}

async function streamChromeTraceEvents(tracePath, onEvent, options = {}) {
  const stream = createReadStream(tracePath, {
    encoding: 'utf8',
    highWaterMark: normalizePositiveInt(options.highWaterMark, 1024 * 1024),
  });
  const traceEventsKey = '"traceEvents"';
  let mode = 'seekingKey';
  let searchTail = '';
  let collectingObject = false;
  let objectDepth = 0;
  let objectText = '';
  let inString = false;
  let escaped = false;

  function consumeArrayChar(char) {
    if (!collectingObject) {
      if (char === ']') {
        mode = 'done';
        return;
      }
      if (char !== '{') return;
      collectingObject = true;
      objectDepth = 1;
      objectText = '{';
      inString = false;
      escaped = false;
      return;
    }

    objectText += char;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      return;
    }

    if (char === '"') {
      inString = true;
      return;
    }
    if (char === '{') {
      objectDepth += 1;
      return;
    }
    if (char !== '}') return;

    objectDepth -= 1;
    if (objectDepth > 0) return;
    onEvent(JSON.parse(objectText));
    collectingObject = false;
    objectText = '';
  }

  for await (const chunk of stream) {
    if (mode === 'done') break;
    let text = String(chunk);
    if (mode === 'seekingKey') {
      const searchable = searchTail + text;
      const keyIndex = searchable.indexOf(traceEventsKey);
      if (keyIndex < 0) {
        searchTail = searchable.slice(-traceEventsKey.length + 1);
        continue;
      }
      text = searchable.slice(keyIndex + traceEventsKey.length);
      searchTail = '';
      mode = 'seekingArray';
    }

    for (let index = 0; index < text.length && mode !== 'done'; index += 1) {
      const char = text[index];
      if (mode === 'seekingArray') {
        if (char === '[') mode = 'array';
        continue;
      }
      if (mode === 'array') consumeArrayChar(char);
    }
  }
}

function summarizeSyncTelemetry(syncSnapshot) {
  const events = Array.isArray(syncSnapshot?.events) ? syncSnapshot.events : [];
  return events
    .map((event) => ({
      name: String(event.name ?? ''),
      count: Number(event.count ?? 0),
      totalMs: round(Number(event.totalMs ?? 0)),
      maxMs: round(Number(event.maxMs ?? 0)),
      slowCount: Number(event.slowCount ?? 0),
      fields: event.fields ?? {},
      fieldStats: event.fieldStats ?? {},
    }))
    .filter((event) => event.name)
    .sort((left, right) => right.totalMs - left.totalMs || right.count - left.count || left.name.localeCompare(right.name));
}

export function buildFallbackScenarioSnapshotScript(probeError = 'Browser perf probe snapshot was not available') {
  return `(() => {
    const errors = [];
    const readError = ${JSON.stringify(String(probeError ?? 'Browser perf probe snapshot was not available'))};
    function snapshotOrNull(read) {
      try {
        return read();
      } catch (error) {
        errors.push(String(error?.message ?? error));
        return null;
      }
    }
    function readTranscriptViewportTelemetry() {
      return snapshotOrNull(() => {
        const telemetry = window.__HAPPIER_TRANSCRIPT_VIEWPORT_EVENTS__;
        if (typeof telemetry === 'function') return telemetry();
        if (telemetry && typeof telemetry.snapshot === 'function') return telemetry.snapshot();
        return null;
      });
    }
    const perf = typeof performance === 'object' && performance ? performance : null;
    const memory = perf?.memory ? {
      usedJSHeapSize: perf.memory.usedJSHeapSize,
      totalJSHeapSize: perf.memory.totalJSHeapSize,
      jsHeapSizeLimit: perf.memory.jsHeapSizeLimit,
    } : null;
    return {
      auditProbeAvailable: false,
      auditProbeError: readError,
      startedAtMs: 0,
      finishedAtMs: typeof perf?.now === 'function' ? perf.now() : 0,
      longTasks: [],
      frameGaps: [],
      ws: null,
      memory,
      errors,
      url: typeof location === 'object' && location ? String(location.href ?? '') : '',
      syncPerformance: snapshotOrNull(() => window.__HAPPIER_SYNC_PERFORMANCE__?.snapshot?.() ?? null),
      syncReliability: snapshotOrNull(() => window.__HAPPIER_SYNC_RELIABILITY__?.snapshot?.() ?? null),
      transcriptViewport: readTranscriptViewportTelemetry(),
    };
  })()`;
}

export function buildScenarioSnapshotResult(raw) {
  const auditProbeAvailable = raw?.auditProbeAvailable !== false;
  return {
    raw,
    browserSummary: auditProbeAvailable ? summarizeBrowserProbe(raw) : null,
    syncTopEvents: summarizeSyncTelemetry(raw?.syncPerformance).slice(0, 80),
    snapshotWarning: auditProbeAvailable ? null : String(raw?.auditProbeError ?? 'Browser perf probe snapshot was not available'),
  };
}

export function resolvePerfAuditEnvironmentDefaults(env = process.env) {
  const normalize = (value) => {
    const trimmed = String(value ?? '').trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  return {
    url: normalize(env[APP_URL_ENV_NAME]),
    devKey: normalize(env[DEV_KEY_ENV_NAME]),
  };
}

export function parsePerfAuditArgs(argv, env = process.env) {
  const environmentDefaults = resolvePerfAuditEnvironmentDefaults(env);
  const args = {
    url: environmentDefaults.url,
    session: DEFAULT_AGENT_BROWSER_SESSION,
    devKey: environmentDefaults.devKey,
    outDir: null,
    durationMs: 20000,
    plan: 'full',
    printPlan: false,
    skipAuth: false,
    skipTrace: false,
    skipProfiler: false,
    v8Profile: false,
    skipTelemetryReload: false,
    keepBrowserSession: false,
    stressSessionCount: 0,
    targetSessionTitle: 'UI Perf Stress Plan',
    targetSessionUrl: null,
    directory: process.cwd(),
    stressPromptFile: null,
    syncTuningOverrides: {},
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    switch (arg) {
      case '--url': args.url = next() ?? args.url; break;
      case '--session': args.session = next() ?? args.session; break;
      case '--dev-key': args.devKey = next() ?? args.devKey; break;
      case '--out-dir': args.outDir = next() ?? args.outDir; break;
      case '--duration-ms': args.durationMs = normalizePositiveInt(next(), args.durationMs); break;
      case '--plan': args.plan = next() ?? args.plan; break;
      case '--target-session-title': args.targetSessionTitle = next() ?? args.targetSessionTitle; break;
      case '--target-session-url': args.targetSessionUrl = next() ?? args.targetSessionUrl; break;
      case '--directory': args.directory = next() ?? args.directory; break;
      case '--stress-sessions': args.stressSessionCount = normalizeNonNegativeInt(next(), args.stressSessionCount); break;
      case '--stress-prompt-file': args.stressPromptFile = next() ?? args.stressPromptFile; break;
      case '--sync-tuning-json': args.syncTuningOverrides = parseSyncTuningOverrideJson(next() ?? ''); break;
      case '--print-plan': args.printPlan = true; break;
      case '--skip-auth': args.skipAuth = true; break;
      case '--skip-trace': args.skipTrace = true; break;
      case '--skip-profiler': args.skipProfiler = true; break;
      case '--v8-profile': args.v8Profile = true; break;
      case '--skip-telemetry-reload': args.skipTelemetryReload = true; break;
      case '--keep-browser-session': args.keepBrowserSession = true; break;
      case '--dry-run': args.dryRun = true; break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

export function buildAgentBrowserPerfAuditUsage() {
  return `Usage: node apps/ui/scripts/perf/agentBrowserUiPerfAudit.mjs [options]\n\nEnvironment defaults:\n  ${APP_URL_ENV_NAME}                 Web app URL when --url is omitted\n  ${DEV_KEY_ENV_NAME}                 Dev restore key when --dev-key is omitted\n\nOptions:\n  --url <url>                         Web app URL (or ${APP_URL_ENV_NAME})\n  --session <name>                    agent-browser session name\n  --dev-key <key>                     dev restore key for login (or ${DEV_KEY_ENV_NAME})\n  --out-dir <dir>                     artifact directory\n  --duration-ms <ms>                  per-scenario duration\n  --plan <full|smoke|multi-stream|mobile-hidden|cold-hydration|scenario-id>    scenario subset\n  --target-session-title <title>      session title to open for session-view scenarios\n  --target-session-url <url>          direct /session/... URL for session-view scenarios\n  --directory <path>                  directory seed for /new stress sessions (default: current working directory)\n  --stress-sessions <n>               create n safe long-running stress sessions before measurement\n  --stress-prompt-file <path>         custom base stress prompt\n  --sync-tuning-json <json>           merge extra HAPPIER_SYNC_TUNING_JSON keys for perf experiments\n  --skip-auth                         assume already logged in\n  --skip-trace                        do not capture Chrome traces\n  --skip-profiler                     do not capture CPU profiles\n  --v8-profile                        capture valid direct-CDP V8 CPU profiles instead of agent-browser profiler output\n  --skip-telemetry-reload             keep an already-configured warm app instead of reloading telemetry setup\n  --keep-browser-session              leave this script-owned agent-browser session open for explicit warm reuse\n  --print-plan                        print plan JSON and exit\n  --dry-run                           write plan only, no browser work\n`;
}

function usage() {
  return buildAgentBrowserPerfAuditUsage();
}

export function validatePerfAuditRuntimeArgs(args, plan) {
  const url = String(args?.url ?? '').trim();
  if (!url) {
    throw new Error(`Missing perf app URL: pass --url or set ${APP_URL_ENV_NAME}`);
  }
  const scenarios = Array.isArray(plan?.scenarios) ? plan.scenarios : [];
  const needsDevKey = args?.skipAuth !== true || scenarios.some((scenario) => scenario?.requiresColdAuth === true);
  if (needsDevKey && !String(args?.devKey ?? '').trim()) {
    throw new Error(`Missing perf dev restore key: pass --dev-key or set ${DEV_KEY_ENV_NAME}`);
  }
}

export function resolveScenarioExecutionPhases(action) {
  switch (action) {
    case 'sessionListIdle':
      return { prepare: 'root', measure: 'idle' };
    case 'sessionListScroll':
      return { prepare: 'root', measure: 'scroll' };
    case 'sessionListSearch':
      return { prepare: 'root', measure: 'search' };
    case 'newSessionOpen':
      return { prepare: 'newSession', measure: 'idle' };
    case 'newSessionComposerTyping':
      return { prepare: 'newSession', measure: 'composerTyping' };
    case 'sessionViewIdle':
    case 'sessionViewStreamingIdle':
    case 'multiSessionStreamingSidebarVisible':
      return { prepare: 'targetSession', measure: 'idle' };
    case 'sessionViewTranscriptScroll':
      return { prepare: 'targetSession', measure: 'scroll' };
    case 'sessionViewTabs':
      return { prepare: 'targetSession', measure: 'tabs' };
    case 'mobileHiddenSessionList':
      return { prepare: 'mobileTargetSession', measure: 'idle' };
    case 'coldAuthSessionListHydration':
      return { prepare: 'none', measure: 'coldAuthHydration' };
    default:
      throw new Error(`Unhandled scenario action: ${action}`);
  }
}

export function selectPlanScenarios(plan, subset) {
  const exactScenario = plan.scenarios.find((scenario) => scenario.id === subset);
  if (exactScenario) return { ...plan, scenarios: [exactScenario] };

  if (subset === 'full') {
    return { ...plan, scenarios: plan.scenarios.filter((scenario) => scenario.defaultIncluded !== false) };
  }
  if (subset === 'smoke') {
    const ids = new Set([
      'desktop.sessionList.idle',
      'desktop.sessionList.scroll',
      'desktop.sessionView.idle',
      'desktop.sessionView.transcriptScroll',
    ]);
    return { ...plan, scenarios: plan.scenarios.filter((scenario) => ids.has(scenario.id)) };
  }
  if (subset === 'multi-stream') {
    const ids = new Set([
      'desktop.sessionView.idle',
      'desktop.sessionView.streamingIdle',
      'desktop.multiSessionStreaming.sidebarVisible',
    ]);
    return { ...plan, scenarios: plan.scenarios.filter((scenario) => ids.has(scenario.id)) };
  }
  if (subset === 'mobile-hidden') {
    const ids = new Set(['mobile.sessionList.hiddenMounted']);
    return { ...plan, scenarios: plan.scenarios.filter((scenario) => ids.has(scenario.id)) };
  }
  if (subset === 'cold-hydration') {
    const ids = new Set(['desktop.sessionList.coldAuthHydration']);
    return { ...plan, scenarios: plan.scenarios.filter((scenario) => ids.has(scenario.id)) };
  }
  return { ...plan, scenarios: plan.scenarios.filter((scenario) => scenario.defaultIncluded !== false) };
}

function buildArtifactDir(outDir) {
  if (outDir) return resolve(outDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(homedir(), '.happier', 'perf-audits', 'remote-dev-ui', stamp);
}

function agentBrowserArgs(session, args) {
  return ['--session', session, ...args];
}

async function execAgentBrowser(session, args, options = {}) {
  const commandArgs = agentBrowserArgs(session, args);
  const timeout = options.timeout ?? 120000;
  return await new Promise((resolvePromise, rejectPromise) => {
    execFile('agent-browser', commandArgs, {
      timeout,
      maxBuffer: 30 * 1024 * 1024,
      env: {
        ...process.env,
        AGENT_BROWSER_DEFAULT_TIMEOUT: String(Math.max(25000, timeout - 5000)),
      },
    }, (error, stdout, stderr) => {
      if (error) {
        const message = [
          `agent-browser ${commandArgs.join(' ')} failed`,
          stdout?.trim(),
          stderr?.trim(),
          error.message,
        ].filter(Boolean).join('\n');
        rejectPromise(new Error(message));
        return;
      }
      if (options.parseJson === false) {
        resolvePromise({ stdout, stderr });
        return;
      }
      const trimmed = stdout.trim();
      if (!trimmed) {
        resolvePromise(null);
        return;
      }
      try {
        resolvePromise(JSON.parse(trimmed));
      } catch {
        resolvePromise({ stdout, stderr });
      }
    });
  });
}

async function browserJson(session, args, options) {
  return execAgentBrowser(session, [...args, '--json'], options);
}

async function stopActiveBrowserCaptures(ctx, label) {
  const safeLabel = String(label ?? 'capture').replace(/[^a-z0-9_.-]+/gi, '_');
  const profilePath = join(ctx.outDir, `${safeLabel}.recovered.cpuprofile`);
  const tracePath = join(ctx.outDir, `${safeLabel}.recovered.trace.json`);
  await execAgentBrowser(ctx.session, ['profiler', 'stop', profilePath], { parseJson: false, timeout: 30000 }).catch(() => null);
  await execAgentBrowser(ctx.session, ['trace', 'stop', tracePath], { parseJson: false, timeout: 30000 }).catch(() => null);
}

function execFileText(file, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(file, args, { timeout: options.timeout ?? 10000 }, (error, stdout, stderr) => {
      if (error) {
        const message = [stderr?.trim(), error.message].filter(Boolean).join('\n');
        rejectPromise(new Error(message));
        return;
      }
      resolvePromise(String(stdout ?? ''));
    });
  });
}

function parseChromeUserDataDirFromCommand(command) {
  const text = String(command ?? '');
  const equalsMatch = text.match(/(?:^|\s)--user-data-dir=(?:"([^"]+)"|'([^']+)'|(\S+))/);
  if (equalsMatch) return equalsMatch[1] ?? equalsMatch[2] ?? equalsMatch[3] ?? null;
  const parts = text.split(/\s+/).filter(Boolean);
  const index = parts.indexOf('--user-data-dir');
  if (index >= 0 && parts[index + 1]) return parts[index + 1];
  return null;
}

async function readProcessCommand(pid) {
  const trimmed = String(pid ?? '').trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const output = await execFileText('ps', ['-p', trimmed, '-o', 'command='], { timeout: 10000 }).catch(() => '');
  const command = output.trim();
  return command.length > 0 ? command : null;
}

async function listChildPids(pid) {
  const trimmed = String(pid ?? '').trim();
  if (!/^\d+$/.test(trimmed)) return [];
  const output = await execFileText('pgrep', ['-P', trimmed], { timeout: 10000 }).catch(() => '');
  return output.split(/\s+/).map((entry) => entry.trim()).filter((entry) => /^\d+$/.test(entry));
}

async function resolveAgentBrowserChromeUserDataDir(session) {
  const pidPath = join(homedir(), '.agent-browser', `${session}.pid`);
  const agentPid = (await readFile(pidPath, 'utf8')).trim();
  const candidates = [agentPid, ...await listChildPids(agentPid)];
  for (const pid of candidates) {
    const command = await readProcessCommand(pid);
    const userDataDir = parseChromeUserDataDirFromCommand(command);
    if (userDataDir) return userDataDir;
  }
  throw new Error(`Could not resolve Chrome user-data-dir for agent-browser session ${session}`);
}

async function resolveAgentBrowserDevToolsEndpoint(session) {
  const userDataDir = await resolveAgentBrowserChromeUserDataDir(session);
  const activePort = parseDevToolsActivePortFile(await readFile(join(userDataDir, 'DevToolsActivePort'), 'utf8'));
  return { ...activePort, userDataDir };
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeout ?? 10000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

async function createCdpConnection(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  let closed = false;

  const rejectAll = (error) => {
    closed = true;
    for (const { reject, timeoutId } of pending.values()) {
      clearTimeout(timeoutId);
      reject(error);
    }
    pending.clear();
  };

  await new Promise((resolvePromise, rejectPromise) => {
    const timeoutId = setTimeout(() => {
      rejectPromise(new Error('Timed out connecting to CDP target'));
      try { ws.close(); } catch {}
    }, 10000);
    ws.addEventListener('open', () => {
      clearTimeout(timeoutId);
      resolvePromise();
    }, { once: true });
    ws.addEventListener('error', () => {
      clearTimeout(timeoutId);
      rejectPromise(new Error('CDP WebSocket connection failed'));
    }, { once: true });
  });

  ws.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (typeof message?.id !== 'number') return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timeoutId);
    if (message.error) {
      entry.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      return;
    }
    entry.resolve(message.result ?? null);
  });
  ws.addEventListener('close', () => rejectAll(new Error('CDP WebSocket closed')));
  ws.addEventListener('error', () => rejectAll(new Error('CDP WebSocket error')));

  return {
    send(method, params = {}, options = {}) {
      if (closed) return Promise.reject(new Error('CDP WebSocket is closed'));
      const id = nextId++;
      return new Promise((resolvePromise, rejectPromise) => {
        const timeoutId = setTimeout(() => {
          pending.delete(id);
          rejectPromise(new Error(`Timed out waiting for CDP method ${method}`));
        }, options.timeout ?? 30000);
        pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timeoutId });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      closed = true;
      for (const { reject, timeoutId } of pending.values()) {
        clearTimeout(timeoutId);
        reject(new Error('CDP WebSocket closed'));
      }
      pending.clear();
      try { ws.close(); } catch {}
    },
  };
}

async function startV8CpuProfile(ctx, profilePath) {
  const currentUrl = await browserEval(ctx.session, 'globalThis.location?.href ?? ""', { timeout: 10000 }).catch(() => null);
  const endpoint = await resolveAgentBrowserDevToolsEndpoint(ctx.session);
  const targets = await fetchJson(`http://127.0.0.1:${endpoint.port}/json/list`, { timeout: 10000 });
  const target = selectV8ProfileCdpTarget(targets, currentUrl);
  if (!target?.webSocketDebuggerUrl) throw new Error('Could not find a page CDP target for V8 profiling');

  const cdp = await createCdpConnection(target.webSocketDebuggerUrl);
  let stopped = false;
  try {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 1000 }).catch(() => null);
    await cdp.send('Profiler.start');
  } catch (error) {
    cdp.close();
    throw error;
  }

  return {
    targetUrl: target.url ?? null,
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        const result = await cdp.send('Profiler.stop', {}, { timeout: 60000 });
        if (!result?.profile) throw new Error('CDP Profiler.stop did not return a profile');
        await writeJson(profilePath, result.profile);
      } finally {
        await cdp.send('Profiler.disable').catch(() => null);
        cdp.close();
      }
    },
  };
}

async function startBrowserCapture(ctx, kind) {
  try {
    await execAgentBrowser(ctx.session, [kind, 'start'], { parseJson: false, timeout: 30000 });
  } catch (error) {
    if (!isAgentBrowserCaptureAlreadyActiveError(error?.message)) throw error;
    await stopActiveBrowserCaptures(ctx, `${kind}-preexisting`);
    await execAgentBrowser(ctx.session, [kind, 'start'], { parseJson: false, timeout: 30000 });
  }
}

async function browserEval(session, js, options) {
  const response = await browserJson(session, ['eval', js], options);
  if (response?.success === false) throw new Error(response.error ?? 'browser eval failed');
  return response?.data?.result;
}

async function openUrl(ctx, url, options = {}) {
  try {
    await browserJson(ctx.session, ['open', url], { timeout: options.timeout ?? 90000 });
  } catch (error) {
    if (!isAgentBrowserOperationTimeoutError(error?.message)) throw error;
    await waitMs(ctx.session, options.timeoutSettleMs ?? 1500).catch(() => null);
    let currentUrl;
    try {
      currentUrl = await browserEval(ctx.session, 'globalThis.location?.href ?? ""', { timeout: options.validationTimeout ?? 10000 });
    } catch (validationError) {
      throw new Error(
        `agent-browser open timed out and navigation state could not be validated: ${validationError?.message ?? validationError}`,
        { cause: error },
      );
    }
    if (!isBrowserLocationAtTargetUrl(currentUrl, url)) {
      throw new Error(
        `agent-browser open timed out before reaching target URL: expected ${url}, current ${currentUrl || 'unknown'}`,
        { cause: error },
      );
    }
  }
}

export function buildAgentBrowserWaitTimeoutMs(ms) {
  return normalizeNonNegativeInt(ms, 0) + 60000;
}

async function waitMs(session, ms) {
  await browserJson(session, ['wait', String(ms)], { timeout: buildAgentBrowserWaitTimeoutMs(ms) });
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function buildInstallProbeScript() {
  return `(() => {
    const globalKey = ${JSON.stringify(AUDIT_GLOBAL)};
    const previous = window[globalKey];
    if (previous && typeof previous.disconnect === 'function') previous.disconnect();
    const createWsState = () => ({ messageCount: 0, totalBytes: 0, byType: {}, byUpdateType: {} });
    const state = {
      startedAtMs: performance.now(),
      finishedAtMs: null,
      longTasks: [],
      frameGaps: [],
      ws: createWsState(),
      errors: [],
      rafActive: true,
      lastFrameAtMs: performance.now(),
      observers: [],
      originalWebSocket: window.WebSocket,
    };
    const resetMeasurement = () => {
      const now = performance.now();
      state.startedAtMs = now;
      state.finishedAtMs = null;
      state.longTasks = [];
      state.frameGaps = [];
      state.ws = createWsState();
      state.lastFrameAtMs = now;
    };
    const safeNumber = (value) => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.startTime < state.startedAtMs) continue;
          state.longTasks.push({
            name: entry.name,
            startTime: safeNumber(entry.startTime),
            duration: safeNumber(entry.duration),
          });
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
      state.observers.push(observer);
    } catch {}
    function frameLoop(now) {
      if (!state.rafActive) return;
      const gap = now - state.lastFrameAtMs;
      if (gap >= 24) state.frameGaps.push(safeNumber(gap));
      state.lastFrameAtMs = now;
      requestAnimationFrame(frameLoop);
    }
    requestAnimationFrame(frameLoop);
    function readUpdateType(payload) {
      try {
        const parsed = typeof payload === 'string' ? JSON.parse(payload) : null;
        const body = parsed && typeof parsed === 'object' ? (parsed.body ?? parsed[1]?.body ?? parsed[0]?.body) : null;
        const updateType = body?.updateType ?? body?.type ?? parsed?.updateType ?? parsed?.type;
        return typeof updateType === 'string' ? updateType : 'unknown';
      } catch {
        return 'unknown';
      }
    }
    function readTranscriptViewportTelemetry() {
      try {
        const telemetry = window.__HAPPIER_TRANSCRIPT_VIEWPORT_EVENTS__;
        if (typeof telemetry === 'function') return telemetry();
        if (telemetry && typeof telemetry.snapshot === 'function') return telemetry.snapshot();
      } catch (error) {
        state.errors.push(String(error?.message ?? error));
      }
      return null;
    }
    try {
      const NativeWebSocket = window.WebSocket;
      if (typeof NativeWebSocket === 'function') {
        function AuditedWebSocket(...args) {
          const socket = new NativeWebSocket(...args);
          socket.addEventListener('message', (event) => {
            const data = event.data;
            const bytes = typeof data === 'string' ? data.length : (data?.byteLength ?? 0);
            const updateType = readUpdateType(data);
            state.ws.messageCount += 1;
            state.ws.totalBytes += bytes;
            state.ws.byUpdateType[updateType] = (state.ws.byUpdateType[updateType] || 0) + 1;
          });
          return socket;
        }
        AuditedWebSocket.prototype = NativeWebSocket.prototype;
        AuditedWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
        AuditedWebSocket.OPEN = NativeWebSocket.OPEN;
        AuditedWebSocket.CLOSING = NativeWebSocket.CLOSING;
        AuditedWebSocket.CLOSED = NativeWebSocket.CLOSED;
        window.WebSocket = AuditedWebSocket;
      }
    } catch (error) {
      state.errors.push(String(error?.message ?? error));
    }
    window[globalKey] = {
      reset: resetMeasurement,
      snapshot() {
        state.finishedAtMs = performance.now();
        const memory = performance.memory ? {
          usedJSHeapSize: performance.memory.usedJSHeapSize,
          totalJSHeapSize: performance.memory.totalJSHeapSize,
          jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
        } : null;
        return {
          startedAtMs: state.startedAtMs,
          finishedAtMs: state.finishedAtMs,
          longTasks: state.longTasks.slice(),
          frameGaps: state.frameGaps.slice(),
          ws: JSON.parse(JSON.stringify(state.ws)),
          memory,
          errors: state.errors.slice(),
          url: location.href,
          syncPerformance: window.__HAPPIER_SYNC_PERFORMANCE__?.snapshot?.() ?? null,
          syncReliability: window.__HAPPIER_SYNC_RELIABILITY__?.snapshot?.() ?? null,
          transcriptViewport: readTranscriptViewportTelemetry(),
        };
      },
      disconnect() {
        state.rafActive = false;
        for (const observer of state.observers) {
          try { observer.disconnect(); } catch {}
        }
        try { window.WebSocket = state.originalWebSocket; } catch {}
      },
    };
    return true;
  })()`;
}

export function buildTranscriptScrollerReadyScript() {
  return `(() => {
    const target = document.querySelector('[data-testid="transcript-chat-list"], [data-test-id="transcript-chat-list"], [testID="transcript-chat-list"]');
    const targetTestId = String(
      target?.getAttribute?.('data-testid')
      || target?.getAttribute?.('data-test-id')
      || target?.getAttribute?.('testID')
      || ''
    );
    const scrollHeight = target?.scrollHeight || 0;
    const clientHeight = target?.clientHeight || 0;
    return {
      ready: targetTestId === 'transcript-chat-list' && scrollHeight > clientHeight + 80,
      targetTestId,
      scrollHeight,
      clientHeight,
    };
  })()`;
}

export function shouldWaitForTranscriptScrollerBeforeMeasurement(scenario) {
  return scenario?.action === 'sessionViewTranscriptScroll';
}

export function buildScrollKickoffScript(durationMs) {
  const duration = normalizePositiveInt(durationMs, 8000);
  return `(() => {
    const globalKey = ${JSON.stringify(SCROLL_GLOBAL)};
    const previous = window[globalKey];
    if (previous && typeof previous.cancel === 'function') previous.cancel();
    const preferredTranscriptTestIds = new Set([
      'transcript-chat-list',
      'transcript-web-hot-tail',
    ]);
    const readTestId = (el) => {
      const direct = String(
        el?.getAttribute?.('data-testid')
        || el?.getAttribute?.('data-test-id')
        || el?.getAttribute?.('testID')
        || ''
      );
      if (direct) return direct;
      return el?.closest?.('[data-testid="sessions-list-keyboard-zone"]') ? 'session-list' : '';
    };
    const candidateScore = (el) => {
      const area = (el.clientHeight || 0) * (el.clientWidth || 0);
      const testId = readTestId(el);
      const preferred = preferredTranscriptTestIds.has(testId) || testId.startsWith('transcript-chat-list') ? 1 : 0;
      return { area, preferred };
    };
    const candidates = [document.scrollingElement, ...document.querySelectorAll('*')]
      .filter(Boolean)
      .filter((el, index, all) => all.indexOf(el) === index)
      .filter((el) => {
        const rect = el.getBoundingClientRect?.();
        if (!rect || rect.width < 80 || rect.height < 80) return false;
        return (el.scrollHeight || 0) > (el.clientHeight || 0) + 80;
      })
      .sort((a, b) => {
        const left = candidateScore(a);
        const right = candidateScore(b);
        if (left.preferred !== right.preferred) return right.preferred - left.preferred;
        return right.area - left.area;
      });
    const target = candidates[0] || document.scrollingElement || document.body;
    if (!target || typeof requestAnimationFrame !== 'function') {
      return { started: false, reason: 'noScrollTarget' };
    }
    const targetTestId = readTestId(target);
    const startedAtMs = performance.now();
    const state = {
      startedAtMs,
      targetTestId,
      durationMs: ${duration},
      frames: 0,
      scrollTop: target.scrollTop || 0,
      done: false,
      cancelled: false,
      rafId: null,
      cancel() {
        this.cancelled = true;
        this.done = true;
        if (this.rafId !== null && typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(this.rafId);
        }
      },
    };
    window[globalKey] = state;
    let direction = 1;
    function step(now) {
      if (state.cancelled) return;
      const elapsed = now - startedAtMs;
      state.frames += 1;
      target.scrollTop += direction * 48;
      if (target.scrollTop <= 0) direction = 1;
      if (target.scrollTop + target.clientHeight >= target.scrollHeight - 2) direction = -1;
      state.scrollTop = target.scrollTop || 0;
      if (elapsed >= state.durationMs) {
        state.done = true;
        state.finishedAtMs = now;
        return;
      }
      state.rafId = requestAnimationFrame(step);
    }
    state.rafId = requestAnimationFrame(step);
    return {
      started: true,
      durationMs: state.durationMs,
      scrollTop: state.scrollTop,
      scrollHeight: target.scrollHeight || 0,
      clientHeight: target.clientHeight || 0,
      clientWidth: target.clientWidth || 0,
      targetTestId,
    };
  })()`;
}

export function buildClearBrowserStorageScript(options = {}) {
  const preserveLocalStorageKeys = Array.isArray(options.preserveLocalStorageKeys)
    ? options.preserveLocalStorageKeys.map((key) => String(key)).filter(Boolean)
    : [];
  return `(async () => {
    const preserveLocalStorageKeys = ${JSON.stringify(preserveLocalStorageKeys)};
    const result = {
      localStorageCleared: false,
      sessionStorageCleared: false,
      deletedCaches: 0,
      deletedDatabases: 0,
      blockedDatabases: 0,
      serviceWorkersUnregistered: 0,
      errors: [],
    };
    const recordError = (scope, error) => {
      result.errors.push({ scope, message: String(error?.message ?? error) });
    };
    try {
      const preserved = new Map();
      for (const key of preserveLocalStorageKeys) {
        const value = localStorage.getItem(key);
        if (value !== null) preserved.set(key, value);
      }
      localStorage.clear();
      for (const [key, value] of preserved) localStorage.setItem(key, value);
      result.localStorageCleared = true;
    } catch (error) {
      recordError('localStorage', error);
    }
    try {
      sessionStorage.clear();
      result.sessionStorageCleared = true;
    } catch (error) {
      recordError('sessionStorage', error);
    }
    try {
      if (typeof caches !== 'undefined' && typeof caches.keys === 'function') {
        const cacheKeys = await caches.keys();
        await Promise.all(cacheKeys.map(async (key) => {
          try {
            if (await caches.delete(key)) result.deletedCaches += 1;
          } catch (error) {
            recordError('cache:' + key, error);
          }
        }));
      }
    } catch (error) {
      recordError('caches', error);
    }
    try {
      if (typeof navigator !== 'undefined' && navigator.serviceWorker?.getRegistrations) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map(async (registration, index) => {
          try {
            if (await registration.unregister()) result.serviceWorkersUnregistered += 1;
          } catch (error) {
            recordError('serviceWorker:' + index, error);
          }
        }));
      }
    } catch (error) {
      recordError('serviceWorkers', error);
    }
    try {
      if (typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function') {
        const databases = await indexedDB.databases();
        for (const database of databases) {
          const name = typeof database?.name === 'string' ? database.name : '';
          if (!name) continue;
          await new Promise((resolve) => {
            let settled = false;
            const settle = (deleted) => {
              if (settled) return;
              settled = true;
              clearTimeout(timeoutId);
              if (deleted) result.deletedDatabases += 1;
              resolve(undefined);
            };
            const timeoutId = setTimeout(() => settle(false), 1500);
            try {
              const request = indexedDB.deleteDatabase(name);
              request.onsuccess = () => settle(true);
              request.onerror = () => {
                recordError('indexedDB:' + name, request.error ?? 'delete failed');
                settle(false);
              };
              request.onblocked = () => {
                result.blockedDatabases += 1;
              };
            } catch (error) {
              recordError('indexedDB:' + name, error);
              settle(false);
            }
          });
        }
      }
    } catch (error) {
      recordError('indexedDB', error);
    }
    return result;
  })()`;
}

function buildScrollStopScript() {
  return `(() => {
    const state = window[${JSON.stringify(SCROLL_GLOBAL)}];
    if (!state) return null;
    if (typeof state.cancel === 'function') state.cancel();
    return {
      done: state.done === true,
      cancelled: state.cancelled === true,
      frames: state.frames || 0,
      scrollTop: state.scrollTop || 0,
    };
  })()`;
}

export function buildSetFirstVisibleTextboxValueScript(text) {
  const value = String(text ?? '');
  return `(() => {
    const value = ${JSON.stringify(value)};
    const candidates = Array.from(document.querySelectorAll('textarea,input,[contenteditable="true"],[role="textbox"]'));
    const target = candidates.find((el) => {
      const rect = el.getBoundingClientRect?.();
      if (!rect || rect.height <= 10) return false;
      const accessibleName = String(el.getAttribute?.('aria-label') || el.getAttribute?.('placeholder') || '').trim();
      if (rect.width <= 20 && accessibleName.length === 0) return false;
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
      return style?.visibility !== 'hidden' && style?.display !== 'none';
    });
    if (!target) return { ok: false, reason: 'noVisibleTextbox' };
    target.focus?.();
    if ('value' in target) {
      const prototype = Object.getPrototypeOf(target);
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
        || (typeof HTMLTextAreaElement !== 'undefined' ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value') : undefined)
        || (typeof HTMLInputElement !== 'undefined' ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value') : undefined);
      if (descriptor && typeof descriptor.set === 'function') {
        descriptor.set.call(target, value);
      } else {
        target.value = value;
      }
      if ('selectionStart' in target) target.selectionStart = value.length;
      if ('selectionEnd' in target) target.selectionEnd = value.length;
    } else if (target.isContentEditable) {
      target.textContent = value;
    } else {
      return { ok: false, reason: 'unsupportedTextbox' };
    }
    const inputEvent = typeof InputEvent === 'function'
      ? new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })
      : new Event('input', { bubbles: true });
    target.dispatchEvent(inputEvent);
    target.dispatchEvent(new Event('change', { bubbles: true }));
    const length = 'value' in target ? String(target.value ?? '').length : String(target.textContent ?? '').length;
    return { ok: true, length };
  })()`;
}

export function buildClickVisibleControlByNameScript(text) {
  const desired = String(text ?? '').trim().replace(/\s+/g, ' ');
  return `(() => {
    const desired = ${JSON.stringify(desired)};
    function readableText(el) {
      return String(
        el.getAttribute?.('aria-label')
        || el.getAttribute?.('title')
        || el.innerText
        || el.textContent
        || ''
      ).trim().replace(/\\s+/g, ' ');
    }
    function isVisible(el) {
      const rect = el.getBoundingClientRect?.();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    }
    const candidates = Array.from(document.querySelectorAll('button,[role="button"],a,[aria-label],[title],[tabindex],div,span'))
      .map((el) => ({ el, name: readableText(el) }))
      .filter((entry) => entry.name === desired && isVisible(entry.el));
    const target = candidates[0]?.el;
    if (!target) return false;
    target.click?.();
    return true;
  })()`;
}

async function writeTelemetryTuningOverride(ctx, options = {}) {
  await browserEval(ctx.session, `localStorage.setItem(${JSON.stringify(SYNC_TUNING_STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(buildSyncTuningOverride({
    ...options,
    syncTuningOverrides: ctx.syncTuningOverrides,
  })))}); true;`);
}

async function configureTelemetryAndReload(ctx) {
  await openUrl(ctx, ctx.url, { timeout: 90000 });
  await writeTelemetryTuningOverride(ctx);
  await browserJson(ctx.session, ['reload'], { timeout: 90000 });
  await waitMs(ctx.session, 3000);
  await waitForAuthenticatedRoot(ctx);
}

async function configureLiveTelemetry(ctx) {
  await browserEval(ctx.session, buildLiveTelemetryConfigureScript({ flushIntervalMs: 30000 }), { timeout: 30000 }).catch(() => false);
}

async function cleanupTelemetry(ctx) {
  try {
    await browserEval(ctx.session, `localStorage.removeItem(${JSON.stringify(SYNC_TUNING_STORAGE_KEY)}); window.${AUDIT_GLOBAL}?.disconnect?.(); true;`, { timeout: 30000 });
  } catch {}
}

export function shouldCloseAgentBrowserSession(args) {
  return args?.keepBrowserSession !== true;
}

async function closeAgentBrowserSession(ctx) {
  if (!shouldCloseAgentBrowserSession(ctx)) return;
  await execAgentBrowser(ctx.session, ['close'], { parseJson: false, timeout: 30000 }).catch((error) => {
    ctx.browserSessionCloseError = error instanceof Error ? error.message : String(error);
  });
}

function refByRoleName(snapshotResponse, role, namePattern) {
  const refs = snapshotResponse?.data?.refs ?? {};
  for (const [ref, meta] of Object.entries(refs)) {
    if (meta?.role !== role) continue;
    if (!namePattern.test(String(meta?.name ?? ''))) continue;
    return `@${ref}`;
  }
  return null;
}

export function isSessionViewUrl(currentUrl) {
  try {
    const pathParts = new URL(String(currentUrl ?? '')).pathname.split('/').filter(Boolean);
    return pathParts[0] === 'session' && typeof pathParts[1] === 'string' && pathParts[1].length > 0;
  } catch {
    return false;
  }
}

export function buildTargetSessionUrl(baseUrl, targetSessionUrl) {
  const trimmed = String(targetSessionUrl ?? '').trim();
  if (!trimmed) return null;
  const url = new URL(trimmed, baseUrl);
  if (!isSessionViewUrl(url.href)) {
    throw new Error('--target-session-url must point at a concrete /session/... route');
  }
  url.searchParams.set('happier_hmr', '0');
  return url.href;
}

function normalizeSessionUrlForWarmReuse(value) {
  try {
    const url = new URL(String(value ?? ''));
    url.hash = '';
    url.searchParams.delete('happier_hmr');
    url.searchParams.sort();
    return url.href;
  } catch {
    return null;
  }
}

export function shouldOpenTargetSessionUrl(currentUrl, targetSessionUrl) {
  if (isBrowserLocationAtTargetUrl(currentUrl, targetSessionUrl)) return false;
  const current = normalizeSessionUrlForWarmReuse(currentUrl);
  const target = normalizeSessionUrlForWarmReuse(targetSessionUrl);
  return !current || !target || current !== target;
}

export function resolveAuthenticationSurfaceFromSnapshot(snapshotResponse) {
  const text = String(snapshotResponse?.data?.snapshot ?? '');
  const textboxRef = refByRoleName(snapshotResponse, 'textbox', /XXXXX|secret|key|restore/i);
  const restoreAccountRef = refByRoleName(snapshotResponse, 'button', /Restore Account/i);
  if (textboxRef && restoreAccountRef) {
    return { state: 'restore', textboxRef, restoreAccountRef };
  }

  const loginRef = refByRoleName(snapshotResponse, 'button', /Login/i);
  const restoreRef = refByRoleName(snapshotResponse, 'button', /Restore with Secret Key/i);
  if (restoreRef) return { state: 'restoreDisclosure', restoreRef };
  if (loginRef) return { state: 'login', loginRef };

  const refs = Object.values(snapshotResponse?.data?.refs ?? {});
  const hasSessionScopeTabs = refs.some((meta) => meta?.role === 'tab' && /^Happier$/i.test(String(meta?.name ?? '').trim()))
    && refs.some((meta) => meta?.role === 'tab' && /^Direct$/i.test(String(meta?.name ?? '').trim()));
  const hasRelayControl = refs.some((meta) => meta?.role === 'button' && /localhost:\d+|https?:\/\//i.test(String(meta?.name ?? '')));
  if (/Search sessions|Start New Session|Sessions/.test(text) || (hasSessionScopeTabs && hasRelayControl)) {
    return { state: 'authenticated' };
  }

  return { state: 'pending' };
}

async function waitForAuthenticatedRoot(ctx, timeoutMs = 45000) {
  const startedAt = Date.now();
  let lastState = null;
  let lastSnapshotText = '';
  while (Date.now() - startedAt <= timeoutMs) {
    const snapshot = await browserJson(ctx.session, ['snapshot', '-i'], { timeout: 90000 });
    lastSnapshotText = String(snapshot?.data?.snapshot ?? '').slice(0, 500);
    lastState = resolveAuthenticationSurfaceFromSnapshot(snapshot);
    if (lastState.state === 'authenticated') return;
    await waitMs(ctx.session, 1000);
  }
  throw new Error(`Authentication did not reach the authenticated session list; last state: ${lastState?.state ?? 'unknown'}; snapshot: ${lastSnapshotText}`);
}

export function chooseLaunchSessionButtonRef(snapshotResponse) {
  const refs = Object.entries(snapshotResponse?.data?.refs ?? {})
    .filter(([, meta]) => meta?.role === 'button')
    .map(([ref, meta]) => ({ ref: `@${ref}`, name: String(meta?.name ?? '').trim() }))
    .filter((entry) => entry.name.length > 0);

  const preferred = refs.find((entry) => /^(Start|Resume)\s+.+\s+session$/i.test(entry.name)
    && !/^Start New Session$/i.test(entry.name));
  if (preferred) return preferred.ref;

  const snapshotText = String(snapshotResponse?.data?.snapshot ?? '');
  if (/\b(Start|Resume)\s+.+\s+session\b/i.test(snapshotText.replace(/^.*Start New Session.*$/im, ''))) {
    return null;
  }

  const fallback = refs.find((entry) => /^Start New Session$/i.test(entry.name));
  return fallback?.ref ?? null;
}

async function openAuthenticationSurface(ctx, options = {}) {
  if (options.open !== false) {
    await openUrl(ctx, ctx.url, { timeout: 90000 });
  }

  const startedAt = Date.now();
  let lastState = null;
  while (Date.now() - startedAt <= 30000) {
    await waitMs(ctx.session, 500);
    const snapshot = await browserJson(ctx.session, ['snapshot', '-i'], { timeout: 90000 });
    const surface = resolveAuthenticationSurfaceFromSnapshot(snapshot);
    lastState = surface.state;
    if (surface.state === 'authenticated') return { alreadyAuthenticated: true };
    if (surface.state === 'restore') {
      return {
        alreadyAuthenticated: false,
        textboxRef: surface.textboxRef,
        restoreAccountRef: surface.restoreAccountRef,
      };
    }
    if (surface.state === 'login') {
      await browserJson(ctx.session, ['click', surface.loginRef], { timeout: 30000 });
      continue;
    }
    if (surface.state === 'restoreDisclosure') {
      await browserJson(ctx.session, ['click', surface.restoreRef], { timeout: 30000 });
      continue;
    }
  }

  throw new Error(`Could not find dev-key restore controls in the UI; last auth surface state: ${lastState ?? 'unknown'}`);
}

async function submitDevKeyRestore(ctx, authSurface) {
  if (authSurface.alreadyAuthenticated) return;
  await browserJson(ctx.session, ['fill', authSurface.textboxRef, ctx.devKey], { timeout: 30000 });
  await browserJson(ctx.session, ['click', authSurface.restoreAccountRef], { timeout: 30000 });
  await waitForAuthenticatedRoot(ctx);
}

async function ensureAuthenticated(ctx, options = {}) {
  const authSurface = await openAuthenticationSurface(ctx, options);
  await submitDevKeyRestore(ctx, authSurface);
}

export function resolvePreparationOpenRootViewport({ prepare, scenarioViewport }) {
  if (prepare === 'mobileTargetSession') return 'mobile';
  return scenarioViewport === 'mobile' ? 'mobile' : 'desktop';
}

async function openRoot(ctx, viewport = 'desktop') {
  const viewportSize = VIEWPORTS[viewport] ?? VIEWPORTS.desktop;
  await browserJson(ctx.session, ['set', 'viewport', String(viewportSize.width), String(viewportSize.height)], { timeout: 30000 });
  await openUrl(ctx, ctx.url, { timeout: 90000 });
  await waitMs(ctx.session, 1500);
}

export function buildNewSessionUrl(baseUrl, directory) {
  const url = new URL('/new', baseUrl);
  url.searchParams.set('happier_hmr', '0');
  const trimmedDirectory = String(directory ?? '').trim();
  if (trimmedDirectory) url.searchParams.set('directory', trimmedDirectory);
  return url.href;
}

async function openNewSession(ctx) {
  await openUrl(ctx, buildNewSessionUrl(ctx.url, ctx.directory), { timeout: 90000 });
  await waitMs(ctx.session, 1500);
}

async function openTargetSession(ctx, options = {}) {
  const targetSessionUrl = buildTargetSessionUrl(ctx.url, ctx.targetSessionUrl);
  if (targetSessionUrl) {
    const currentUrl = await browserEval(ctx.session, 'globalThis.location?.href ?? ""', { timeout: 10000 }).catch(() => null);
    if (shouldOpenTargetSessionUrl(currentUrl, targetSessionUrl)) {
      await openUrl(ctx, targetSessionUrl, { timeout: 90000 });
      await waitMs(ctx.session, 2500);
    }
    const urlResponse = await browserJson(ctx.session, ['get', 'url'], { timeout: 30000 });
    if (isSessionViewUrl(urlResponse?.data?.url)) return;
    throw new Error(`Target session URL did not open a session route; current URL: ${urlResponse?.data?.url ?? 'unknown'}`);
  }

  await openRoot(ctx, options.rootViewport ?? 'desktop');
  if (ctx.targetSessionTitle) {
    try {
      await browserJson(ctx.session, ['find', 'text', ctx.targetSessionTitle, 'click'], { timeout: 20000 });
      await waitMs(ctx.session, 2500);
      const urlResponse = await browserJson(ctx.session, ['get', 'url'], { timeout: 30000 });
      if (isSessionViewUrl(urlResponse?.data?.url)) return;
    } catch {}
  }
  const clicked = await browserEval(ctx.session, `(() => {
    const controls = new Set(['Search sessions', 'Filter by tags', 'View options', 'Archived Sessions']);
    const elements = Array.from(document.querySelectorAll('a,button,[role="button"],div,span'));
    const candidate = elements.find((el) => {
      const text = (el.innerText || el.textContent || '').trim();
      if (!text || text.length < 4 || controls.has(text)) return false;
      if (/Search sessions|Filter by tags|View options|Archived Sessions|Backup your secret key/.test(text)) return false;
      const rect = el.getBoundingClientRect?.();
      return rect && rect.width > 100 && rect.height > 20 && rect.top > 80;
    });
    if (!candidate) return false;
    candidate.click();
    return true;
  })()`);
  if (!clicked) throw new Error('Could not locate a session row to open');
  await waitForSessionNavigation(ctx, 30000);
}

async function fillFirstTextbox(ctx, text) {
  const snapshot = await browserJson(ctx.session, ['snapshot', '-i'], { timeout: 60000 });
  const textboxRef = refByRoleName(snapshot, 'textbox', /./);
  if (!textboxRef) throw new Error('Could not find a textbox to fill');
  await browserJson(ctx.session, ['fill', textboxRef, text], { timeout: 120000 });
  const result = await browserEval(ctx.session, buildSetFirstVisibleTextboxValueScript(text), { timeout: 30000 });
  if (result?.ok !== true) throw new Error(`Could not set textbox value through DOM: ${result?.reason ?? 'unknown'}`);
}

async function typeIntoFocusedTextbox(ctx, text) {
  const result = await browserEval(ctx.session, buildSetFirstVisibleTextboxValueScript(text), { timeout: 30000 });
  if (result?.ok !== true) throw new Error(`Could not set textbox value through DOM: ${result?.reason ?? 'unknown'}`);
}

async function clickLaunchSessionButton(ctx) {
  let snapshot = await browserJson(ctx.session, ['snapshot', '-i'], { timeout: 60000 });
  let launchRef = chooseLaunchSessionButtonRef(snapshot);
  if (!launchRef) {
    await waitMs(ctx.session, 1000);
    snapshot = await browserJson(ctx.session, ['snapshot', '-i'], { timeout: 60000 });
    launchRef = chooseLaunchSessionButtonRef(snapshot);
  }
  if (launchRef) {
    await browserJson(ctx.session, ['click', launchRef], { timeout: 30000 });
    await waitMs(ctx.session, 1000);
    const urlResponse = await browserJson(ctx.session, ['get', 'url'], { timeout: 30000 });
    if (String(urlResponse?.data?.url ?? '').includes('/session/')) return;
  }

  const clicked = await browserEval(ctx.session, `(() => {
    function readableText(el) {
      return (el.getAttribute('aria-label') || el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
    }
    function nearestClickable(el) {
      let node = el;
      while (node && node !== document.body) {
        const style = getComputedStyle(node);
        if (node.tagName === 'BUTTON' || node.getAttribute('role') === 'button' || style.cursor === 'pointer' || typeof node.onclick === 'function') {
          return node;
        }
        node = node.parentElement;
      }
      return el;
    }
    const candidates = Array.from(document.querySelectorAll('button,[role="button"],div,span'))
      .map((el) => {
        const text = readableText(el);
        const rect = el.getBoundingClientRect?.();
        const visible = rect && rect.width > 20 && rect.height > 10;
        if (!visible) return null;
        if (!/^(Start|Resume)\\s+.+\\s+session$/i.test(text) && !/^Start New Session$/i.test(text)) return null;
        const target = nearestClickable(el);
        const targetRect = target.getBoundingClientRect?.() ?? rect;
        const exactStart = /^Start New Session$/i.test(text);
        const compactSubmitButton = exactStart
          && targetRect.left > window.innerWidth * 0.5
          && targetRect.top > window.innerHeight * 0.45
          && targetRect.width <= 90
          && targetRect.height <= 90;
        return {
          el: target,
          text,
          score: (compactSubmitButton ? 200 : exactStart ? 0 : 10) + (targetRect.top > window.innerHeight * 0.35 ? 20 : 0) + targetRect.top / 10000,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    const target = candidates[0]?.el;
    if (!target) return false;
    target.click();
    return true;
  })()`);
  if (!clicked) throw new Error('Could not find session launch button for stress session');
}

async function waitForSessionNavigation(ctx, timeoutMs = 30000) {
  const startedAt = Date.now();
  let lastUrl = null;
  while (Date.now() - startedAt <= timeoutMs) {
    const urlResponse = await browserJson(ctx.session, ['get', 'url'], { timeout: 30000 });
    lastUrl = urlResponse?.data?.url ?? null;
    if (isSessionViewUrl(lastUrl)) return lastUrl;
    await waitMs(ctx.session, 1000);
  }
  throw new Error(`Stress session did not navigate to a session after launch; current URL: ${lastUrl ?? 'unknown'}`);
}

async function createStressSessions(ctx, count) {
  if (count <= 0) return [];
  const created = [];
  const basePrompt = ctx.stressPromptFile
    ? await readFile(resolve(ctx.stressPromptFile), 'utf8')
    : DEFAULT_STRESS_TEST_PROMPT;
  for (let index = 0; index < count; index += 1) {
    const scratchDir = join('/tmp', `happier-ui-perf-stress-${Date.now()}-${index}`);
    const prompt = buildSafeStressPrompt({ scratchDir, basePrompt });
    await openNewSession(ctx);
    await fillFirstTextbox(ctx, prompt);
    await clickLaunchSessionButton(ctx);
    const url = await waitForSessionNavigation(ctx, 30000);
    created.push({ scratchDir, url });
  }
  return created;
}

async function clickTextIfPresent(ctx, text) {
  try {
    await browserJson(ctx.session, ['find', 'text', text, 'click'], { timeout: 10000 });
    await waitMs(ctx.session, 500);
    return true;
  } catch {}
  try {
    await browserJson(ctx.session, ['find', 'role', 'button', 'click', '--name', text], { timeout: 10000 });
    await waitMs(ctx.session, 500);
    return true;
  } catch {}
  try {
    const clicked = await browserEval(ctx.session, buildClickVisibleControlByNameScript(text), { timeout: 10000 });
    if (clicked) {
      await waitMs(ctx.session, 500);
      return true;
    }
  } catch {}
  return false;
}

async function waitForTranscriptScrollerReady(ctx, scenario) {
  if (!shouldWaitForTranscriptScrollerBeforeMeasurement(scenario)) return;
  const deadlineMs = Date.now() + 30000;
  let lastResult = null;
  while (Date.now() < deadlineMs) {
    lastResult = await browserEval(ctx.session, buildTranscriptScrollerReadyScript(), { timeout: 10000 }).catch((caught) => ({ error: caught?.message ?? String(caught) }));
    if (lastResult?.ready === true) return;
    await waitMs(ctx.session, 500);
  }
  throw new Error(`Transcript scroller was not ready before measurement: ${JSON.stringify(lastResult)}`);
}

async function prepareScenarioSurface(ctx, scenario) {
  const phases = resolveScenarioExecutionPhases(scenario.action);
  switch (phases.prepare) {
    case 'none':
      return phases;
    case 'root':
      await openRoot(ctx);
      return phases;
    case 'newSession':
      await openNewSession(ctx);
      return phases;
    case 'targetSession':
      await openTargetSession(ctx);
      return phases;
    case 'mobileTargetSession':
      await openTargetSession(ctx, {
        rootViewport: resolvePreparationOpenRootViewport({
          prepare: phases.prepare,
          scenarioViewport: scenario.viewport,
        }),
      });
      return phases;
    default:
      throw new Error(`Unhandled scenario preparation: ${phases.prepare}`);
  }
}

async function runColdAuthHydrationScenario(ctx, scenario) {
  await openUrl(ctx, ctx.url, { timeout: 90000 });
  await browserEval(ctx.session, buildClearBrowserStorageScript(), { timeout: 60000 });
  await writeTelemetryTuningOverride(ctx, { flushIntervalMs: 120000 });
  await browserJson(ctx.session, ['reload'], { timeout: 90000 });
  const authSurface = await openAuthenticationSurface(ctx, { open: false });
  if (authSurface.alreadyAuthenticated) {
    throw new Error('Cold auth scenario expected cleared browser storage to reach the restore screen');
  }
  await browserEval(ctx.session, buildInstallProbeScript(), { timeout: 30000 });
  await browserEval(ctx.session, 'window.__HAPPIER_SYNC_PERFORMANCE__?.reset?.(); true;', { timeout: 30000 });
  await submitDevKeyRestore(ctx, authSurface);
  await waitMs(ctx.session, scenario.durationMs);
}

function isTranscriptScrollKickoffTarget(started) {
  const targetTestId = String(started?.targetTestId ?? '');
  return targetTestId === 'transcript-chat-list' || targetTestId.startsWith('transcript-chat-list');
}

function isSessionListScrollKickoffTarget(started) {
  const targetTestId = String(started?.targetTestId ?? '');
  return targetTestId === 'session-list' || targetTestId === 'sessions-list-keyboard-zone';
}

export function validateScrollKickoffResult(scenario, started) {
  if (started?.started !== true) {
    throw new Error(`Could not start scroll measurement: ${started?.reason ?? 'unknown'}`);
  }
  if (scenario?.action === 'sessionViewTranscriptScroll' && !isTranscriptScrollKickoffTarget(started)) {
    throw new Error(
      `Transcript scroll measurement did not target the transcript scroller (targetTestId=${String(started?.targetTestId ?? 'unknown')}, scrollHeight=${Number(started?.scrollHeight ?? 0)}, clientHeight=${Number(started?.clientHeight ?? 0)})`,
    );
  }
  if (scenario?.action === 'sessionListScroll' && !isSessionListScrollKickoffTarget(started)) {
    throw new Error(
      `Session list scroll measurement did not target the session list scroller (targetTestId=${String(started?.targetTestId ?? 'unknown')}, scrollHeight=${Number(started?.scrollHeight ?? 0)}, clientHeight=${Number(started?.clientHeight ?? 0)})`,
    );
  }
}

async function runMeasuredScenarioAction(ctx, scenario, phases) {
  switch (phases.measure) {
    case 'idle':
      await waitMs(ctx.session, scenario.durationMs);
      return;
    case 'scroll': {
      const started = await browserEval(ctx.session, buildScrollKickoffScript(scenario.durationMs), { timeout: 30000 });
      validateScrollKickoffResult(scenario, started);
      try {
        await waitMs(ctx.session, scenario.durationMs);
      } finally {
        await browserEval(ctx.session, buildScrollStopScript(), { timeout: 10000 }).catch(() => null);
      }
      return;
    }
    case 'search':
      await clickTextIfPresent(ctx, 'Search sessions');
      await typeIntoFocusedTextbox(ctx, 'perf');
      await waitMs(ctx.session, Math.max(1000, scenario.durationMs - 1500));
      await browserJson(ctx.session, ['press', 'Escape'], { timeout: 10000 }).catch(() => null);
      return;
    case 'composerTyping':
      await typeIntoFocusedTextbox(ctx, 'Please write a concise markdown performance smoke test with a list, a table, and a code fence.');
      await waitMs(ctx.session, Math.max(1000, scenario.durationMs - 2000));
      return;
    case 'coldAuthHydration':
      await runColdAuthHydrationScenario(ctx, scenario);
      return;
    case 'tabs':
      for (const label of ['Files', 'Git', 'Agents', 'Runs', 'Details', 'Transcript']) {
        await clickTextIfPresent(ctx, label);
        await waitMs(ctx.session, Math.max(500, Math.trunc(scenario.durationMs / 12)));
      }
      await waitMs(ctx.session, Math.max(1000, Math.trunc(scenario.durationMs / 3)));
      return;
    default:
      throw new Error(`Unhandled scenario measurement: ${phases.measure}`);
  }
}

async function collectScenarioSnapshot(ctx) {
  let probeError = 'Browser perf probe snapshot was not available';
  try {
    const raw = await browserEval(ctx.session, `window.${AUDIT_GLOBAL}?.snapshot?.() ?? null`, { timeout: 60000 });
    if (raw) return buildScenarioSnapshotResult(raw);
  } catch (caught) {
    probeError = caught?.message ?? String(caught);
  }

  try {
    const fallbackRaw = await browserEval(ctx.session, buildFallbackScenarioSnapshotScript(probeError), { timeout: 60000 });
    if (fallbackRaw) return buildScenarioSnapshotResult(fallbackRaw);
  } catch (caught) {
    throw new Error(
      `${probeError}; fallback telemetry snapshot failed: ${caught?.message ?? String(caught)}`,
    );
  }

  throw new Error(probeError);
}

async function runScenario(ctx, scenario) {
  const safeId = scenario.id.replace(/[^a-z0-9_.-]+/gi, '_');
  const tracePath = join(ctx.outDir, `${safeId}.trace.json`);
  const profilePath = join(ctx.outDir, `${safeId}.cpuprofile`);
  const v8ProfilePath = join(ctx.outDir, `${safeId}.v8.cpuprofile`);
  await browserJson(ctx.session, ['set', 'viewport', String(VIEWPORTS[scenario.viewport].width), String(VIEWPORTS[scenario.viewport].height)], { timeout: 30000 });
  const phases = await prepareScenarioSurface(ctx, scenario);
  await waitForTranscriptScrollerReady(ctx, scenario);
  if (ctx.skipTelemetryReload) await configureLiveTelemetry(ctx);
  await browserEval(ctx.session, buildInstallProbeScript(), { timeout: 30000 });
  await browserEval(ctx.session, 'window.__HAPPIER_SYNC_PERFORMANCE__?.reset?.(); true;', { timeout: 30000 });

  const shouldTrace = scenario.trace && !ctx.skipTrace;
  const shouldV8Profile = scenario.profiler && !ctx.skipProfiler && ctx.v8Profile === true;
  // agent-browser exposes trace and CPU profiler through the same active capture slot.
  // Prefer trace for UI/GPU work because it includes renderer/compositor/Viz threads. Use
  // --v8-profile when valid V8 CPU self-time is needed; agent-browser's profiler output can
  // be a Chrome trace despite the .cpuprofile suffix.
  const shouldProfile = scenario.profiler && !ctx.skipProfiler && !shouldTrace && !shouldV8Profile;
  await stopActiveBrowserCaptures(ctx, `${safeId}-preflight`);
  if (shouldTrace) await startBrowserCapture(ctx, 'trace');
  if (shouldProfile) await startBrowserCapture(ctx, 'profiler');
  await browserEval(ctx.session, `window.${AUDIT_GLOBAL}?.reset?.(); window.__HAPPIER_SYNC_PERFORMANCE__?.reset?.(); true;`, { timeout: 30000 });

  const startedAt = new Date().toISOString();
  let error = null;
  let v8Capture = null;
  if (shouldV8Profile) {
    try {
      v8Capture = await startV8CpuProfile(ctx, v8ProfilePath);
    } catch (caught) {
      error = caught?.message ?? String(caught);
    }
  }
  try {
    await runMeasuredScenarioAction(ctx, scenario, phases);
  } catch (caught) {
    error = error ?? caught?.message ?? String(caught);
  }

  if (v8Capture) {
    try { await v8Capture.stop(); } catch (caught) { error = error ?? caught?.message ?? String(caught); }
  }
  if (shouldProfile) {
    try { await execAgentBrowser(ctx.session, ['profiler', 'stop', profilePath], { parseJson: false, timeout: 60000 }); } catch (caught) { error = error ?? caught?.message ?? String(caught); }
  }
  if (shouldTrace) {
    try { await execAgentBrowser(ctx.session, ['trace', 'stop', tracePath], { parseJson: false, timeout: 60000 }); } catch (caught) { error = error ?? caught?.message ?? String(caught); }
  }

  const snapshot = await collectScenarioSnapshot(ctx).catch((caught) => ({ error: caught?.message ?? String(caught) }));
  const traceSummary = shouldTrace && existsSync(tracePath)
    ? await summarizeChromeTraceFile(tracePath)
    : null;
  const result = {
    scenario,
    startedAt,
    finishedAt: new Date().toISOString(),
    error,
    artifacts: {
      trace: shouldTrace ? tracePath : null,
      profile: shouldProfile ? profilePath : null,
      v8Profile: shouldV8Profile ? v8ProfilePath : null,
    },
    ...snapshot,
    traceSummary,
  };
  await writeJson(join(ctx.outDir, `${safeId}.json`), result);
  return result;
}

function buildRunSummary(results) {
  return {
    scenarios: results.map((result) => ({
      id: result.scenario?.id,
      title: result.scenario?.title,
      error: result.error ?? result.raw?.error ?? null,
      browserSummary: result.browserSummary ?? null,
      topSyncEvents: result.syncTopEvents?.slice(0, 15) ?? [],
      traceThreadGroups: result.traceSummary?.threadGroups ?? null,
      traceTopEvents: result.traceSummary?.topEvents?.slice(0, 15) ?? [],
      v8Profile: result.artifacts?.v8Profile ?? null,
    })),
  };
}

async function main(argv) {
  const args = parsePerfAuditArgs(argv);
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  const plan = selectPlanScenarios(buildDefaultPerfAuditPlan({ defaultDurationMs: args.durationMs }), args.plan);
  if (args.printPlan) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }

  const outDir = buildArtifactDir(args.outDir);
  await mkdir(outDir, { recursive: true });
  await writeJson(join(outDir, 'plan.json'), plan);
  if (args.dryRun) {
    await writeJson(join(outDir, 'summary.json'), { dryRun: true, plan });
    process.stdout.write(`${outDir}\n`);
    return;
  }

  validatePerfAuditRuntimeArgs(args, plan);

  const ctx = {
    ...args,
    outDir,
  };

  const stressSessions = [];
  const results = [];
  try {
    const needsStandardSetup = plan.scenarios.some((scenario) => scenario.requiresColdAuth !== true);
    if (needsStandardSetup) {
      if (!args.skipAuth) await ensureAuthenticated(ctx);
      if (args.skipTelemetryReload) {
        await configureLiveTelemetry(ctx);
      } else {
        await configureTelemetryAndReload(ctx);
      }
    }
    if (args.stressSessionCount > 0) {
      stressSessions.push(...await createStressSessions(ctx, args.stressSessionCount));
      await writeJson(join(outDir, 'stress-sessions.json'), stressSessions);
    }
    for (const scenario of plan.scenarios) {
      if (scenario.requiresStressSessions && args.stressSessionCount <= 0) {
        results.push({ scenario, error: 'skipped: requires --stress-sessions > 0', skipped: true });
        continue;
      }
      results.push(await runScenario(ctx, scenario));
    }
  } finally {
    try {
      await cleanupTelemetry(ctx);
    } finally {
      await closeAgentBrowserSession(ctx);
    }
  }

  const summary = {
    outDir,
    url: args.url,
    plan: args.plan,
    browserSession: {
      name: args.session,
      kept: args.keepBrowserSession === true,
      closeError: ctx.browserSessionCloseError ?? null,
    },
    stressSessions,
    ...buildRunSummary(results),
  };
  const measurement = createRuntimeLimitMeasurementCaptureFromEnv({
    env: process.env,
    runnerId: 'agent-browser-ui-perf',
    scenarioId: args.plan,
  });
  if (measurement) {
    recordAgentBrowserPerfMeasurements(measurement.capture, results);
    await measurement.capture.writeArtifact({ artifactDir: measurement.artifactDir });
  }
  await writeJson(join(outDir, 'summary.json'), summary);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedFile && currentFile === invokedFile) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error?.stack ?? error?.message ?? String(error));
    process.exitCode = 1;
  });
}
