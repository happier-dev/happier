import { backendProfileRolesForRun, compareRuns, isUnperturbedTimingRun } from './analysis.mjs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const countSignals = ['requests', 'renders', 'commits', 'storeNotifications', 'socketFrames', 'sqlStatements', 'encodedBytes'];
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const groupKey = run => JSON.stringify([run.journey, run.cache, run.captureMode, run.version, backendProfileRolesForRun(run)]);
const finite = value => typeof value === 'number' && Number.isFinite(value);

function diagnosticMetrics(run) {
  const values = {};
  const visit = (value, key) => {
    if (finite(value) || value === null) values[key] = value;
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [name, child] of Object.entries(value)) {
        if (!['startMs', 'endMs', 'atMs'].includes(name)) visit(child, key ? `${key}.${name}` : name);
      }
    }
  };
  visit({ durationMs: run.durationMs ?? null,
    process: { server: run.processWindow?.server ?? null, daemon: run.processWindow?.daemon ?? null },
    socketEventsPerSecond: run.socketEventsPerSecond ?? null,
    trace: run.profiling?.trace?.summary ?? null, sampledAllocation: run.profiling?.heap?.summary ?? null,
    backend: Object.fromEntries(['server', 'daemon'].map(role => [role, {
      cpu: run.backendProfiles?.roles?.[role]?.cpu ?? null,
      metrics: run.backendProfiles?.roles?.[role]?.metrics ?? null,
    }])) }, '');
  return values;
}

function heapSlope(heap) {
  const rows = heap?.samples;
  if (!Array.isArray(rows) || rows.length < 3 || rows.some(row => row.forcedGc !== true || !finite(row.cycle) || !finite(row.usedBytes))) return null;
  if (new Set(rows.map(row => row.cycle)).size !== rows.length) return null;
  const x = rows.reduce((sum, row) => sum + row.cycle, 0) / rows.length;
  const y = rows.reduce((sum, row) => sum + row.usedBytes, 0) / rows.length;
  const denominator = rows.reduce((sum, row) => sum + (row.cycle - x) ** 2, 0);
  const slope = rows.reduce((sum, row) => sum + (row.cycle - x) * (row.usedBytes - y), 0) / denominator;
  const residuals = rows.map(row => row.usedBytes - y - slope * (row.cycle - x));
  const residualRange = Math.max(...residuals) - Math.min(...residuals);
  return { slope, noise: residualRange * rows.reduce((sum, row) => sum + Math.abs(row.cycle - x), 0) / denominator };
}

// Keep observations separate from admission. These comparison signals have not
// earned a 10/10 runner stability proof; existing tier-1 tests own CI gating.
export function assessRegressionPairs(pairs, { requiredCounts = countSignals } = {}) {
  const counts = [], timings = [], heap = [], observations = [], gaps = [], groups = new Map();
  if (!pairs.length) gaps.push('No paired captures');
  for (const [index, pair] of pairs.entries()) {
    const { baseline, candidate } = pair;
    const run = baseline ?? candidate;
    if (!baseline || !candidate) gaps.push(`Pair ${index} is missing a side; available observations have no paired delta`);
    if (!run) continue;
    const mode = run.captureMode;
    const beforeDiagnostics = baseline ? diagnosticMetrics(baseline) : {};
    const afterDiagnostics = candidate ? diagnosticMetrics(candidate) : {};
    for (const metric of new Set([...Object.keys(beforeDiagnostics), ...Object.keys(afterDiagnostics)])) {
      const a = beforeDiagnostics[metric], b = afterDiagnostics[metric];
      observations.push({ pair: index, journey: run.journey, cache: run.cache, mode, metric,
        before: a ?? null, after: b ?? null, delta: finite(a) && finite(b) ? b - a : null,
        changedNotably: finite(a) && finite(b) && a !== b, noisy: true, gating: false });
    }
    if (baseline && candidate) {
      const group = groupKey(baseline);
      const rows = groups.get(group) ?? [];
      rows.push(pair); groups.set(group, rows);
      if (group !== groupKey(candidate) || baseline.uiMode !== 'export' || candidate.uiMode !== 'export'
        || baseline.status !== 'CAPTURED' || candidate.status !== 'CAPTURED'
        || (!pair.historical && (!baseline.hostBefore?.host || baseline.hostBefore.host !== candidate.hostBefore?.host))
        || baseline.instrumentation?.profiling === true || candidate.instrumentation?.profiling === true
        || !['counts', 'timing'].includes(mode)
        || [baseline, candidate].some(run => run.instrumentation?.storeTelemetry !== (mode === 'counts') || run.instrumentation?.fiberHook !== (mode === 'counts'))) {
        gaps.push(`Pair ${index}: unmatched host, capture, schema or instrumentation`);
      }
    }
    // Show every captured counter, including unavailable and noisy counters.
    const metrics = new Set([...Object.keys(baseline?.counts ?? {}), ...Object.keys(candidate?.counts ?? {}), ...(mode === 'counts' ? requiredCounts : [])]);
    for (const metric of metrics) {
      const a = baseline?.counts?.[metric], b = candidate?.counts?.[metric];
      const available = finite(a) && finite(b) && a >= 0 && b >= 0;
      if (mode === 'counts' && requiredCounts.includes(metric) && !available) gaps.push(`Pair ${index}: ${metric} unavailable`);
      counts.push({ pair: index, journey: run.journey, cache: run.cache, mode, metric,
        before: finite(a) ? a : null, after: finite(b) ? b : null, delta: available ? b - a : null,
        changedNotably: available && a !== b, noisy: true, gating: false });
    }
    if (baseline?.heap || candidate?.heap) {
      const a = heapSlope(baseline?.heap), b = heapSlope(candidate?.heap);
      if (!a || !b) gaps.push(`Pair ${index}: post-GC heap cycles unavailable`);
      heap.push({ pair: index, baselineBytesPerCycle: a?.slope ?? null, candidateBytesPerCycle: b?.slope ?? null,
        delta: a && b ? b.slope - a.slope : null, noiseBytesPerCycle: a?.noise ?? null,
        changedNotably: Boolean(a && b && b.slope > 0 && b.slope > a.slope + a.noise), noisy: true, gating: false });
    }
  }
  for (const [group, pairs] of groups) {
    if (pairs[0].baseline.captureMode !== 'timing') continue;
    if (pairs.some(pair => pair.historical)) {
      gaps.push(`${group}: historical captures are not paired same-host timings`); continue;
    }
    if (!pairs.every(pair => [pair.baseline, pair.candidate].every(isUnperturbedTimingRun))) {
      gaps.push(`${group}: instrumented or ineligible paired timing`); continue;
    }
    const valid = pairs.length >= 5 && pairs.every(pair => [pair.baseline, pair.candidate].every(run => finite(run.durationMs) && run.durationMs > 0));
    if (!valid) { gaps.push(`${group}: fewer than five valid timing pairs`); continue; }
    const baseline = pairs.map(pair => pair.baseline.durationMs);
    const noiseRatio = Math.max(...baseline) / Math.min(...baseline);
    const pairedRatio = median(pairs.map(pair => pair.candidate.durationMs / pair.baseline.durationMs));
    timings.push({ group: JSON.parse(group), pairs: pairs.length, pairedRatio, noiseRatio,
      changedNotably: pairedRatio > noiseRatio, noisy: true, gating: false });
  }
  const changed = counts.some(row => row.mode === 'counts' && row.delta > 0) || timings.some(row => row.changedNotably) || heap.some(row => row.changedNotably);
  return { status: gaps.length ? 'BLOCKED' : counts.some(row => row.mode === 'counts' && row.delta > 0) ? 'FAIL' : changed ? 'ALERT' : 'PASS',
    policy: 'Informational comparison; only independently proven tier-1 contract tests gate CI. BLOCKED/FAIL describe observations, not release admission.',
    comparison: compareRuns(pairs.filter(p => p.baseline).map(p => p.baseline), pairs.filter(p => p.candidate).map(p => p.candidate)),
    counts, timings, heap, observations, gaps };
}

export async function readProductionBundleSize(root) {
  await stat(join(root, 'index.html'));
  const files = [];
  const visit = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /\.(?:[cm]?js|css|bundle)$/.test(entry.name)) files.push({ path: relative(root, path), bytes: (await stat(path)).size });
    }
  };
  await visit(root);
  if (!files.length) throw new Error('No production UI JavaScript/CSS assets found');
  return { bytes: files.reduce((sum, row) => sum + row.bytes, 0), files };
}

// Expo Router's root layout, the app layout and the Home page: what the browser
// downloads and evaluates before Home can render. Other routes load on demand.
const HOME_ROUTE_FILES = ['./_layout.tsx', './(app)/_layout.tsx', './(app)/index.tsx'];
const exportPath = href => {
  if (!/^\/[\w.@/-]+$/u.test(href) || href.includes('/../')) throw new Error(`Web export references a non-local asset: ${href}`);
  return href.slice(1);
};
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * Find the chunk each Home route loads. Metro's production web output keeps
 * the route context as getters `"./(app)/index.tsx":{…get:()=>r(d[1])(d[N],d.paths)}`
 * and the module's dependency map `{"N":<moduleId>,…,"paths":{"<moduleId>":"/_expo/…js"}}`.
 * A synchronous route (no `.paths` argument) is already inside the entry.
 */
function resolveHomeRouteChunks(entrySources) {
  const chunks = new Map();
  for (const key of HOME_ROUTE_FILES) {
    let resolved = false;
    for (const source of entrySources) {
      const at = source.indexOf(`"${key}":{`);
      if (at < 0) continue;
      const getter = source.slice(at, at + 400).match(new RegExp(`^"${escapeRegExp(key)}":\\{[^}]*?\\((\\w+)\\[(\\d+)\\],\\1\\.paths\\)`, 'u'));
      if (!getter) { resolved = true; break; }
      // The route context module's dependency map follows its factory.
      const pathsAt = source.indexOf('"paths":{', at);
      const mapStart = source.lastIndexOf(',{"0":', pathsAt) + 1;
      if (pathsAt < 0 || mapStart <= at) throw new Error(`Home route ${key} has no readable dependency map`);
      let depth = 0, end = mapStart;
      for (; end < source.length; end++) {
        if (source[end] === '{') depth++;
        else if (source[end] === '}' && --depth === 0) break;
      }
      const map = JSON.parse(source.slice(mapStart, end + 1));
      const chunk = map.paths?.[map[getter[2]]];
      if (typeof chunk !== 'string') throw new Error(`Home route ${key} does not resolve to an emitted chunk`);
      chunks.set(key, exportPath(chunk));
      resolved = true;
      break;
    }
    if (!resolved) throw new Error(`Home route ${key} is not in the entry scripts`);
  }
  return chunks;
}

/**
 * Deterministic weight of what loads before Home on web: index.html's scripts
 * and stylesheets plus the Home route chunks. Modules are Metro `__d(`
 * definitions. Served bytes are the precompression owner's brotli sidecar, or
 * the raw file when no smaller sidecar was written; an export that was never
 * precompressed has no served-bytes figure.
 */
export async function readWebBootWeight(root) {
  const html = await readFile(join(root, 'index.html'), 'utf8');
  const styles = [...html.matchAll(/<link\b[^>]*>/gu)].map(([tag]) => tag)
    .filter(tag => /\brel="stylesheet"/u.test(tag)).map(tag => tag.match(/\bhref="([^"]+)"/u)?.[1]).filter(Boolean).map(exportPath);
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+\.js)"/gu)].map(match => exportPath(match[1]));
  if (!scripts.length) throw new Error('Web export index.html has no entry scripts');
  const sources = new Map();
  for (const file of scripts) sources.set(file, await readFile(join(root, file), 'utf8'));
  const routes = [...new Set(resolveHomeRouteChunks([...sources.values()]).values())];
  for (const file of routes) sources.set(file, await readFile(join(root, file), 'utf8'));
  const precompressed = (await readdir(join(root, '_expo/static'), { recursive: true }).catch(() => [])).some(name => name.endsWith('.br'));
  const files = [];
  for (const [kind, list] of [['style', styles], ['script', scripts], ['route', routes]]) {
    for (const file of list) {
      const bytes = (await stat(join(root, file))).size;
      const sidecar = precompressed ? await stat(join(root, `${file}.br`)).then(info => info.size, () => bytes) : null;
      files.push({ file, kind, bytes, brotliBytes: sidecar, modules: sources.get(file)?.split('__d(').length - 1 || 0 });
    }
  }
  const sum = key => files.reduce((total, row) => total + row[key], 0);
  return { files, modules: sum('modules'), bytes: sum('bytes'), brotliBytes: precompressed ? sum('brotliBytes') : null };
}

const BOOT_METRICS = [['modules', 'modules before Home'], ['bytes', 'JS/CSS bytes before Home'], ['brotliBytes', 'brotli transfer bytes before Home']];

export function assessBundleBudget(baseline, candidate) {
  const available = finite(baseline?.bytes) && finite(candidate?.bytes);
  const boot = candidate?.boot || baseline?.boot ? BOOT_METRICS.map(([key, metric]) => {
    const before = baseline?.boot?.[key], after = candidate?.boot?.[key];
    const paired = finite(before) && finite(after);
    return { metric, before: finite(before) ? before : null, after: finite(after) ? after : null, delta: paired ? after - before : null };
  }) : [];
  const grew = (available && candidate.bytes > baseline.bytes) || boot.some(row => row.delta > 0);
  return { status: !available ? 'UNAVAILABLE' : grew ? 'FAIL' : 'PASS', baseline, candidate,
    deltaBytes: available ? candidate.bytes - baseline.bytes : null, changedNotably: available && candidate.bytes !== baseline.bytes, gating: false,
    boot,
    budget: 'This run\'s baseline emitted JS/CSS bytes; zero noise margin; update by selecting a reviewed baseline ref, never by weekly snapshot editing.' };
}

export function renderPerfComparison(report) {
  const lines = ['# Performance comparison', '', `Status: ${report.status}. Informational; stable tier-1 contracts gate in their existing test jobs.`, ''];
  if (report.error) lines.push(`Collection unavailable: ${report.error}`, '');
  if (report.baselineComparison) lines.push(`Baseline comparison: ${report.baselineComparison.status}; source ${report.baselineComparison.expectedSha}. ${report.baselineComparison.reason ?? ''}`, '');
  for (const [side, source] of Object.entries(report.sources ?? {})) lines.push(`${side} source: ${source.sha ?? 'unavailable'}; dirty: ${source.dirty ?? 'unavailable'}.`, '');
  if (report.elapsedMs !== undefined) lines.push(`Added job wall-clock: ${(report.elapsedMs / 1000).toFixed(2)} seconds.`, '');
  lines.push('| Journey/cache/mode | Metric | Baseline | Candidate | Delta | Observation |', '| --- | --- | ---: | ---: | ---: | --- |');
  for (const row of report.counts ?? []) lines.push(`| ${row.journey}/${row.cache}/${row.mode} | ${row.metric} | ${row.before ?? 'unavailable'} | ${row.after ?? 'unavailable'} | ${row.delta ?? 'unavailable'} | ${row.changedNotably ? 'Changed notably; ' : ''}noisy, informational |`);
  for (const row of report.observations ?? []) lines.push(`| ${row.journey}/${row.cache}/${row.mode} | ${row.metric} | ${row.before ?? 'unavailable'} | ${row.after ?? 'unavailable'} | ${row.delta ?? 'unavailable'} | ${row.changedNotably ? 'Changed notably; ' : ''}noisy, informational |`);
  for (const row of report.comparison ?? []) for (const percentile of ['p50Ms', 'p95Ms']) lines.push(`| ${row.journey}/${row.cache}/${row.captureMode} | ${percentile} | ${row.beforeTiming?.[percentile] ?? 'unavailable'} | ${row.afterTiming?.[percentile] ?? 'unavailable'} | ${row.beforeTiming && row.afterTiming ? row.afterTiming[percentile] - row.beforeTiming[percentile] : 'unavailable'} | noisy, informational |`);
  for (const row of report.timings ?? []) lines.push(`| ${row.group.join('/')} | paired timing ratio | 1 | ${row.pairedRatio} | ${row.pairedRatio - 1} | ${row.changedNotably ? 'Changed notably; ' : ''}baseline noise ratio ${row.noiseRatio} |`);
  for (const row of report.heap ?? []) lines.push(`| pair ${row.pair} | post-GC bytes/cycle | ${row.baselineBytesPerCycle ?? 'unavailable'} | ${row.candidateBytesPerCycle ?? 'unavailable'} | ${row.delta ?? 'unavailable'} | ${row.changedNotably ? 'Changed notably; ' : ''}baseline noise ${row.noiseBytesPerCycle ?? 'unavailable'} bytes/cycle; noisy, informational |`);
  if (report.bundleSize) lines.push(`| production UI | emitted JS/CSS bytes | ${report.bundleSize.baseline?.bytes ?? 'unavailable'} | ${report.bundleSize.candidate?.bytes ?? 'unavailable'} | ${report.bundleSize.deltaBytes ?? 'unavailable'} | ${report.bundleSize.changedNotably ? 'Changed notably; ' : ''}informational pending stability proof |`);
  for (const row of report.bundleSize?.boot ?? []) lines.push(`| production UI | ${row.metric} | ${row.before ?? 'unavailable'} | ${row.after ?? 'unavailable'} | ${row.delta ?? 'unavailable'} | ${row.delta ? 'Changed; ' : ''}deterministic |`);
  for (const gap of report.gaps ?? []) lines.push('', `- Unavailable: ${gap}`);
  lines.push('', 'Profiles, raw captures and all available backend/process observations are retained beside this summary; see comparison.json and its bundle paths. No informational metric requires sign-off.', '');
  return lines.join('\n');
}
