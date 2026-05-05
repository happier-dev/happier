#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const SYNC_PERF_MARKER = '[sync-perf]';
const DEFAULT_SORT_KEY = 'maxMs';

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
          fields: mergeFields({}, event.fields),
          fieldStats: mergeFieldStats({}, event.fieldStats),
        });
    }
  }

  const events = Array.from(eventsByName.values())
    .map((event) => ({
      ...event,
      totalMs: roundMetric(event.totalMs),
      avgMs: roundMetric(event.count > 0 ? event.totalMs / event.count : 0),
      minMs: roundMetric(event.minMs),
      maxMs: roundMetric(event.maxMs),
    }))
    .sort((a, b) => {
      const aValue = isFiniteNumber(a[sortKey]) ? a[sortKey] : 0;
      const bValue = isFiniteNumber(b[sortKey]) ? b[sortKey] : 0;
      if (bValue !== aValue) return bValue - aValue;
      return a.name.localeCompare(b.name);
    });

  return {
    summaryCount: Array.isArray(summaries) ? summaries.length : 0,
    eventCount: events.length,
    events,
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
  const lines = [
    'Sync Performance Telemetry Report',
    `summaries=${report.summaryCount} events=${report.eventCount}`,
    '',
    'maxMs    totalMs    avgMs     count slow event',
  ];
  for (const event of rows) {
    lines.push(`${formatNumber(event.maxMs)} ${formatNumber(event.totalMs)} ${formatNumber(event.avgMs)} ${String(event.count).padStart(7, ' ')} ${String(event.slowCount).padStart(4, ' ')} ${event.name}`);
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

async function readLogs(files) {
  const summaries = [];
  let matchedLines = 0;
  let malformedLines = 0;
  for (const file of files) {
    const parsed = parseSyncPerformanceLog(await readFile(file, 'utf8'));
    summaries.push(...parsed.summaries);
    matchedLines += parsed.matchedLines;
    malformedLines += parsed.malformedLines;
  }
  return { summaries, matchedLines, malformedLines };
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
    const baselineLogs = await readLogs(args.baselineFiles);
    const candidateLogs = await readLogs(args.candidateFiles);
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
  const logs = await readLogs(args.files);
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
