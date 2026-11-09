// Read-only attribution of retained process traces/profiles. Bundled source
// membership is not a claim that every member was evaluated.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [root, bundleRoot] = process.argv.slice(2);
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const { outputs } = await readJson(join(bundleRoot, 'apps/cli/metafile.json'));
const emitted = Object.entries(outputs).map(([path, value]) => [path.replace(/^(?:\.\.\/)+/u, ''), value]);
const findOutput = url => emitted.find(([path]) => url.endsWith(path))?.[1];
const evaluated = coverage => (coverage ?? []).filter(script => script.functions.some(fn => (
  fn.ranges.some(range => range.count > 0)
))).map(script => script.url).filter(url => url && !url.startsWith('node:'));
const rows = [];
for (const key of process.argv.length > 4 ? process.argv.slice(4) : ['noop', 'help', 'security']) {
  const [runtime, command] = key.includes(':') ? key.split(':') : ['bundle', key];
  const trace = await readJson(join(root, `${runtime}-${command}-cpu-profile.json`));
  const profile = await readJson(join(root, `${runtime}-${command}.cpuprofile`));
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const parents = new Map(profile.nodes.flatMap(node => (node.children ?? []).map(child => [child, node.id])));
  const self = new Map();
  const inclusive = new Map();
  const firstRequest = trace.events.find(event => event.kind === 'http:request');
  const requestClockUs = firstRequest?.clockUs;
  if (requestClockUs !== undefined && !(requestClockUs >= profile.startTime && requestClockUs <= profile.endTime)) {
    throw new Error('Request and CPU profile clocks do not align');
  }
  const cpuScope = requestClockUs === undefined ? 'whole-process' : 'before-first-request';
  let sampleClockUs = profile.startTime;
  for (let i = 0; i < profile.samples.length; i++) {
    let node = nodes.get(profile.samples[i]);
    const sampleEndUs = sampleClockUs + profile.timeDeltas[i];
    const us = Math.max(0, Math.min(sampleEndUs, requestClockUs ?? Infinity) - sampleClockUs);
    sampleClockUs = sampleEndUs;
    if (us === 0) break;
    const key = `${node.callFrame.functionName || '<top-level>'} ${node.callFrame.url}`;
    self.set(key, (self.get(key) ?? 0) + us);
    const names = new Set();
    while (node) {
      const name = node.callFrame.functionName;
      if (/Registry|Contribut|Manifest|Catalog|Credentials|Configuration|Settings|parse|create.*Schema|Security/iu.test(name)) names.add(name);
      node = nodes.get(parents.get(node.id));
    }
    for (const name of names) inclusive.set(name, (inclusive.get(name) ?? 0) + us);
  }
  const byCost = map => [...map].sort((a, b) => b[1] - a[1]).slice(0, 24)
    .map(([name, us]) => ({ name, ms: us / 1000 }));
  const urls = [...new Set([...evaluated(trace.coverageAtFirstRequest), ...evaluated(trace.coverage)])];
  const compiled = urls.filter(url => url.includes(bundleRoot));
  const members = runtime === 'source' ? urls : [...new Set(compiled.flatMap(url => Object.entries(findOutput(url)?.inputs ?? {})
    .filter(([, data]) => data.bytesInOutput > 0).map(([path]) => path)))];
  const groups = Object.fromEntries([
    ['commandRegistry', /apps\/cli\/src\/cli\/(?:commandRegistry|pluginCommand|actions)/u],
    ['pluginCatalog', /apps\/cli\/src\/plugins\/projection/u],
    ['protocol', /(?:packages\/protocol\/|node_modules\/@happier-dev\/protocol\/)/u],
    ['agentCatalog', /(?:apps\/cli\/src\/agent\/catalog|packages\/agents\/)/u],
    ['providerCatalog', /apps\/cli\/src\/providers\//u],
    ['executablePlugins', /(?:packages\/plugins\/|node_modules\/@happier-dev\/plugins-)/u],
  ].map(([name, pattern]) => [name, members.filter(path => pattern.test(path))]));
  const preRequestCalls = Object.fromEntries([
    'Configuration', 'readSettings', 'readStoredCredentials', 'resolveCliApiToken',
    'validateCliApiTokenEnvironment', 'applyServerSelectionFromArgs',
    'fetchServerFeaturesSnapshot', 'observeServerFeaturesSnapshot',
    'readAccountSecurityRoute', 'readSelectedAccountSecurity',
  ].map(name => [name, (trace.coverageAtFirstRequest ?? []).reduce((total, script) => (
    total + script.functions.filter(fn => fn.functionName === name)
      .reduce((calls, fn) => calls + (fn.ranges[0]?.count ?? 0), 0)
  ), 0)]));
  function summarizeHomeIo(events) {
    const summary = { existenceProbes: 0, existenceMs: 0, contentReads: 0, contentReadMs: 0 };
    const ioStarts = new Map();
    for (const event of events) {
      if (['existsSync', 'statSync', 'accessSync', 'stat:start', 'access:start', 'readFileSync', 'readFile:start'].includes(event.kind)) {
        const kind = event.kind.endsWith(':start') ? event.kind.slice(0, -6) : event.kind;
        ioStarts.set(`${kind}:${event.path}`, event.ms);
        if (!kind.startsWith('readFile')) summary.existenceProbes++;
        else summary.contentReads++;
      } else if (['existsSync:end', 'statSync:end', 'accessSync:end', 'stat:end', 'access:end', 'readFileSync:end', 'readFile:end'].includes(event.kind)) {
        const kind = event.kind.slice(0, -4);
        const start = ioStarts.get(`${kind}:${event.path}`);
        if (start !== undefined) {
          if (!kind.startsWith('readFile')) summary.existenceMs += event.ms - start;
          else summary.contentReadMs += event.ms - start;
        }
      }
    }
    return summary;
  }
  const homeFileIo = summarizeHomeIo(trace.events);
  const preRequestHomeFileIo = firstRequest
    ? summarizeHomeIo(trace.events.filter(event => event.ms <= firstRequest.ms)) : null;
  // Coarse asynchronous phases overlap module work and IO. Preserve intervals
  // rather than adding inclusive wall durations into a fictional partition.
  const beforeFirstRequestPhaseSpans = (trace.phaseSpans ?? [])
    .filter(span => firstRequest === undefined || span.start < firstRequest.ms)
    .map(span => ({ ...span, observedEnd: span.end,
      end: Math.min(span.end, firstRequest?.ms ?? Infinity),
      inFlightAtFirstRequest: firstRequest !== undefined && span.end > firstRequest.ms }));
  const row = { runtime, command, evaluatedScriptCount: urls.length, evaluatedBundleChunkCount: compiled.length,
    beforeFirstRequestEvaluated: evaluated(trace.coverageAtFirstRequest).length,
    homeFileIo, preRequestHomeFileIo, beforeFirstRequestPhaseSpans, cpuScope,
    dnsLookups: trace.events.filter(event => event.kind === 'dns:lookup').length,
    preRequestCalls,
    milestones: trace.events.filter(event => ['preload', 'existsSync', 'existsSync:end', 'readFileSync', 'readFileSync:end',
      'readFile:start', 'readFile:end', 'dns:lookup', 'dns:lookup:end', 'http:request', 'socket:start', 'socket:connected', 'exit'].includes(event.kind)),
    topSelfCpu: byCost(self), inclusiveNamedFunctions: byCost(inclusive),
    evaluatedChunks: compiled, bundledSourceMembership: groups };
  rows.push(row);
  console.log(JSON.stringify({ runtime, command, evaluatedScriptCount: urls.length, evaluatedBundleChunkCount: compiled.length,
    beforeFirstRequestEvaluated: row.beforeFirstRequestEvaluated,
    homeFileIo, preRequestHomeFileIo, cpuScope,
    dnsLookups: row.dnsLookups,
    preRequestCalls,
    topSelfCpu: row.topSelfCpu.slice(0, 7), inclusiveNamedFunctions: row.inclusiveNamedFunctions.slice(0, 10),
    milestones: row.milestones.filter(event => ['preload', 'http:request', 'socket:start', 'socket:connected', 'exit'].includes(event.kind)),
    bundledSourceMembership: Object.fromEntries(Object.entries(groups).map(([key, values]) => [key, values.length])),
    artifact: join(root, 'attribution.json') }));
}
await writeFile(join(root, 'attribution.json'), JSON.stringify(rows, null, 2));
