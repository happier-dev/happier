// @ts-check
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { tmpdir } from 'node:os';
import { selectCandidateArtifact } from '../release/verify-github-candidate-run.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const hotPath = /^(?:apps\/ui\/(?:sources\/(?:components|hooks|sync)|scripts\/perf)|apps\/(?:server\/sources|cli\/src)|apps\/stack\/scripts\/perf|packages\/(?:protocol|tests|plugin-ui)|scripts\/pipeline\/perf)\//u;

/** @param {{ eventName: string; event: { pull_request?: { labels?: { name: string }[] } }; changedPaths: string[]; release?: boolean }} input */
export function shouldRunPerformance({ eventName, event, changedPaths, release = false }) {
  if (release || eventName === 'schedule' || eventName === 'push') return true;
  if (eventName !== 'pull_request') throw new Error(`Unsupported performance event: ${eventName}`);
  return event.pull_request?.labels?.some((label) => label.name === 'performance') === true || changedPaths.some((name) => hotPath.test(name));
}

/** Only trusted branch producers at this exact base SHA can supply comparison data. */
export function selectExactBaseRun(runs, { repository, baseSha }) {
  return runs.filter(run => Number.isSafeInteger(run.id) && run.id > 0
    && run.path === '.github/workflows/performance.yml' && run.event === 'push'
    && run.status === 'completed' && run.conclusion === 'success'
    && run.head_sha === baseSha && ['dev', 'main', 'v0.3'].includes(run.head_branch)
    && run.repository?.full_name === repository && run.head_repository?.full_name === repository)
    .sort((a, b) => b.id - a.id)[0] ?? null;
}

export function selectPerformanceArtifact(artifacts, { runId, baseSha }) {
  try {
    const id = selectCandidateArtifact(artifacts, { artifactName: 'performance-results', runId, expectedHeadSha: baseSha });
    const artifact = artifacts.find(row => row.id === id);
    return artifact?.expired === false && /^sha256:[a-f0-9]{64}$/u.test(artifact.digest) ? artifact : null;
  } catch { return null; }
}

export function baselineBundleEntries(report, baseSha) {
  if (report?.sources?.candidate?.sha !== baseSha || report.sources.candidate.dirty !== false || !Array.isArray(report.bundles)) {
    throw new Error('Baseline report does not identify clean exact-base source');
  }
  const seen = new Set();
  const rows = report.bundles.filter(row => row?.side === 'candidate').map(row => {
    if (typeof row.pairId !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(row.pairId) || seen.has(row.pairId)) {
      throw new Error('Baseline report has an invalid or duplicate bundle identity');
    }
    seen.add(row.pairId);
    const directory = `runs/${row.pairId}/candidate`;
    return { entry: `${directory}/bundle.json`, directory };
  });
  if (!rows.length) throw new Error('Baseline artifact contains no candidate bundles');
  return rows;
}

export async function materializePerformanceArtifact({ archive, out, baseSha }) {
  const entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8', maxBuffer: Infinity }).split(/\r?\n/u);
  const readJson = entry => {
    if (entries.filter(name => name === entry).length !== 1) throw new Error(`Baseline artifact is missing or duplicates ${entry}`);
    return JSON.parse(execFileSync('unzip', ['-p', archive, entry], { encoding: 'utf8', maxBuffer: Infinity }));
  };
  const report = readJson('comparison.json');
  const rows = baselineBundleEntries(report, baseSha);
  const bundles = rows.map(row => ({ ...row, value: readJson(row.entry) }));
  // Only canonical JSON is materialized. Archive scripts, links, and profile
  // executables are never extracted, imported, or executed.
  for (const bundle of bundles) {
    fs.mkdirSync(path.join(out, bundle.directory), { recursive: true });
    fs.writeFileSync(path.join(out, bundle.entry), `${JSON.stringify(bundle.value)}\n`);
  }
  const candidateRows = report.bundles.filter(row => row.side === 'candidate');
  fs.writeFileSync(path.join(out, 'comparison.json'), `${JSON.stringify({ ...report,
    bundles: candidateRows.map((row, index) => ({ ...row, directory: rows[index].directory })),
  })}\n`);
  return out;
}

async function obtainExactBaseArtifact(repository, baseSha) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository) || !/^[a-f0-9]{40}$/u.test(baseSha)) throw new Error('Invalid exact-base artifact identity');
  const pages = endpoint => JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', '-H', 'X-GitHub-Api-Version: 2022-11-28', endpoint], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: Infinity,
  }));
  let runs = pages(`repos/${repository}/actions/workflows/performance.yml/runs?head_sha=${baseSha}&event=push&status=success&per_page=100`).flatMap(page => page.workflow_runs ?? []);
  for (let run = selectExactBaseRun(runs, { repository, baseSha }); run; run = selectExactBaseRun(runs, { repository, baseSha })) {
    const artifacts = pages(`repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`).flatMap(page => page.artifacts ?? []);
    const artifact = selectPerformanceArtifact(artifacts, { runId: run.id, baseSha });
    if (artifact) {
      const scratch = fs.mkdtempSync(path.join(tmpdir(), 'happier-perf-baseline-artifact-'));
      const archive = path.join(scratch, 'baseline.zip');
      // Reuse the existing digest-verifying Actions-artifact transport.
      const { downloadReleaseResumeArtifact } = await import('../release/resolve-release-resume.mjs');
      await downloadReleaseResumeArtifact({ repository, artifactId: artifact.id, digest: artifact.digest, archivePath: archive });
      const directory = await materializePerformanceArtifact({ archive, out: path.join(scratch, 'results'), baseSha });
      console.log(`Baseline artifact: exact ${baseSha}, trusted run ${run.id}, artifact ${artifact.id}.`);
      return directory;
    }
    runs = runs.filter(row => row.id !== run.id);
  }
  return null;
}

async function main() {
  const { values } = parseArgs({ options: { plan: { type: 'boolean' }, release: { type: 'boolean' }, summary: { type: 'boolean' }, out: { type: 'string', default: '.happier/qa/perf/ci' } }, allowPositionals: false });
  if (values.summary) {
    if (!process.env.GITHUB_STEP_SUMMARY) return;
    const report = path.resolve(root, values.out, 'comparison.md');
    const markdown = fs.existsSync(report) ? fs.readFileSync(report, 'utf8')
      : `## Performance comparison\n\n${process.env.PERF_DRY_RUN === 'true' ? 'PLANNED: dry run; no measurements collected.' : 'INCOMPLETE: no comparison report was produced; inspect the collection/setup logs.'}\n`;
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
    return;
  }
  const release = values.release === true;
  const eventName = process.env.GITHUB_EVENT_NAME ?? '';
  const event = JSON.parse(fs.readFileSync(String(process.env.GITHUB_EVENT_PATH), 'utf8'));
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const candidate = git(['rev-parse', 'HEAD']);
  const isPr = !release && eventName === 'pull_request';
  const isProducer = !release && eventName === 'push';
  const baseline = isPr ? event.pull_request.base.sha : isProducer ? candidate
    : git(['describe', '--tags', '--abbrev=0', '--match', '*-v[0-9]*', `${candidate}^`]);
  const diffBase = isPr ? git(['merge-base', baseline, candidate]) : baseline;
  const changedPaths = git(['diff', '--name-only', '-z', diffBase, candidate]).split('\0').filter(Boolean);
  const selected = shouldRunPerformance({ eventName, event, changedPaths, release });
  if (values.plan) {
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `selected=${selected}\n`);
    console.log(JSON.stringify({ selected, baseline, candidate }));
    return;
  }
  if (!selected) {
    console.log('Performance comparison not selected: no performance label or hot-path changes.');
    return;
  }
  const args = ['--baseline-ref', baseline, '--candidate-ref', candidate, '--out', values.out, '--repeats', '5', '--profile', isPr ? 'pr' : 'full'];
  if (isPr) {
    let directory = null;
    if (process.env.PERF_DRY_RUN !== 'true') {
      try { directory = await obtainExactBaseArtifact(process.env.GITHUB_REPOSITORY ?? '', baseline); }
      catch (error) { console.log(`::warning::Baseline artifact UNAVAILABLE for exact ${baseline}: ${error.message.split('\n')[0]}`); }
    }
    if (directory) args.push('--baseline-results-dir', directory);
    else {
      console.log(`::warning::Baseline comparison UNAVAILABLE for exact ${baseline}; collecting head only, with no latest fallback or base rebuild.`);
      args.push('--candidate-only');
    }
  } else if (isProducer) args.push('--candidate-only');
  if (release) args.push('--release');
  if (process.env.PERF_DRY_RUN === 'true') args.push('--dry-run');
  execFileSync(process.execPath, [path.join(root, 'scripts/pipeline/run.mjs'), 'perf-validate', ...args], { cwd: root, stdio: 'inherit', env: process.env });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main().catch(error => { console.error(error.message); process.exitCode = 1; });
