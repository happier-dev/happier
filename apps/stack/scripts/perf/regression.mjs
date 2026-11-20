import { backendProfileRolesForRun, compareRuns, isUnperturbedTimingRun } from './analysis.mjs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const countSignals = ['requests', 'renders', 'commits', 'storeNotifications', 'socketFrames', 'sqlStatements', 'encodedBytes'];
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const groupKey = run => JSON.stringify([run.journey, run.cache, run.captureMode, run.version, backendProfileRolesForRun(run)]);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const footprintMetrics = ['rssBytes', 'pssBytes', 'ussBytes', 'heapUsedBytes', 'cpuMs',
  'cpuMsPerMinute', 'voluntarySwitchesPerMinute'];

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
    ...(run.footprint ? { footprint: { ...Object.fromEntries(Object.entries(run.footprint.phases ?? {}).map(([phase, roles]) => [
      phase, Object.fromEntries(Object.entries(roles).map(([role, metrics]) => [
        role, Object.fromEntries(footprintMetrics.map(metric => [metric, metrics?.[metric] ?? null])),
      ])),
    ])), completedTurns: run.footprint.completedTurns } } : {}),
    socketEventsPerSecond: run.socketEventsPerSecond ?? null,
    trace: run.profiling?.trace?.summary ?? null, sampledAllocation: run.profiling?.heap?.summary ?? null,
    backend: Object.fromEntries(['server', 'daemon'].map(role => [role, {
      cpu: run.backendProfiles?.roles?.[role]?.cpu ?? null,
      metrics: run.backendProfiles?.roles?.[role]?.metrics ?? null,
    }])) }, '');
  return values;
}

const footprintCost = /^footprint\.(?:idle[013]|active3)\.[^.]+\.(?:[rpu]ssBytes|cpuMs(?:PerMinute)?)$/u;
const footprintGroup = run => JSON.stringify([groupKey(run), run.footprint.workload]);

function baselineFootprintSamples(pairs) {
  const groups = new Map();
  for (const { baseline } of pairs) {
    if (baseline?.status !== 'CAPTURED' || !baseline.footprint?.workload) continue;
    const key = footprintGroup(baseline);
    const metrics = groups.get(key) ?? new Map();
    for (const [metric, value] of Object.entries(diagnosticMetrics(baseline))) {
      if (!footprintCost.test(metric) || !finite(value)) continue;
      const samples = metrics.get(metric) ?? [];
      samples.push(value);
      metrics.set(metric, samples);
    }
    groups.set(key, metrics);
  }
  return groups;
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
  const footprintSamples = baselineFootprintSamples(pairs);
  if (!pairs.length) gaps.push('No paired captures');
  for (const [index, pair] of pairs.entries()) {
    const { baseline, candidate } = pair;
    const run = baseline ?? candidate;
    if (!baseline || !candidate) gaps.push(`Pair ${index} is missing a side; available observations have no paired delta`);
    if (!run) continue;
    const mode = run.captureMode;
    const beforeDiagnostics = baseline ? diagnosticMetrics(baseline) : {};
    const afterDiagnostics = candidate ? diagnosticMetrics(candidate) : {};
    const workload = baseline?.footprint?.workload;
    const sameFootprintWorkload = typeof workload === 'string' && workload.length > 0
      && workload === candidate?.footprint?.workload;
    if (baseline?.footprint || candidate?.footprint) {
      const reason = !sameFootprintWorkload ? 'unavailable for paired deltas (missing or incompatible workload)' : 'compatible workload';
      observations.push({ pair: index, journey: run.journey, cache: run.cache, mode, metric: 'footprint.workload',
        before: workload ? 'captured' : null, after: candidate?.footprint?.workload ? 'captured' : null, delta: null,
        note: reason, changedNotably: false, noisy: true, gating: false });
    }
    for (const metric of new Set([...Object.keys(beforeDiagnostics), ...Object.keys(afterDiagnostics)])) {
      const a = beforeDiagnostics[metric], b = afterDiagnostics[metric];
      const footprint = metric.startsWith('footprint.');
      const paired = finite(a) && finite(b) && (!footprint || sameFootprintWorkload);
      const delta = paired ? b - a : null;
      const cost = footprintCost.test(metric);
      const samples = cost && paired && baseline.status === 'CAPTURED' && candidate.status === 'CAPTURED'
        && groupKey(baseline) === groupKey(candidate) ? footprintSamples.get(footprintGroup(baseline))?.get(metric) : null;
      const noise = samples?.length >= 2 ? Math.max(...samples) - Math.min(...samples) : null;
      observations.push({ pair: index, journey: run.journey, cache: run.cache, mode, metric,
        before: a ?? null, after: b ?? null, delta,
        ...(cost ? { noise, note: 'baseline spread ' + (noise ?? 'unavailable') } : {}),
        changedNotably: cost ? noise !== null && delta > noise : paired && a !== b, noisy: true, gating: false });
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
  const changed = counts.some(row => row.mode === 'counts' && row.delta > 0) || timings.some(row => row.changedNotably) || heap.some(row => row.changedNotably) || observations.some(row => row.noise != null && row.changedNotably);
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
  // Expo names route chunks after their files: `[id]-<hash>.js`, `+not-found-<hash>.js`.
  if (!/^\/[\w.@/+()[\]-]+$/u.test(href) || href.includes('/../')) throw new Error(`Web export references a non-local asset: ${href}`);
  return href.slice(1);
};

/**
 * Every route of Expo Router's route context and the chunks it loads. Metro's
 * production web output keeps the context as getters
 * `"./(app)/index.tsx":{…get:()=>r(d[1])(d[N],d.paths)}` followed by the
 * module's dependency map `{"N":<moduleId>,…,"paths":{"<moduleId>":<path>}}`.
 * A path is the route's chunk, or `[prerequisite…, chunk]` when the chunk needs
 * the shared `__common` chunk first (patches/@expo__metro-config: common is no
 * longer an index.html script). A synchronous route (no `.paths` argument) is
 * inside the entry and loads no file.
 * @returns {Map<string, { files: string[], shared: string[] }>}
 */
function resolveRouteChunks(entrySources) {
  for (const source of entrySources) {
    const at = source.indexOf(`"${HOME_ROUTE_FILES[0]}":{`);
    if (at < 0) continue;
    // The route context module's dependency map follows its factory.
    const pathsAt = source.indexOf('"paths":{', at);
    const mapStart = source.lastIndexOf(',{"0":', pathsAt) + 1;
    if (pathsAt < 0 || mapStart <= at) throw new Error('The route context has no readable dependency map');
    let depth = 0, end = mapStart;
    for (; end < source.length; end++) {
      if (source[end] === '{') depth++;
      else if (source[end] === '}' && --depth === 0) break;
    }
    const map = JSON.parse(source.slice(mapStart, end + 1));
    const routes = new Map();
    // Keys are in Expo's order (`./(app)/…` before `./_layout.tsx`): read the whole factory.
    const factoryStart = source.lastIndexOf('__d(', at);
    for (const [, key, getter] of source.slice(factoryStart, mapStart).matchAll(/"(\.\/[^"]+)":\{[^{}]*?get:\(\)=>([^{}]*)\}/gu)) {
      const async = getter.match(/\((\w+)\[(\d+)\],\1\.paths\)/u);
      if (!async) { routes.set(key, { files: [], shared: [] }); continue; }
      const path = map.paths?.[map[async[2]]];
      const chain = typeof path === 'string' ? [path] : Array.isArray(path) && path.length && path.every(item => typeof item === 'string') ? path : null;
      if (!chain) throw new Error(`Route ${key} does not resolve to an emitted chunk`);
      routes.set(key, { files: [exportPath(chain.at(-1))], shared: chain.slice(0, -1).map(exportPath) });
    }
    for (const key of HOME_ROUTE_FILES) if (!routes.has(key)) throw new Error(`Home route ${key} is not in the route context`);
    return routes;
  }
  throw new Error(`Home route ${HOME_ROUTE_FILES[0]} is not in the entry scripts`);
}

/**
 * Deterministic weight of what loads before Home on web: index.html's scripts
 * and stylesheets, the shared chunks the Home route chunks require first, and
 * the Home route chunks. Modules are Metro `__d(` definitions. Served bytes are
 * the precompression owner's brotli sidecar, or the raw file when no smaller
 * sidecar was written; an export that was never precompressed has no
 * served-bytes figure. `routes` gives every route its own chunk weight and the
 * shared chunks it needs first (each shared chunk is weighed once, in `files`
 * when Home needs it).
 */
export async function readWebBootWeight(root) {
  const html = await readFile(join(root, 'index.html'), 'utf8');
  const styles = [...html.matchAll(/<link\b[^>]*>/gu)].map(([tag]) => tag)
    .filter(tag => /\brel="stylesheet"/u.test(tag)).map(tag => tag.match(/\bhref="([^"]+)"/u)?.[1]).filter(Boolean).map(exportPath);
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+\.js)"/gu)].map(match => exportPath(match[1]));
  if (!scripts.length) throw new Error('Web export index.html has no entry scripts');
  const precompressed = (await readdir(join(root, '_expo/static'), { recursive: true }).catch(() => [])).some(name => name.endsWith('.br'));
  const weights = new Map();
  const weigh = async file => {
    if (!weights.has(file)) {
      const bytes = (await stat(join(root, file))).size;
      const brotliBytes = precompressed ? await stat(join(root, `${file}.br`)).then(info => info.size, () => bytes) : null;
      const modules = file.endsWith('.js') ? (await readFile(join(root, file), 'utf8')).split('__d(').length - 1 : 0;
      weights.set(file, { bytes, brotliBytes, modules });
    }
    return weights.get(file);
  };
  const routeChunks = resolveRouteChunks(await Promise.all(scripts.map(file => readFile(join(root, file), 'utf8'))));
  const home = HOME_ROUTE_FILES.map(key => routeChunks.get(key));
  const files = [];
  const listed = new Set();
  for (const [kind, list] of [['style', styles], ['script', scripts], ['shared', home.flatMap(route => route.shared)], ['route', home.flatMap(route => route.files)]]) {
    for (const file of list) {
      if (listed.has(file)) continue;
      listed.add(file);
      files.push({ file, kind, ...await weigh(file) });
    }
  }
  const routes = {};
  for (const [key, { files: own, shared }] of routeChunks) {
    const rows = await Promise.all(own.map(weigh));
    const sum = name => rows.reduce((total, row) => total + row[name], 0);
    routes[key] = { files: own, shared, bytes: sum('bytes'), brotliBytes: precompressed ? sum('brotliBytes') : null, modules: sum('modules') };
  }
  const sum = key => files.reduce((total, row) => total + row[key], 0);
  return { files, modules: sum('modules'), bytes: sum('bytes'), brotliBytes: precompressed ? sum('brotliBytes') : null, routes };
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
  for (const row of report.observations ?? []) lines.push(`| ${row.journey}/${row.cache}/${row.mode} | ${row.metric} | ${row.before ?? 'unavailable'} | ${row.after ?? 'unavailable'} | ${row.delta ?? 'unavailable'} | ${row.note ? `${row.note}; ` : ''}${row.changedNotably ? 'Changed notably; ' : ''}noisy, informational |`);
  for (const row of report.comparison ?? []) for (const percentile of ['p50Ms', 'p95Ms']) lines.push(`| ${row.journey}/${row.cache}/${row.captureMode} | ${percentile} | ${row.beforeTiming?.[percentile] ?? 'unavailable'} | ${row.afterTiming?.[percentile] ?? 'unavailable'} | ${row.beforeTiming && row.afterTiming ? row.afterTiming[percentile] - row.beforeTiming[percentile] : 'unavailable'} | noisy, informational |`);
  for (const row of report.timings ?? []) lines.push(`| ${row.group.join('/')} | paired timing ratio | 1 | ${row.pairedRatio} | ${row.pairedRatio - 1} | ${row.changedNotably ? 'Changed notably; ' : ''}baseline noise ratio ${row.noiseRatio} |`);
  for (const row of report.heap ?? []) lines.push(`| pair ${row.pair} | post-GC bytes/cycle | ${row.baselineBytesPerCycle ?? 'unavailable'} | ${row.candidateBytesPerCycle ?? 'unavailable'} | ${row.delta ?? 'unavailable'} | ${row.changedNotably ? 'Changed notably; ' : ''}baseline noise ${row.noiseBytesPerCycle ?? 'unavailable'} bytes/cycle; noisy, informational |`);
  if (report.bundleSize) lines.push(`| production UI | emitted JS/CSS bytes | ${report.bundleSize.baseline?.bytes ?? 'unavailable'} | ${report.bundleSize.candidate?.bytes ?? 'unavailable'} | ${report.bundleSize.deltaBytes ?? 'unavailable'} | ${report.bundleSize.changedNotably ? 'Changed notably; ' : ''}informational pending stability proof |`);
  for (const row of report.bundleSize?.boot ?? []) lines.push(`| production UI | ${row.metric} | ${row.before ?? 'unavailable'} | ${row.after ?? 'unavailable'} | ${row.delta ?? 'unavailable'} | ${row.delta ? 'Changed; ' : ''}deterministic |`);
  for (const gap of report.gaps ?? []) lines.push('', `- Unavailable: ${gap}`);
  lines.push('', 'Profiles, raw captures and all available backend/process observations are retained beside this summary; see comparison.json and its bundle paths. No informational metric requires sign-off.', '');
  return lines.join('\n');
}
