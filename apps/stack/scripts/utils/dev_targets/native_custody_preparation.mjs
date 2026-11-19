import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requiresTypeScriptAdmission } from '../../../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';
import { redactFailureDiagnostic, runCaptureResult } from '../proc/proc.mjs';

const preparationCode = 'HSTACK_CLI_NATIVE_CUSTODY_PREPARATION_FAILED';
const stalePreparationExitCode = 3;

export function resolveCliNativeCustodyOptions({
  componentRelativeDir, validationKind, requiredTools = '', preparationScope,
}) {
  if (validationKind !== 'source-test' || componentRelativeDir?.replaceAll('\\', '/') !== 'apps/cli'
    || !requiredTools.split(/[\s,]+/u).includes('go')) return null;
  return { sessionTargets: preparationScope !== 'host-native' };
}

/** @typedef {'dependency-refresh' | 'source-load' | 'native-staging' | 'native-readiness' | 'go-build' | 'post-build' | 'source-runtime'} PreparationStep */
/** @typedef {{ phase: 'native-custody-preparation' | 'native-custody-publication', step: PreparationStep, exitCode: number | null, signal: string | null, errorLines: string[] }} PreparationCause */

function preparationFailure(error, step, env) {
  const code = typeof error?.code === 'string' ? error.code : preparationCode;
  const phase = code === 'EWORKSPACEBUNDLELOCKBUSY'
    ? 'native-custody-publication' : 'native-custody-preparation';
  // This is a diagnostic preview, never raw process output or an error bag.
  // Skip admission chatter so the first compiler errors survive a queued build.
  const errorLines = redactFailureDiagnostic([
    error?.message ?? String(error ?? ''), error?.stderr, error?.stdout,
  ].filter(Boolean).join('\n'), env).split(/\r?\n/u)
    .filter(line => line.trim() && !line.startsWith('[preferred-execution]')).slice(0, 8);
  /** @type {PreparationCause} */
  const cause = { phase, step, exitCode: typeof error?.exitCode === 'number' ? error.exitCode : null,
    signal: typeof error?.signal === 'string' ? error.signal : null, errorLines };
  return { code, phase, retryable: false, cause };
}

async function prepareWorker(projectRoot, repoDir, resultPath, { sessionTargets, checkOnly }) {
  /** @type {PreparationStep} */
  let step = 'dependency-refresh';
  try {
    const { withDependencyConsumption } = await import(pathToFileURL(resolve(repoDir,
      'apps/stack/scripts/utils/proc/dependency_refresh.mjs')).href);
    const [{ prepareNativeCustody, readStaleNativeCustody }, { runWorkspaceBuildAdmission }] =
      await withDependencyConsumption({ installDir: repoDir, wait: !checkOnly }, async () => {
        step = 'source-runtime';
        await import(pathToFileURL(resolve(repoDir, 'packages/cli-common/registerSourceRuntime.mjs')).href);
        step = 'source-load';
        return await Promise.all([
          import(pathToFileURL(resolve(projectRoot, 'src/test-setup.ts')).href),
          import(pathToFileURL(resolve(repoDir, 'apps/stack/scripts/utils/proc/workspace_build_admission.mjs')).href),
        ]);
      });
    if (checkOnly) {
      step = 'native-readiness';
      if ((await readStaleNativeCustody(projectRoot, { sessionTargets })).length) process.exitCode = stalePreparationExitCode;
      return;
    }
    step = 'native-staging';
    const runCommand = async (command, args, options) => {
      step = 'go-build';
      const result = await runWorkspaceBuildAdmission({ ...options, command, args,
        repoDir, admissionClass: 'native-custody',
        admissionRequired: requiresTypeScriptAdmission({ env: process.env }), locks: [], stdio: 'pipe' });
      if (result.error) throw result.error;
      if (result.status !== 0 || result.signal) throw Object.assign(new Error('Native custody Go build failed'),
        { exitCode: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr });
      step = 'post-build';
    };
    // Each artifact's current/rebuilt line reaches the caller (prepareCliSourceNativeCustody prints it).
    await prepareNativeCustody(projectRoot, runCommand, { sessionTargets, log: line => process.stderr.write(`${line}\n`) });
  } catch (error) {
    const failure = preparationFailure(error, step, process.env);
    await writeFile(resultPath, JSON.stringify(failure));
    process.exitCode = 1;
  }
}

const ARTIFACT_LINE = /^\[native-custody\] \S.* (?:current|rebuilt) \d+ms$/u;

/** `sessionTargets: false` prepares this Machine's artifacts only (a selection without placed-Session tests). */
export async function prepareCliSourceNativeCustody(repoDir, env, options) {
  await runCliSourceNativeCustodyWorker(repoDir, env, options);
}

export async function isCliSourceNativeCustodyCurrent(repoDir, env, options) {
  return await runCliSourceNativeCustodyWorker(repoDir, env, { ...options, checkOnly: true });
}

async function runCliSourceNativeCustodyWorker(repoDir, env, {
  sessionTargets = true, stderr = process.stderr, checkOnly = false, signal,
} = {}) {
  const projectRoot = resolve(repoDir, 'apps/cli');
  const resultDir = await mkdtemp(resolve(tmpdir(), 'happier-native-custody-result-'));
  const resultPath = resolve(resultDir, 'failure.json');
  try {
    const result = await runCaptureResult(process.execPath, [
      fileURLToPath(import.meta.url), '--worker', projectRoot, repoDir, resultPath,
      ...(sessionTargets ? [] : ['--host-only']), ...(checkOnly ? ['--check-only'] : [])], {
      cwd: repoDir, env, signal,
    });
    signal?.throwIfAborted();
    if (checkOnly && result.exitCode === stalePreparationExitCode && !result.signal) return false;
    // Only the worker's own artifact lines: any other worker output stays captured (failures are redacted below).
    for (const line of String(result.err ?? '').split(/\r?\n/u)) if (ARTIFACT_LINE.test(line)) stderr.write(`${line}\n`);
    if (!result.ok) {
      const failure = await readFile(resultPath, 'utf8').then(JSON.parse).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        // A loader failure can happen before the worker can write its result.
        return preparationFailure({ message: 'Native custody source runtime failed',
          exitCode: result.exitCode, signal: result.signal, stdout: result.out, stderr: result.err },
        'source-runtime', env);
      });
      throw Object.assign(new Error(result.signal
        ? `CLI native process custody preparation terminated by ${result.signal}`
        : `CLI native process custody preparation exited with status ${String(result.exitCode)}`),
      { ...failure, exitCode: result.exitCode, signal: result.signal });
    }
    return true;
  } finally { await rm(resultDir, { recursive: true, force: true }); }
}

const entryPath = String(process.argv[1] ?? '').trim();
if (entryPath && pathToFileURL(resolve(entryPath)).href === import.meta.url && process.argv[2] === '--worker') {
  const flags = process.argv.slice(6);
  await prepareWorker(process.argv[3], process.argv[4], process.argv[5], {
    sessionTargets: !flags.includes('--host-only'), checkOnly: flags.includes('--check-only'),
  });
}
