#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SYNC_PERF_MARKER = '[sync-perf]';
const DEFAULT_SORT_KEY = 'maxMs';
const DURATION_BUCKET_OVERFLOW = 'inf';
const MAX_DISCOVERED_LOG_DEPTH = 5;
const KNOWN_LOG_BASENAMES = new Set([
  'android-logcat.log',
  'ios-simulator.log',
  'sync-perf.log',
  'sync-performance.log',
  'maestro.log',
  'ui.dev-client.metro.stdout.log',
  'ui.dev-client.metro.stderr.log',
]);

const METRIC_COVERAGE_DEFINITIONS = [
  {
    id: 'firstUsableList',
    label: 'First usable list',
    primaryEvents: ['sync.sessions.snapshot.firstUsableList'],
    proxyEvents: [
      'sync.sessions.snapshot.applyRenderables',
      'sync.store.sessions.renderables.replace',
    ],
    note: 'Proxy events prove snapshot renderables were applied, but not an explicit user-visible first-usable timestamp.',
  },
  {
    id: 'fullyHydratedList',
    label: 'Fully hydrated list',
    primaryEvents: ['sync.sessions.snapshot.fullyHydratedList'],
    proxyEvents: [
      'sync.sessions.snapshot.backgroundHydration',
      'sync.sessions.snapshot.requiredHydration.wait',
      'sync.sessions.snapshot.hydrationApply.flush',
    ],
    note: 'Proxy events cover hydration work, but not a single explicit all-rows-complete marker.',
  },
  {
    id: 'rowSkeletonStalePreservation',
    label: 'Row skeleton and stale preservation',
    requiredEventGroups: [
      ['sync.store.sessions.renderables.replace'],
      ['sync.sessions.list.identitySkeleton'],
    ],
    proxyEvents: [
      'sync.store.sessions.renderables.patch',
    ],
    note: 'Replacement fields cover stale preservation; identity skeleton transition telemetry is optional and currently separate.',
  },
  {
    id: 'listRowHydration',
    label: 'List-row hydration',
    primaryEvents: ['sync.sessions.snapshot.listRowHydration'],
    proxyEvents: [
      'sync.sessions.snapshot.hydrationRow',
      'sync.sessions.snapshot.decryptRow',
    ],
    note: 'Current remote-dev uses full row decrypt as the proxy because list-row/full hydration is intentionally not split here.',
  },
  {
    id: 'fullHydration',
    label: 'Full session hydration',
    primaryEvents: ['sync.sessions.snapshot.fullHydration'],
    proxyEvents: [
      'sync.sessions.snapshot.backgroundHydration',
      'sync.sessions.snapshot.requiredHydration.wait',
      'sync.sessions.snapshot.hydrationPriority',
    ],
    note: 'Current remote-dev applies hydrated sessions through the existing full-session seam.',
  },
  {
    id: 'dataKeyDecrypt',
    label: 'Data-key decrypt',
    primaryEvents: [
      'sync.sessions.snapshot.decryptDataKeys',
      'sync.encryption.account.decryptDataKey',
    ],
    proxyEvents: [],
  },
  {
    id: 'nativeWorkerQueueWait',
    label: 'Native worker queue wait',
    primaryEvents: [
      'sync.crypto.worker.queueWaitMs',
      'sync.crypto.worker.queueDepth',
    ],
    proxyEvents: [
      'sync.sessions.snapshot.hydrationApply.queueWait',
    ],
  },
  {
    id: 'jsThreadLag',
    label: 'JS thread lag',
    primaryEvents: ['sync.runtime.jsThreadLag.summary'],
    proxyEvents: [],
  },
  {
    id: 'storeApply',
    label: 'Store apply',
    primaryEvents: [
      'sync.store.sessions.apply',
      'sync.store.sessions.apply.merge',
      'sync.store.sessions.apply.merge.outcome',
    ],
    proxyEvents: [],
  },
  {
    id: 'listRebuild',
    label: 'List rebuild',
    primaryEvents: [
      'sync.store.sessions.apply.listRebuild',
      'sync.store.sessions.renderables.replace.listRebuild',
      'sync.store.sessions.renderables.patch.listRebuild',
    ],
    proxyEvents: [],
  },
  {
    id: 'visibleListCompute',
    label: 'Visible-list compute',
    primaryEvents: ['sync.sessions.list.visible.compute'],
    proxyEvents: [],
  },
  {
    id: 'sessionOpen',
    label: 'Session open to transcript or empty state',
    primaryEvents: ['ui.sessions.openToTranscript'],
    proxyEvents: [
      'sync.sessions.messages.request',
      'sync.sessions.messages.responseJson',
      'sync.sessions.messages.decrypt',
      'sync.sessions.messages.normalize',
      'sync.sessions.messages.apply',
    ],
    note: 'Message-load phases are present, but there is no explicit tap/open-to-render end-to-end marker.',
  },
  {
    id: 'streamingVisibleUpdate',
    label: 'Streaming event to visible update',
    primaryEvents: ['ui.sessions.streaming.visibleUpdate'],
    proxyEvents: [
      'sync.sessions.socket.newMessage',
      'sync.sessions.socket.messageUpdated',
      'sync.sessions.socket.message.readMessage',
      'sync.sessions.socket.message.normalize',
      'sync.sessions.socket.message.apply',
      'sync.sessions.socket.transcriptStreamSegment',
      'sync.sessions.socket.transcriptStreamSegment.readMessage',
      'sync.sessions.socket.transcriptStreamSegment.normalize',
      'sync.sessions.socket.transcriptStreamSegment.apply',
      'sync.socket.messages.coalesce.flush',
      'sync.store.messages.apply',
    ],
    note: 'Socket/apply phases are present, but there is no explicit socket-event-to-visible-render latency marker.',
  },
];

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function roundMetric(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;
}

function mergeFieldStats(existing, incoming) {
  if (!incoming || typeof incoming !== 'object') return existing;
  const merged = { ...existing };
  for (const [field, stats] of Object.entries(incoming)) {
    if (!stats || typeof stats !== 'object') continue;
    const sum = isFiniteNumber(stats.sum) ? stats.sum : 0;
    const min = isFiniteNumber(stats.min) ? stats.min : null;
    const max = isFiniteNumber(stats.max) ? stats.max : null;
    const last = isFiniteNumber(stats.last) ? stats.last : null;
    const current = merged[field];
    merged[field] = current
      ? {
        sum: current.sum + sum,
        min: min === null ? current.min : Math.min(current.min, min),
        max: max === null ? current.max : Math.max(current.max, max),
        last: last === null ? current.last : last,
      }
      : {
        sum,
        min: min ?? 0,
        max: max ?? 0,
        last: last ?? 0,
      };
  }
  return merged;
}

function mergeFields(existing, incoming) {
  if (!incoming || typeof incoming !== 'object') return existing;
  const merged = { ...existing };
  for (const [field, value] of Object.entries(incoming)) {
    if (!isFiniteNumber(value)) continue;
    merged[field] = (merged[field] ?? 0) + value;
  }
  return merged;
}

function mergeDurationBuckets(existing, incoming) {
  if (!incoming || typeof incoming !== 'object') return existing;
  const merged = { ...existing };
  for (const [bucket, value] of Object.entries(incoming)) {
    if (!isFiniteNumber(value)) continue;
    merged[String(bucket)] = (merged[String(bucket)] ?? 0) + value;
  }
  return merged;
}

function sortedDurationBucketKeys(durationBuckets) {
  return Object.keys(durationBuckets).sort((left, right) => {
    if (left === DURATION_BUCKET_OVERFLOW) return 1;
    if (right === DURATION_BUCKET_OVERFLOW) return -1;
    return Number(left) - Number(right);
  });
}

function readDurationBucketValue(bucketKey, fallbackMaxMs) {
  if (bucketKey === DURATION_BUCKET_OVERFLOW) return fallbackMaxMs;
  const value = Number(bucketKey);
  return Number.isFinite(value) ? value : fallbackMaxMs;
}

function approximatePercentileFromBuckets(durationBuckets, percentile, maxMs) {
  const total = Object.values(durationBuckets).reduce((sum, count) => sum + count, 0);
  if (total <= 0) return null;
  const target = Math.max(1, Math.ceil((total * percentile) / 100));
  let seen = 0;
  for (const bucketKey of sortedDurationBucketKeys(durationBuckets)) {
    seen += durationBuckets[bucketKey] ?? 0;
    if (seen >= target) {
      return readDurationBucketValue(bucketKey, maxMs);
    }
  }
  return maxMs;
}

function extractBalancedJsonObject(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(startIndex, index + 1);
    }
  }
  return null;
}

function parseSummaryFromLine(line) {
  const markerIndex = line.indexOf(SYNC_PERF_MARKER);
  if (markerIndex === -1) return { matched: false, summary: null };
  const tail = line.slice(markerIndex + SYNC_PERF_MARKER.length);
  for (let index = 0; index < tail.length; index += 1) {
    if (tail[index] !== '{') continue;
    const jsonText = extractBalancedJsonObject(tail, index);
    if (!jsonText) continue;
    try {
      const parsed = JSON.parse(jsonText);
      if (Array.isArray(parsed?.events)) {
        return { matched: true, summary: parsed };
      }
    } catch {
      continue;
    }
  }
  return { matched: true, summary: null };
}

export function parseSyncPerformanceLog(raw) {
  const summaries = [];
  let matchedLines = 0;
  let malformedLines = 0;
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const parsed = parseSummaryFromLine(line);
    if (!parsed.matched) continue;
    matchedLines += 1;
    if (parsed.summary) {
      summaries.push(parsed.summary);
    } else {
      malformedLines += 1;
    }
  }
  return { summaries, matchedLines, malformedLines };
}

function tryReadJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function addDiscoveredFile(files, seen, file) {
  const resolved = resolve(file);
  if (seen.has(resolved)) return;
  if (!existsSync(resolved)) return;
  let stat;
  try {
    stat = statSync(resolved);
  } catch {
    return;
  }
  if (!stat.isFile()) return;
  seen.add(resolved);
  files.push(resolved);
}

function readManifestLogCandidates(manifestPath) {
  const manifest = tryReadJsonFile(manifestPath);
  if (!manifest || typeof manifest !== 'object') return [];
  const artifacts = manifest.artifacts;
  if (!artifacts || typeof artifacts !== 'object') return [];
  const candidates = [];
  if (typeof artifacts.androidLogcat === 'string') {
    candidates.push(artifacts.androidLogcat);
  }
  if (typeof artifacts.iosSimulatorLog === 'string') {
    candidates.push(artifacts.iosSimulatorLog);
  }
  if (Array.isArray(artifacts.syncPerformanceLogs)) {
    for (const value of artifacts.syncPerformanceLogs) {
      if (typeof value === 'string') candidates.push(value);
    }
  }
  const manifestDir = dirname(manifestPath);
  return candidates.map((candidate) => resolve(manifestDir, candidate));
}

function shouldConsiderDiscoveredLog(file) {
  const name = basename(file);
  if (KNOWN_LOG_BASENAMES.has(name)) return true;
  const lower = name.toLowerCase();
  return lower.endsWith('.log') && (
    lower.includes('logcat')
    || lower.includes('sync-perf')
    || lower.includes('sync-performance')
  );
}

function discoverKnownLogsUnderDirectory(rootDir, files, seen, depth = 0) {
  if (depth > MAX_DISCOVERED_LOG_DEPTH) return;
  let children;
  try {
    children = readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const child of children) {
    if (child.name === 'metro-cache' || child.name === 'ui.dev-client.metro.tmp') continue;
    const childPath = join(rootDir, child.name);
    if (child.isDirectory()) {
      discoverKnownLogsUnderDirectory(childPath, files, seen, depth + 1);
      continue;
    }
    if (child.isFile() && shouldConsiderDiscoveredLog(child.name)) {
      addDiscoveredFile(files, seen, childPath);
    }
  }
}

function discoverFromManifest(manifestPath, files, seen) {
  for (const candidate of readManifestLogCandidates(manifestPath)) {
    addDiscoveredFile(files, seen, candidate);
  }
}

export function discoverSyncPerformanceLogFiles(inputs) {
  const files = [];
  const seen = new Set();
  for (const input of inputs ?? []) {
    if (typeof input !== 'string' || input.trim().length === 0) continue;
    const resolvedInput = resolve(input);
    if (!existsSync(resolvedInput)) {
      addDiscoveredFile(files, seen, resolvedInput);
      continue;
    }
    const stat = statSync(resolvedInput);
    if (stat.isFile()) {
      if (basename(resolvedInput) === 'manifest.json') {
        discoverFromManifest(resolvedInput, files, seen);
      } else {
        addDiscoveredFile(files, seen, resolvedInput);
      }
      continue;
    }
    if (!stat.isDirectory()) continue;
    const manifestPath = join(resolvedInput, 'manifest.json');
    if (existsSync(manifestPath)) {
      discoverFromManifest(manifestPath, files, seen);
    }
    discoverKnownLogsUnderDirectory(resolvedInput, files, seen);
  }
  return files;
}

export function summarizeSyncPerformanceSummaries(summaries, options = {}) {
  const sortKey = typeof options.sortKey === 'string' && options.sortKey.length > 0
    ? options.sortKey
    : DEFAULT_SORT_KEY;
  const eventsByName = new Map();
  for (const summary of summaries ?? []) {
    for (const event of summary?.events ?? []) {
      if (!event || typeof event.name !== 'string' || event.name.trim().length === 0) continue;
      const name = event.name.trim();
      const count = isFiniteNumber(event.count) ? event.count : 0;
      const totalMs = isFiniteNumber(event.totalMs) ? event.totalMs : 0;
      const minMs = isFiniteNumber(event.minMs) ? event.minMs : 0;
      const maxMs = isFiniteNumber(event.maxMs) ? event.maxMs : 0;
      const slowCount = isFiniteNumber(event.slowCount) ? event.slowCount : 0;
      const current = eventsByName.get(name);
      eventsByName.set(name, current
        ? {
          ...current,
          count: current.count + count,
          totalMs: current.totalMs + totalMs,
          minMs: Math.min(current.minMs, minMs),
          maxMs: Math.max(current.maxMs, maxMs),
          slowCount: current.slowCount + slowCount,
          durationBuckets: mergeDurationBuckets(current.durationBuckets, event.durationBuckets),
          fields: mergeFields(current.fields, event.fields),
          fieldStats: mergeFieldStats(current.fieldStats, event.fieldStats),
        }
        : {
          name,
          count,
          totalMs,
          minMs,
          maxMs,
          slowCount,
          durationBuckets: mergeDurationBuckets({}, event.durationBuckets),
          fields: mergeFields({}, event.fields),
          fieldStats: mergeFieldStats({}, event.fieldStats),
        });
    }
  }

  const events = Array.from(eventsByName.values())
    .map((event) => {
      const durationBuckets = event.durationBuckets ?? {};
      const p50Ms = approximatePercentileFromBuckets(durationBuckets, 50, event.maxMs);
      const p90Ms = approximatePercentileFromBuckets(durationBuckets, 90, event.maxMs);
      const p99Ms = approximatePercentileFromBuckets(durationBuckets, 99, event.maxMs);
      const base = {
        ...event,
        totalMs: roundMetric(event.totalMs),
        avgMs: roundMetric(event.count > 0 ? event.totalMs / event.count : 0),
        minMs: roundMetric(event.minMs),
        maxMs: roundMetric(event.maxMs),
      };
      if (p50Ms === null || p90Ms === null || p99Ms === null) {
        const { durationBuckets: _durationBuckets, ...withoutBuckets } = base;
        return withoutBuckets;
      }
      return {
        ...base,
        p50Ms: roundMetric(p50Ms),
        p90Ms: roundMetric(p90Ms),
        p99Ms: roundMetric(p99Ms),
      };
    })
    .sort((a, b) => {
      const aValue = isFiniteNumber(a[sortKey]) ? a[sortKey] : 0;
      const bValue = isFiniteNumber(b[sortKey]) ? b[sortKey] : 0;
      if (bValue !== aValue) return bValue - aValue;
      return a.name.localeCompare(b.name);
    });

  const metricCoverage = buildMetricCoverageFromEvents(events);

  return {
    summaryCount: Array.isArray(summaries) ? summaries.length : 0,
    eventCount: events.length,
    events,
    metricCoverage,
    metricCoverageCounts: summarizeMetricCoverage(metricCoverage),
  };
}

function toDeltaEvent(event) {
  return event
    ? {
      count: event.count,
      totalMs: event.totalMs,
      avgMs: event.avgMs,
      maxMs: event.maxMs,
      slowCount: event.slowCount,
    }
    : {
      count: 0,
      totalMs: 0,
      avgMs: 0,
      maxMs: 0,
      slowCount: 0,
    };
}

function findEventsByNames(eventsByName, names) {
  const matches = [];
  for (const name of names ?? []) {
    const event = eventsByName.get(name);
    if (event) {
      matches.push(event);
    }
  }
  return matches;
}

function eventEvidence(event) {
  return {
    name: event.name,
    count: event.count,
    maxMs: event.maxMs,
    p99Ms: event.p99Ms ?? null,
    totalMs: event.totalMs,
    slowCount: event.slowCount,
    fields: event.fields ?? {},
    fieldStats: event.fieldStats ?? {},
  };
}

function summarizeMetricCoverage(metricCoverage) {
  return metricCoverage.reduce((counts, item) => {
    counts[item.status] = (counts[item.status] ?? 0) + 1;
    return counts;
  }, { covered: 0, partial: 0, missing: 0 });
}

function buildMetricCoverageFromEvents(events) {
  const eventsByName = new Map((events ?? []).map((event) => [event.name, event]));
  return METRIC_COVERAGE_DEFINITIONS.map((definition) => {
    const primaryMatches = findEventsByNames(eventsByName, definition.primaryEvents);
    const proxyMatches = findEventsByNames(eventsByName, definition.proxyEvents);
    const requiredGroups = definition.requiredEventGroups ?? [];
    const requiredMatches = requiredGroups.flatMap((group) => findEventsByNames(eventsByName, group));
    const hasRequiredGroups = requiredGroups.length > 0;
    const missingRequiredEvents = hasRequiredGroups
      ? requiredGroups
        .filter((group) => findEventsByNames(eventsByName, group).length === 0)
        .map((group) => group[0])
        .filter((name) => typeof name === 'string')
      : [];
    const missingPrimaryEvents = (definition.primaryEvents ?? []).filter((name) => !eventsByName.has(name));
    const matchedEvents = [
      ...primaryMatches,
      ...requiredMatches,
      ...proxyMatches,
    ];
    const dedupedEvents = Array.from(
      new Map(matchedEvents.map((event) => [event.name, event])).values(),
    );
    const status = hasRequiredGroups
      ? (missingRequiredEvents.length === 0 ? 'covered' : (dedupedEvents.length > 0 ? 'partial' : 'missing'))
      : (primaryMatches.length > 0 ? 'covered' : (proxyMatches.length > 0 ? 'partial' : 'missing'));
    const missingEvents = hasRequiredGroups
      ? missingRequiredEvents
      : (status === 'covered' ? [] : missingPrimaryEvents);

    return {
      id: definition.id,
      label: definition.label,
      status,
      events: dedupedEvents.map(eventEvidence),
      missingEvents,
      note: definition.note ?? '',
    };
  });
}

export function compareSyncPerformanceReports({ baseline, candidate }) {
  const baselineByName = new Map((baseline?.events ?? []).map((event) => [event.name, event]));
  const candidateByName = new Map((candidate?.events ?? []).map((event) => [event.name, event]));
  const names = new Set([...baselineByName.keys(), ...candidateByName.keys()]);
  const events = Array.from(names).sort().map((name) => {
    const before = toDeltaEvent(baselineByName.get(name));
    const after = toDeltaEvent(candidateByName.get(name));
    return {
      name,
      baseline: before,
      candidate: after,
      delta: {
        count: after.count - before.count,
        totalMs: roundMetric(after.totalMs - before.totalMs),
        avgMs: roundMetric(after.avgMs - before.avgMs),
        maxMs: roundMetric(after.maxMs - before.maxMs),
        slowCount: after.slowCount - before.slowCount,
      },
    };
  });
  return {
    baselineSummaryCount: baseline?.summaryCount ?? 0,
    candidateSummaryCount: candidate?.summaryCount ?? 0,
    events,
  };
}

function formatNumber(value) {
  return String(roundMetric(value)).padStart(8, ' ');
}

export function formatSyncPerformanceReport(report, options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.trunc(options.limit) : report.events.length;
  const rows = report.events.slice(0, limit);
  const coverageCounts = report.metricCoverageCounts ?? { covered: 0, partial: 0, missing: 0 };
  const lines = [
    'Sync Performance Telemetry Report',
    `summaries=${report.summaryCount} events=${report.eventCount}`,
    `metricCoverage=covered:${coverageCounts.covered ?? 0} partial:${coverageCounts.partial ?? 0} missing:${coverageCounts.missing ?? 0}`,
    '',
    'maxMs    p99Ms     totalMs    avgMs     count slow event',
  ];
  for (const event of rows) {
    lines.push(`${formatNumber(event.maxMs)} ${formatNumber(event.p99Ms ?? 0)} ${formatNumber(event.totalMs)} ${formatNumber(event.avgMs)} ${String(event.count).padStart(7, ' ')} ${String(event.slowCount).padStart(4, ' ')} ${event.name}`);
  }
  if (Array.isArray(report.metricCoverage) && report.metricCoverage.length > 0) {
    lines.push('', 'Metric Coverage', 'status   metric events missing');
    for (const item of report.metricCoverage) {
      const eventNames = item.events.map((event) => event.name).join(',');
      const missingNames = item.missingEvents.length > 0 ? item.missingEvents.join(',') : '-';
      lines.push(`${String(item.status).padEnd(8, ' ')} ${item.id} ${eventNames || '-'} ${missingNames}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function formatComparisonReport(comparison, options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.trunc(options.limit) : comparison.events.length;
  const rows = comparison.events
    .slice()
    .sort((a, b) => Math.abs(b.delta.maxMs) - Math.abs(a.delta.maxMs) || a.name.localeCompare(b.name))
    .slice(0, limit);
  const lines = [
    'Sync Performance Telemetry Delta Report',
    `baselineSummaries=${comparison.baselineSummaryCount} candidateSummaries=${comparison.candidateSummaryCount}`,
    '',
    'deltaMax deltaTotal deltaAvg deltaSlow event',
  ];
  for (const event of rows) {
    lines.push(`${formatNumber(event.delta.maxMs)} ${formatNumber(event.delta.totalMs)} ${formatNumber(event.delta.avgMs)} ${String(event.delta.slowCount).padStart(9, ' ')} ${event.name}`);
  }
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const args = {
    files: [],
    baselineFiles: [],
    candidateFiles: [],
    json: false,
    top: null,
    sortKey: DEFAULT_SORT_KEY,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      args.json = true;
      continue;
    }
    if (arg === '--top') {
      args.top = Number.parseInt(argv[index + 1] ?? '', 10);
      index += 1;
      continue;
    }
    if (arg === '--sort') {
      args.sortKey = argv[index + 1] ?? DEFAULT_SORT_KEY;
      index += 1;
      continue;
    }
    if (arg === '--baseline') {
      args.baselineFiles.push(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--candidate') {
      args.candidateFiles.push(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    args.files.push(arg);
  }
  return args;
}

export async function readSyncPerformanceLogs(inputs) {
  const summaries = [];
  let matchedLines = 0;
  let malformedLines = 0;
  const files = discoverSyncPerformanceLogFiles(inputs);
  for (const file of files) {
    const parsed = parseSyncPerformanceLog(await readFile(file, 'utf8'));
    summaries.push(...parsed.summaries);
    matchedLines += parsed.matchedLines;
    malformedLines += parsed.malformedLines;
  }
  return { files, summaries, matchedLines, malformedLines };
}

function printUsage() {
  console.log([
    'Usage:',
    '  node apps/ui/scripts/syncPerformanceTelemetryReport.mjs [--json] [--top N] [--sort maxMs|totalMs|avgMs|slowCount|count] <log...>',
    '  node apps/ui/scripts/syncPerformanceTelemetryReport.mjs [--json] --baseline <log> --candidate <log>',
  ].join('\n'));
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    printUsage();
    return;
  }
  if (args.baselineFiles.length > 0 || args.candidateFiles.length > 0) {
    if (args.baselineFiles.length === 0 || args.candidateFiles.length === 0) {
      throw new Error('Both --baseline and --candidate are required for comparison mode');
    }
    const baselineLogs = await readSyncPerformanceLogs(args.baselineFiles);
    const candidateLogs = await readSyncPerformanceLogs(args.candidateFiles);
    const baseline = summarizeSyncPerformanceSummaries(baselineLogs.summaries, { sortKey: args.sortKey });
    const candidate = summarizeSyncPerformanceSummaries(candidateLogs.summaries, { sortKey: args.sortKey });
    const comparison = compareSyncPerformanceReports({ baseline, candidate });
    if (args.json) {
      console.log(JSON.stringify({ baseline, candidate, comparison }, null, 2));
    } else {
      console.log(formatComparisonReport(comparison, { limit: args.top }));
    }
    return;
  }
  if (args.files.length === 0) {
    printUsage();
    return;
  }
  const logs = await readSyncPerformanceLogs(args.files);
  const report = summarizeSyncPerformanceSummaries(logs.summaries, { sortKey: args.sortKey });
  if (args.json) {
    console.log(JSON.stringify({ ...logs, ...report }, null, 2));
  } else {
    if (logs.malformedLines > 0) {
      console.error(`Ignored malformed [sync-perf] lines: ${logs.malformedLines}`);
    }
    console.log(formatSyncPerformanceReport(report, { limit: args.top }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).catch((error) => {
    console.error(error?.message ?? error);
    process.exit(1);
  });
}
