#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  createRuntimeLimitMeasurementCaptureFromEnv,
  recordWebMemoryProfileMeasurements,
} from '../../../../packages/tests/scripts/plugin-platform/runtime-limit-measurement.mjs';

import {
  buildSyncTuningOverride,
  SYNC_TUNING_STORAGE_KEY,
} from './agentBrowserUiPerfAudit.mjs';

const CDP_URL_ENV_NAME = 'HAPPIER_WEB_MEMORY_CDP_URL';
const AGENT_BROWSER_SESSION_ENV_NAME = 'HAPPIER_WEB_MEMORY_AGENT_BROWSER_SESSION';
const DEFAULT_AGENT_BROWSER_SESSION = 'happier-ui-perf';

const SYNC_EVENT_ALLOWLIST = new Set([
  'sync.sessions.realtime.fanout.window',
  'ui.react.render.sessions.list.virtualized',
  'sync.store.sessions.apply',
  'sync.store.sessions.apply.changed',
  'sync.store.sessions.renderables.patch',
  'sync.socket.sessions.projectionPatch.coalesce.immediate',
  'sync.socket.sessions.projectionPatch.coalesce.flush',
  'sync.socket.sessions.projectionPatch.coalesce.suppressed',
  'sync.store.sessions.warmCache.flush',
  'sync.store.sessions.warmCache.schedule',
  'sync.sessions.fetch.hydrationInputs',
  'sync.sessions.snapshot.hydrationCandidates',
  'sync.sessions.snapshot.hydrationPriority',
  'sync.sessions.snapshot.backgroundHydration',
  'sync.sessions.snapshot.backgroundHydration.attribution',
  'sync.sessions.snapshot.hydrationRow',
  'sync.sessions.snapshot.requiredHydration.wait',
  'sync.sessions.snapshot.firstUsableList',
  'sync.sessions.snapshot.fullyHydratedList',
  'sync.sessions.snapshot.fetchPage.request',
  'sync.sessions.snapshot.fetchPage',
  'sync.sessions.snapshot.fetchPage.responseBody',
  'sync.sessions.snapshot.fetchPage.responseJson',
  'sync.sessions.snapshot.fetchPage.responseSchema',
  'sync.sessions.snapshot.fetchPage.process',
  'sync.sessions.snapshot.decryptDataKeys',
  'sync.sessions.snapshot.decryptRows',
  'sync.sessions.snapshot.renderableBuild',
  'sync.sessions.snapshot.applyRenderables',
  'sync.store.sessions.renderables.patch.warmCache.deferred',
  'sync.sessions.socket.newMessage',
  'sync.sessions.socket.messageUpdated',
  'sync.socket.event',
  'ui.sessionsList.rowStoreSelector.changed',
  'ui.sessionsList.rowStoreSubscriptions',
  'ui.sessionsList.viewableRows.changed',
]);

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

function normalizeString(value) {
  const trimmed = String(value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}

function usage() {
  return buildWebMemoryProfileUsage();
}

export function buildWebMemoryProfileUsage() {
  return `Usage: node apps/ui/scripts/perf/webMemoryProfile.mjs [options]

Collect browser-side memory trend evidence from an existing Chromium/CDP session.

Environment defaults:
  ${CDP_URL_ENV_NAME}                     Existing browser CDP URL
  ${AGENT_BROWSER_SESSION_ENV_NAME}       agent-browser session used to resolve CDP URL

Options:
  --cdp-url <url>                         Existing ws://.../devtools/browser/... URL
  --agent-browser-session <name>          Resolve CDP URL through agent-browser session
  --url <url>                             Optional page URL to open before profiling
  --scenario <session-list-scroll|session-view-idle|generic-idle>
  --cycles <n>                            Number of measurement cycles (default: 5)
  --cycle-ms <ms>                         Duration of each cycle (default: 12000)
  --idle-ms <ms>                          Final idle/settle window (default: 30000)
  --out-dir <dir>                         Artifact directory
  --heap-snapshots                        Write baseline/after-cycles/final .heapsnapshot files
  --json                                  Print compact JSON result
  --help                                  Show this help
`;
}

export function parseWebMemoryProfileArgs(argv, env = process.env) {
  const args = {
    cdpUrl: normalizeString(env[CDP_URL_ENV_NAME]),
    agentBrowserSession: normalizeString(env[AGENT_BROWSER_SESSION_ENV_NAME]),
    url: null,
    scenario: 'session-list-scroll',
    cycles: 5,
    cycleMs: 12000,
    idleMs: 30000,
    outDir: null,
    heapSnapshots: false,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    switch (arg) {
      case '--cdp-url':
        args.cdpUrl = normalizeString(next());
        break;
      case '--agent-browser-session':
        args.agentBrowserSession = normalizeString(next());
        break;
      case '--url':
        args.url = normalizeString(next());
        break;
      case '--scenario':
        args.scenario = normalizeString(next()) ?? args.scenario;
        break;
      case '--cycles':
        args.cycles = normalizePositiveInt(next(), args.cycles);
        break;
      case '--cycle-ms':
        args.cycleMs = normalizePositiveInt(next(), args.cycleMs);
        break;
      case '--idle-ms':
        args.idleMs = normalizeNonNegativeInt(next(), args.idleMs);
        break;
      case '--out-dir':
        args.outDir = normalizeString(next());
        break;
      case '--heap-snapshots':
        args.heapSnapshots = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return args;
}

export function validateWebMemoryProfileArgs(args) {
  if (!args?.cdpUrl && !args?.agentBrowserSession) {
    throw new Error(`Provide --cdp-url, --agent-browser-session, ${CDP_URL_ENV_NAME}, or ${AGENT_BROWSER_SESSION_ENV_NAME}`);
  }
  if (!['session-list-scroll', 'session-view-idle', 'generic-idle'].includes(args.scenario)) {
    throw new Error(`Unsupported --scenario: ${args.scenario}`);
  }
  if (!args.outDir) {
    throw new Error('Provide --out-dir so memory artifacts are kept with the review evidence');
  }
}

export function filterSyncTelemetrySnapshot(snapshot) {
  return {
    marks: Array.isArray(snapshot?.marks) ? snapshot.marks : [],
    events: (Array.isArray(snapshot?.events) ? snapshot.events : [])
      .filter((event) => SYNC_EVENT_ALLOWLIST.has(String(event?.name ?? '')))
      .map((event) => ({
        name: String(event.name),
        count: Number(event.count ?? 0),
        totalMs: Number(event.totalMs ?? 0),
        maxMs: Number(event.maxMs ?? 0),
        fields: event.fields ?? {},
        fieldStats: event.fieldStats ?? {},
      })),
  };
}

function findEvent(events, name) {
  return events.find((event) => event.name === name);
}

function readMetric(sample, metricName) {
  return sample?.perfMetrics?.[metricName] ?? null;
}

function readCounter(sample, name, fallbackMetricName) {
  return sample?.domCounters?.[name] ?? readMetric(sample, fallbackMetricName);
}

export function summarizeWebMemoryProfileSamples(samples) {
  const rows = (Array.isArray(samples) ? samples : []).map((sample) => {
    const events = sample?.pageSignals?.syncPerformance?.events ?? [];
    const fanout = findEvent(events, 'sync.sessions.realtime.fanout.window');
    const listRender = findEvent(events, 'ui.react.render.sessions.list.virtualized');
    return {
      label: String(sample?.label ?? ''),
      href: sample?.href ?? null,
      heapUsedSize: sample?.heapUsage?.usedSize ?? null,
      heapTotalSize: sample?.heapUsage?.totalSize ?? null,
      embedderHeapUsedSize: sample?.heapUsage?.embedderHeapUsedSize ?? null,
      backingStorageSize: sample?.heapUsage?.backingStorageSize ?? null,
      performanceUsedJSHeapSize: sample?.pageSignals?.performanceMemory?.usedJSHeapSize ?? null,
      nodes: readCounter(sample, 'nodes', 'Nodes'),
      jsEventListeners: readCounter(sample, 'jsEventListeners', 'JSEventListeners'),
      documents: readCounter(sample, 'documents', 'Documents'),
      socketEvents: findEvent(events, 'sync.socket.event')?.count ?? 0,
      newMessages: findEvent(events, 'sync.sessions.socket.newMessage')?.count ?? 0,
      projectionPatches: fanout?.fields?.projectionPatches ?? 0,
      visibleSessionMessages: fanout?.fields?.visibleSessionMessages ?? 0,
      listRenderCount: listRender?.count ?? 0,
      listRenderTotalMs: round(listRender?.totalMs ?? 0) ?? 0,
    };
  });

  const first = rows[0] ?? {};
  const last = rows.at(-1) ?? {};
  const heapValues = rows.map((sample) => Number(sample.heapUsedSize)).filter(Number.isFinite);
  const monotonicallyIncreasingHeap = heapValues.length > 1
    ? heapValues.every((value, index) => index === 0 || value >= heapValues[index - 1])
    : false;

  return {
    samples: rows,
    trend: {
      heapUsedDelta: Number.isFinite(last.heapUsedSize) && Number.isFinite(first.heapUsedSize)
        ? last.heapUsedSize - first.heapUsedSize
        : null,
      heapUsedPeak: heapValues.length > 0 ? Math.max(...heapValues) : null,
      performanceUsedJSHeapDelta: Number.isFinite(last.performanceUsedJSHeapSize) && Number.isFinite(first.performanceUsedJSHeapSize)
        ? last.performanceUsedJSHeapSize - first.performanceUsedJSHeapSize
        : null,
      nodesDelta: Number.isFinite(last.nodes) && Number.isFinite(first.nodes) ? last.nodes - first.nodes : null,
      jsEventListenersDelta: Number.isFinite(last.jsEventListeners) && Number.isFinite(first.jsEventListeners)
        ? last.jsEventListeners - first.jsEventListeners
        : null,
      documentsDelta: Number.isFinite(last.documents) && Number.isFinite(first.documents) ? last.documents - first.documents : null,
      monotonicallyIncreasingHeap,
    },
  };
}

export function buildWebMemoryProfileSyncTuningInitScript(options = {}) {
  const tuningJson = JSON.stringify(buildSyncTuningOverride({
    flushIntervalMs: normalizePositiveInt(options.flushIntervalMs, 120000),
  }));
  return `(() => {
    try {
      window.localStorage?.setItem(${JSON.stringify(SYNC_TUNING_STORAGE_KEY)}, ${JSON.stringify(tuningJson)});
      return true;
    } catch {
      return false;
    }
  })()`;
}

async function execJson(command, args) {
  const output = await new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        rejectPromise(new Error(`${command} ${args.join(' ')} failed: ${stderr || stdout || error.message}`));
        return;
      }
      resolvePromise(stdout);
    });
  });
  return JSON.parse(output);
}

async function resolveCdpUrl(args) {
  if (args.cdpUrl) return args.cdpUrl;
  const session = args.agentBrowserSession || DEFAULT_AGENT_BROWSER_SESSION;
  const response = await execJson('agent-browser', ['--session', session, 'get', 'cdp-url', '--json']);
  const cdpUrl = normalizeString(response?.data?.cdpUrl);
  if (!cdpUrl) throw new Error(`agent-browser session ${session} did not expose a CDP URL`);
  return cdpUrl;
}

function metricsToObject(metrics) {
  const out = {};
  for (const metric of metrics?.metrics ?? []) out[metric.name] = metric.value;
  return out;
}

async function takeHeapSnapshot(cdp, filePath) {
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createWriteStream(filePath, { encoding: 'utf8' });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      stream.end();
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    cdp.on('HeapProfiler.addHeapSnapshotChunk', ({ chunk }) => {
      stream.write(chunk);
    });
    cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
      .then(() => finish())
      .catch((error) => finish(error));
  });
}

async function collectCheckpoint({ page, cdp, label, outDir, snapshotHeap }) {
  await cdp.send('HeapProfiler.collectGarbage').catch(() => null);
  await page.waitForTimeout(500);
  const heapSnapshotPath = snapshotHeap ? join(outDir, `${label}.heapsnapshot`) : null;
  if (heapSnapshotPath) await takeHeapSnapshot(cdp, heapSnapshotPath);
  const [heapUsage, perfMetrics, domCounters, pageSignals] = await Promise.all([
    cdp.send('Runtime.getHeapUsage').catch((error) => ({ error: String(error?.message ?? error) })),
    cdp.send('Performance.getMetrics').catch((error) => ({ error: String(error?.message ?? error), metrics: [] })),
    cdp.send('Memory.getDOMCounters').catch((error) => ({ error: String(error?.message ?? error) })),
    page.evaluate(async () => {
      const syncSnapshot = window.__HAPPIER_SYNC_PERFORMANCE__?.snapshot?.() ?? null;
      const memory = performance.memory
        ? {
            usedJSHeapSize: performance.memory.usedJSHeapSize,
            totalJSHeapSize: performance.memory.totalJSHeapSize,
            jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
          }
        : null;
      let uaMemory = null;
      if (typeof performance.measureUserAgentSpecificMemory === 'function') {
        uaMemory = await performance.measureUserAgentSpecificMemory()
          .catch((error) => ({ error: String(error?.message ?? error) }));
      }
      return {
        href: location.href,
        title: document.title,
        visibilityState: document.visibilityState,
        performanceMemory: memory,
        userAgentSpecificMemory: uaMemory,
        syncPerformance: syncSnapshot,
      };
    }).catch((error) => ({ error: String(error?.message ?? error) })),
  ]);

  return {
    label,
    at: new Date().toISOString(),
    href: page.url(),
    heapSnapshotPath,
    heapUsage,
    domCounters,
    perfMetrics: metricsToObject(perfMetrics),
    pageSignals: {
      ...pageSignals,
      syncPerformance: filterSyncTelemetrySnapshot(pageSignals?.syncPerformance),
    },
  };
}

async function runScrollPressure(page, durationMs) {
  const deadline = Date.now() + durationMs;
  let direction = 1;
  let steps = 0;
  while (Date.now() < deadline) {
    await page.mouse.wheel(0, direction * 900).catch(() => null);
    steps += 1;
    if (steps % 12 === 0) direction *= -1;
    await page.waitForTimeout(180);
  }
  return steps;
}

async function runScenarioCycle(page, args) {
  if (args.scenario === 'session-list-scroll') {
    return { scrollSteps: await runScrollPressure(page, args.cycleMs) };
  }
  await page.waitForTimeout(args.cycleMs);
  return { scrollSteps: 0 };
}

export async function configureAppTelemetry(page, options = {}) {
  const attempts = normalizePositiveInt(options.attempts, 60);
  const retryMs = normalizeNonNegativeInt(options.retryMs, 500);
  const resetTelemetry = options.reset !== false;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const configured = await page.evaluate((shouldReset) => {
      const telemetry = window.__HAPPIER_SYNC_PERFORMANCE__;
      if (!telemetry?.snapshot) return false;
      telemetry.configure?.({
        enabled: true,
        slowThresholdMs: 4,
        flushIntervalMs: 120000,
      });
      if (shouldReset) telemetry.reset?.();
      telemetry.markScenario?.('web-memory-profile-start');
      return true;
    }, resetTelemetry).catch(() => false);
    if (configured) return true;
    if (attempt < attempts && retryMs > 0) {
      await page.waitForTimeout(retryMs).catch(() => null);
    }
  }
  return false;
}

async function selectPage(browser, url) {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find((candidate) => url && candidate.url() === url)
    ?? pages.find((candidate) => candidate.url().includes('happier-repo-'))
    ?? pages.find((candidate) => candidate.url() !== 'about:blank')
    ?? pages.at(-1);
  if (!page) throw new Error('No page found for CDP memory profiling');
  if (url) {
    await page.addInitScript(buildWebMemoryProfileSyncTuningInitScript()).catch(() => null);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  }
  await page.bringToFront().catch(() => null);
  return page;
}

async function runWebMemoryProfile(args) {
  validateWebMemoryProfileArgs(args);
  const cdpUrl = await resolveCdpUrl(args);
  await mkdir(args.outDir, { recursive: true });
  const browser = await chromium.connectOverCDP(cdpUrl);
  try {
    const page = await selectPage(browser, args.url);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Runtime.enable');
    await cdp.send('Performance.enable');
    await cdp.send('HeapProfiler.enable');
    const appTelemetryConfigured = await configureAppTelemetry(page, { reset: !args.url });

    const samples = [];
    samples.push(await collectCheckpoint({
      page,
      cdp,
      label: 'baseline-after-forced-gc',
      outDir: args.outDir,
      snapshotHeap: args.heapSnapshots,
    }));
    for (let index = 1; index <= args.cycles; index += 1) {
      const cycle = await runScenarioCycle(page, args);
      const sample = await collectCheckpoint({
        page,
        cdp,
        label: `cycle-${index}`,
        outDir: args.outDir,
        snapshotHeap: false,
      });
      samples.push({ ...sample, ...cycle });
    }
    if (args.idleMs > 0) await page.waitForTimeout(args.idleMs);
    samples.push(await collectCheckpoint({
      page,
      cdp,
      label: 'final-idle-after-forced-gc',
      outDir: args.outDir,
      snapshotHeap: args.heapSnapshots,
    }));

    const summary = summarizeWebMemoryProfileSamples(samples);
    const result = {
      startedAt: samples[0]?.at ?? new Date().toISOString(),
      completedAt: new Date().toISOString(),
      cdpUrl,
      scenario: args.scenario,
      cycles: args.cycles,
      cycleMs: args.cycleMs,
      idleMs: args.idleMs,
      pageUrl: page.url(),
      appTelemetryConfigured,
      summary,
      samples,
    };
    await writeFile(join(args.outDir, 'web-memory-profile.json'), JSON.stringify(result, null, 2));
    await writeFile(join(args.outDir, 'summary.json'), JSON.stringify(summary, null, 2));
    const measurement = createRuntimeLimitMeasurementCaptureFromEnv({
      env: process.env,
      runnerId: 'web-memory-profile',
      scenarioId: args.scenario,
    });
    if (measurement) {
      recordWebMemoryProfileMeasurements(measurement.capture, summary);
      await measurement.capture.writeArtifact({ artifactDir: measurement.artifactDir });
    }
    return result;
  } finally {
    await closeWebMemoryProfileBrowserConnection(browser);
  }
}

export async function closeWebMemoryProfileBrowserConnection(browser) {
  if (browser && typeof browser.disconnect === 'function') {
    await browser.disconnect();
    return;
  }
  await browser?.close?.();
}

async function main(argv) {
  const args = parseWebMemoryProfileArgs(argv);
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  const result = await runWebMemoryProfile(args);
  const output = args.json
    ? result
    : { outDir: args.outDir, scenario: result.scenario, trend: result.summary.trend, samples: result.summary.samples };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error?.stack ?? error?.message ?? String(error));
    process.exitCode = 1;
  });
}
