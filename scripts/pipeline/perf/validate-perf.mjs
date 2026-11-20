import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
export async function loadPerfBaselineResults(directory, expectedSha) {
  const root = await realpath(directory);
  const report = JSON.parse(await readFile(join(root, 'comparison.json'), 'utf8'));
  if (!/^[a-f0-9]{40}$/.test(expectedSha) || report.sources?.candidate?.sha !== expectedSha || report.sources.candidate.dirty !== false) {
    throw new Error('Baseline results must identify the exact clean base SHA');
  }
  if (!Array.isArray(report.bundles)) throw new Error('Baseline results have no canonical bundle index');
  const bundles = new Map();
  for (const row of report.bundles.filter(row => row.side === 'candidate')) {
    const scenario = journeys.find(scenario => scenario.journey === row.journey && scenario.cache === row.cache);
    if (!scenario || !['counts', 'timing'].includes(row.mode) || !Number.isSafeInteger(row.repeat) || row.repeat < 0
      || row.pairId !== `${row.journey}-${row.cache}-${row.mode}-${row.repeat}`
      || row.directory !== `runs/${row.pairId}/candidate` || bundles.has(row.pairId)) throw new Error('Invalid baseline bundle identity/path');
    const path = await realpath(join(root, row.directory, 'bundle.json'));
    if (relative(root, path).split(sep).join('/') !== `${row.directory}/bundle.json`) throw new Error('Baseline bundle escapes its artifact directory');
    const bundle = JSON.parse(await readFile(path, 'utf8'));
    if (!Number.isSafeInteger(bundle.version) || bundle.version <= 0 || bundle.journey !== row.journey || bundle.cache !== row.cache
      || bundle.captureMode !== row.mode || !['CAPTURED', 'INCOMPLETE', 'FAILED'].includes(bundle.status)
      || !bundle.counts || typeof bundle.counts !== 'object' || Array.isArray(bundle.counts)
      || Object.values(bundle.counts).some(value => value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0))) {
      throw new Error('Invalid baseline capture/measurement schema');
    }
    bundles.set(row.pairId, bundle);
  }
  const size = report.bundleSize?.candidate;
  if (size !== undefined && (!Number.isSafeInteger(size.bytes) || size.bytes < 0)) throw new Error('Invalid baseline bundle size');
  return { bundles, source: report.sources.candidate, bundleSize: size };
}
const journeys = [
  { journey: 'J1', cache: 'cold', question: 'How much work is required to restore into a populated Home?' },
  { journey: 'J1', cache: 'warm', question: 'Does an authenticated Home reload perform more work?' },
  { journey: 'J13', cache: 'warm', question: 'Does a settled Home create work with no named consumer?' },
  { journey: 'J4-stream', cache: 'warm', question: 'Does another Session streaming invalidate unrelated mounted content?' },
  { journey: 'J5', cache: 'warm', question: 'How much work is required to open New Session?' },
  { journey: 'J14', cache: 'warm', question: 'Does one approval settle its exact Inbox item?' },
  { journey: 'Stop', cache: 'warm', question: 'Does Stop reach and settle the actual Session lifecycle owner?' },
];

export function resolvePerfValidationPlan({ baselineRef, candidateRef, out, repeats = 5, profile = 'full', candidateOnly = false, baselineResultsDir } = {}) {
  if (typeof baselineRef !== 'string' || !baselineRef.trim() || baselineRef.startsWith('-')) throw new Error('An explicit --baseline-ref is required');
  if (candidateRef !== undefined && (!candidateRef.trim() || candidateRef.startsWith('-'))) throw new Error('Invalid candidate ref');
  if (!Number.isSafeInteger(repeats) || repeats < 5) throw new Error('At least five timing repeats are required by the capture owner');
  if (!['pr', 'full'].includes(profile)) throw new Error('--profile must be pr or full');
  if (candidateOnly && baselineResultsDir) throw new Error('--candidate-only and --baseline-results-dir are mutually exclusive');
  const selected = profile === 'pr' ? journeys.filter(row => row.journey === 'J1' && row.cache === 'warm' || row.journey === 'J4-stream') : journeys;
  const runs = [];
  for (const scenario of selected) for (const mode of profile === 'full' && scenario.journey === 'J1' ? ['counts', 'timing'] : ['counts']) {
    // Two complete J4 captures are the minimum that observes a base range.
    const captures = mode === 'timing' ? repeats : scenario.journey === 'J4-stream' ? 2 : 1;
    for (let repeat = 0; repeat < captures; repeat++) {
      const pairId = `${scenario.journey}-${scenario.cache}-${mode}-${repeat}`;
      // Alternate AB / BA on this process's host; separate jobs are not pairs.
      for (const side of repeat % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
        if (side === 'baseline' && (candidateOnly || baselineResultsDir)) continue;
        runs.push({ ...scenario, mode, repeat, pairId, side });
      }
    }
  }
  return { baselineRef, candidateRef: candidateRef ?? null, profile, repeats, candidateOnly, baselineResultsDir,
    out: resolve(out ?? join(repo, '.happier/qa/perf/PERFCI', `validation-${Date.now()}`)), runs,
    timingAndHeapPolicy: 'report-only; no release or CI gate',
    budgetPolicy: 'Counts and emitted JS/CSS bytes compare with this run\'s measured baseline; zero deterministic noise margin; update by selecting a reviewed baseline ref.' };
}

async function command(executable, args, { cwd = repo, signal, capture = false, env = process.env } = {}) {
  signal?.throwIfAborted();
  const child = spawn(executable, args, { cwd, env, stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'] });
  // The scenario process owns Docker/browser/daemon teardown. Forward the
  // interruption, then wait for its finally block and terminal close.
  const interrupt = () => child.kill('SIGINT');
  signal?.addEventListener('abort', interrupt, { once: true });
  let stdout = '';
  child.stdout?.on('data', bytes => { stdout += bytes; });
  try {
    await new Promise((accept, reject) => {
      child.once('error', reject);
      child.once('close', (code, childSignal) => code === 0 ? accept() : reject(new Error(`Performance subprocess failed (${childSignal ?? code}): ${executable}`)));
    });
  } finally { signal?.removeEventListener('abort', interrupt); }
  return stdout.trim();
}

export async function capturePerfSourceBasis({ source, captured, signal }) {
  // Capture authored inputs, then install privately; never mount a live tree.
  const { captureBuildInputFiles } = await import('../../workspaces/buildInputConvergence.mjs');
  const { readSourceComponentBuildInputs, readWorkspaceBuildInputs } = await import('../../../apps/stack/scripts/utils/fs/workspaceBuildInputs.mjs');
  const readPaths = async () => {
    signal?.throwIfAborted();
    const components = await Promise.all(['expo', 'daemon', 'server'].map(component => readSourceComponentBuildInputs({ repoDir: source, component })));
    const tests = 'packages/tests';
    return [...new Set([
      ...components.flatMap(component => component.files),
      ...readWorkspaceBuildInputs(join(source, tests), { additionalInputPaths: ['src/testkit', 'src/fixtures', 'baselines'] }).map(path => `${tests}/${path}`),
      ...readWorkspaceBuildInputs(source, { sourceRoots: [], additionalInputPaths: ['.github/feature-policy', 'patches', '.dockerignore',
        'apps/stack/bin', 'apps/ui/tools/postinstall', 'apps/cli/tools/archives', 'apps/cli/tools/licenses'] }),
    ])];
  };
  await captureBuildInputFiles({ sourceDir: source, captureDir: captured, readPaths });
  let sha = null, dirty = null;
  try {
    [sha, dirty] = await Promise.all([
      command('git', ['rev-parse', 'HEAD'], { cwd: source, capture: true, signal }),
      command('git', ['status', '--porcelain'], { cwd: source, capture: true, signal }).then(Boolean),
    ]);
  } catch {
    signal?.throwIfAborted();
    // Git-free mirrors use the same authored-input owner, but cannot attest
    // a clean SHA or produce a trusted baseline artifact.
    sha = null; dirty = null;
  }
  return { directory: captured, owned: true, sha, dirty };
}

async function withBasis({ ref, directory, label, scratch, signal }, consume) {
  if (directory || !ref) {
    return await consume(await capturePerfSourceBasis({ source: directory ? resolve(directory) : repo,
      captured: join(scratch, `${label}-source`), signal }));
  }
  const sha = await command('git', ['rev-parse', '--verify', `${ref}^{commit}`], { capture: true, signal });
  const { withDetachedWorktree } = await import('../../../apps/stack/scripts/utils/review/detached_worktree.mjs');
  return await withDetachedWorktree({ repoDir: repo, headCommit: sha, label,
    worktreesRoot: scratch, env: process.env }, directory => consume({ directory, owned: true, sha, dirty: false }));
}

export async function preparePerfSourceDependencies(side, sourceDir, signal, owned) {
  if (!owned) throw new Error(`${side} dependencies unavailable; only a private comparison tree can be prepared automatically`);
  // Exact Git worktrees omit the ignored Protocol compiler input. Derive it
  // from the selected side before the finite workspace publishers use it.
  const policyGenerator = join(sourceDir, 'packages/protocol/scripts/generate-embedded-feature-policies.mjs');
  if (existsSync(policyGenerator)) await command(process.execPath, [policyGenerator], { cwd: sourceDir, signal });
  if (!existsSync(join(sourceDir, 'node_modules'))) {
    // Only the detached comparison basis is ours to prepare. The canonical
    // installer selects its declared package manager and dependency inputs.
    // Never borrow candidate dependencies for a historical lockfile.
    const { ensureDepsInstalled } = await import('../../../apps/stack/scripts/utils/proc/pm.mjs');
    await ensureDepsInstalled(join(sourceDir, 'apps/ui'), `performance ${side}`, {
      prepareComponentOutputs: false, env: { ...process.env, CI: '1' },
    });
  }
  // Installation alone does not provide workspace JS exports. Prepare both
  // actual source consumers before exporting the UI or starting resources.
  const { ensureWorkspacePackagesBuiltForComponent } = await import('../../workspaces/ensureWorkspacePackagesBuilt.mjs');
  for (const component of ['packages/tests', 'apps/cli']) {
    signal?.throwIfAborted();
    await ensureWorkspacePackagesBuiltForComponent(join(sourceDir, component), {
      env: { ...process.env, CI: '1' }, signal, buildMode: 'strict',
    });
  }
  if (process.platform === 'linux') {
    // The source materializer excludes native outputs. Build the real holder
    // from each side's private Rust sources using the existing native owner.
    try {
      const { buildSessionHolder } = await import('../../../packages/iroh-native/scripts/build-node-addon.mjs');
      await buildSessionHolder({
        packageDir: join(sourceDir, 'packages/iroh-native'),
        runCommand: (executable, args, options) => command(executable, args, { ...options, signal }),
      });
    } catch {
      signal?.throwIfAborted();
      // Host availability only affects the footprint observation.
      process.stderr.write('Performance Session holder preparation unavailable; continuing performance capture.\n');
    }
  }
}

async function prepareUi(side, sourceDir, out, supplied, signal, owned) {
  await preparePerfSourceDependencies(side, sourceDir, signal, owned);
  if (supplied) return resolve(supplied);
  const { exportSourceWebUi } = await import('../../../apps/stack/scripts/build/build_source_web_ui.mjs');
  const baseDir = join(out, 'build', side);
  const result = await exportSourceWebUi({ repoDir: sourceDir, baseDir,
    outputDir: join(baseDir, 'web'), signal, env: { ...process.env, HAPPIER_UI_EXPORT_SOURCE_MAPS: '1' } });
  return result.uiDir;
}

export async function runPerfValidation(options) {
  const plan = resolvePerfValidationPlan(options);
  if (options.dryRun) return { status: 'PLANNED', ...plan };
  // A new output directory prevents stale bundles from masquerading as a run.
  await mkdir(dirname(plan.out), { recursive: true });
  await mkdir(plan.out);
  const reportPath = join(plan.out, 'comparison.json');
  const startedAt = performance.now();
  const abort = new AbortController();
  const interrupt = () => abort.abort();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, interrupt);
  const evidence = { sources: {}, bundles: [],
    release: options.release === true, profile: plan.profile, budgetPolicy: plan.budgetPolicy,
    baselineComparison: plan.candidateOnly ? { status: 'UNAVAILABLE', expectedSha: plan.baselineRef,
      reason: 'Candidate-only collection; exact-base artifact unavailable or producing a future baseline. No baseline values or paired deltas invented.' }
      : { status: plan.baselineResultsDir ? 'HISTORICAL' : 'PAIRED', expectedSha: plan.baselineRef } };
  let report, scratch;
  const pairs = new Map();
  try {
    const historical = plan.baselineResultsDir ? await loadPerfBaselineResults(plan.baselineResultsDir, plan.baselineRef) : null;
    if (historical) {
      evidence.sources.baseline = historical.source;
      const selected = new Set(plan.runs.map(run => run.pairId));
      for (const [pairId, baseline] of historical.bundles) if (selected.has(pairId)) pairs.set(pairId, { baseline, historical: true });
    } else if (plan.candidateOnly) evidence.sources.baseline = { sha: plan.baselineRef, available: false };
    await command('docker', ['info', '--format', '{{.ServerVersion}}'], { capture: true, signal: abort.signal });
    scratch = await mkdtemp(join(tmpdir(), 'happier-perf-bases-'));
    const consumeBaseline = historical || plan.candidateOnly ? async consume => consume(null)
      : async consume => withBasis({ ref: plan.baselineRef, directory: options.baselineDir, label: 'baseline', scratch, signal: abort.signal }, consume);
    await consumeBaseline(async baseline => {
      await withBasis({ ref: plan.candidateRef, directory: options.candidateDir, label: 'candidate', scratch, signal: abort.signal }, async candidate => {
        const bases = { ...(baseline ? { baseline } : {}), candidate };
        const sources = Object.fromEntries(Object.entries(bases).map(([side, basis]) => [side, basis.directory]));
        const exports = {};
        for (const side of Object.keys(bases)) {
          const basis = bases[side];
          evidence.sources[side] = { directory: sources[side], sha: basis.sha, dirty: basis.dirty };
          exports[side] = await prepareUi(side, sources[side], plan.out, options[`${side}UiDir`], abort.signal, basis.owned);
        }
        const { assessRegressionPairs, readProductionBundleSize, assessBundleBudget } = await import('../../../apps/stack/scripts/perf/regression.mjs');
        const sizes = { baseline: historical?.bundleSize };
        for (const side of Object.keys(bases)) sizes[side] = await readProductionBundleSize(exports[side]);
        evidence.bundleSize = assessBundleBudget(sizes.baseline, sizes.candidate);
        const request = { bases: Object.fromEntries(Object.keys(bases).map(side => [side, { repoRoot: sources[side], uiExportDir: exports[side] }])), runs: [] };
        for (const run of plan.runs) {
          const out = join(plan.out, 'runs', run.pairId, run.side);
          await mkdir(dirname(out), { recursive: true });
          request.runs.push({ side: run.side, journey: run.journey, cache: run.cache, mode: run.mode, seed: 42, out,
            ...(run.mode === 'counts' && run.journey === 'J4-stream' ? { heapCycles: plan.repeats } : {}) });
        }
        const requestPath = join(scratch, 'capture-request.json');
        await writeFile(requestPath, JSON.stringify(request));
        // One existing stress-testkit process reuses its owned environment per
        // side. The request contains only public options, never fixture secrets.
        const cwd = join(sources.candidate, 'packages/tests');
        const { resolveTsxEntrypointLaunchSpec } = await import('../../../packages/tests/scripts/runTsxEntrypoint.mjs');
        const invocation = resolveTsxEntrypointLaunchSpec({ cwd, entrypoint: 'src/testkit/stress/cli/runPerfJourney.ts', args: [`--request-file=${requestPath}`],
          requireResolve: createRequire(join(cwd, 'package.json')).resolve });
        let failure;
        try { await command(invocation.command, invocation.args, { cwd, env: { ...process.env, ...invocation.env }, signal: abort.signal }); }
        catch (error) { failure = error; }
        for (const run of plan.runs) {
          const out = join(plan.out, 'runs', run.pairId, run.side);
          if (!existsSync(join(out, 'bundle.json'))) continue;
          const bundle = JSON.parse(await readFile(join(out, 'bundle.json'), 'utf8'));
          const paired = pairs.get(run.pairId) ?? {};
          paired[run.side] = bundle;
          pairs.set(run.pairId, paired);
          evidence.bundles.push({ ...run, directory: `runs/${run.pairId}/${run.side}` });
        }
        if (failure) throw failure;
        if (evidence.bundles.length !== plan.runs.length) throw new Error('Capture suite did not produce every requested bundle');
        report = { ...assessRegressionPairs([...pairs.values()]), ...evidence };
        if (report.bundleSize.status === 'FAIL') report.status = 'FAIL';
      });
    });
  } catch (error) {
    const { assessRegressionPairs } = await import('../../../apps/stack/scripts/perf/regression.mjs');
    report = { ...assessRegressionPairs([...pairs.values()]), status: 'INCOMPLETE', error: error.message, ...evidence };
  } finally {
    for (const signal of ['SIGINT', 'SIGTERM']) process.off(signal, interrupt);
    if (scratch) {
      try {
        const usesWorktrees = (!plan.candidateOnly && !plan.baselineResultsDir && !options.baselineDir)
          || Boolean(plan.candidateRef && !options.candidateDir);
        const retained = usesWorktrees && await command('git', ['worktree', 'list', '--porcelain'], { capture: true }).then(text => text.includes(scratch));
        if (!retained) await rm(scratch, { recursive: true, force: true });
        else report.cleanup = { status: 'INCOMPLETE', retainedDirectory: scratch };
      } catch { report.cleanup = { status: 'INCOMPLETE', retainedDirectory: scratch }; }
    }
  }
  report.observedStatus = report.status;
  report.status = ['INCOMPLETE', 'BLOCKED'].includes(report.status) ? 'INCOMPLETE' : 'CAPTURED';
  report.elapsedMs = performance.now() - startedAt;
  report.informational = true;
  const { renderPerfComparison } = await import('../../../apps/stack/scripts/perf/regression.mjs');
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  await writeFile(join(plan.out, 'comparison.md'), renderPerfComparison(report));
  return { ...report, reportPath };
}

async function main() {
  const { values } = parseArgs({ options: {
    'baseline-ref': { type: 'string' }, 'candidate-ref': { type: 'string' }, out: { type: 'string' },
    profile: { type: 'string', default: 'full' }, repeats: { type: 'string', default: '5' },
    'baseline-dir': { type: 'string' }, 'candidate-dir': { type: 'string' },
    'baseline-results-dir': { type: 'string' }, 'candidate-only': { type: 'boolean' },
    'baseline-ui-dir': { type: 'string' }, 'candidate-ui-dir': { type: 'string' },
    'dry-run': { type: 'boolean' }, release: { type: 'boolean' },
  }, allowPositionals: false });
  const report = await runPerfValidation({ baselineRef: values['baseline-ref'], candidateRef: values['candidate-ref'],
    out: values.out, profile: values.profile, repeats: Number(values.repeats), dryRun: values['dry-run'], release: values.release,
    baselineDir: values['baseline-dir'], candidateDir: values['candidate-dir'],
    baselineResultsDir: values['baseline-results-dir'], candidateOnly: values['candidate-only'],
    baselineUiDir: values['baseline-ui-dir'], candidateUiDir: values['candidate-ui-dir'] });
  console.log(JSON.stringify(report, null, 2));
  // Scenario metrics are informational until their signal is independently
  // proven stable. Existing tier-1 test jobs are the only performance gates.
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main().catch(error => {
  console.error(error.message); process.exitCode = 1;
});
