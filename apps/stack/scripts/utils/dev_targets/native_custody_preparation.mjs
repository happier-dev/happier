import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requiresTypeScriptAdmission } from '../../../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';
import { redactFailureDiagnostic, runCaptureResult } from '../proc/proc.mjs';

const preparationCode = 'HSTACK_CLI_NATIVE_CUSTODY_PREPARATION_FAILED';

/** @typedef {'dependency-refresh' | 'source-load' | 'native-staging' | 'go-build' | 'post-build' | 'source-runtime'} PreparationStep */
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

async function prepareWorker(projectRoot, repoDir, resultPath) {
  /** @type {PreparationStep} */
  let step = 'dependency-refresh';
  try {
    const { withDependencyConsumption } = await import(pathToFileURL(resolve(repoDir,
      'apps/stack/scripts/utils/proc/dependency_refresh.mjs')).href);
    const [{ prepareNativeCustody }, { runWorkspaceBuildAdmission }] = await withDependencyConsumption({ installDir: repoDir }, async () => {
      step = 'source-runtime';
      await import(pathToFileURL(resolve(repoDir, 'packages/cli-common/registerSourceRuntime.mjs')).href);
      step = 'source-load';
      return await Promise.all([
        import(pathToFileURL(resolve(projectRoot, 'src/test-setup.ts')).href),
        import(pathToFileURL(resolve(repoDir, 'apps/stack/scripts/utils/proc/workspace_build_admission.mjs')).href),
      ]);
    });
    step = 'native-staging';
    await prepareNativeCustody(projectRoot, async (command, args, options) => {
      step = 'go-build';
      const result = await runWorkspaceBuildAdmission({ ...options, command, args,
        repoDir, admissionClass: 'native-custody',
        admissionRequired: requiresTypeScriptAdmission({ env: process.env }), locks: [], stdio: 'pipe' });
      if (result.error) throw result.error;
      if (result.status !== 0 || result.signal) throw Object.assign(new Error('Native custody Go build failed'),
        { exitCode: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr });
      step = 'post-build';
    });
  } catch (error) {
    const failure = preparationFailure(error, step, process.env);
    await writeFile(resultPath, JSON.stringify(failure));
    process.exitCode = 1;
  }
}

export async function prepareCliSourceNativeCustody(repoDir, env) {
  const projectRoot = resolve(repoDir, 'apps/cli');
  const resultDir = await mkdtemp(resolve(tmpdir(), 'happier-native-custody-result-'));
  const resultPath = resolve(resultDir, 'failure.json');
  try {
    const result = await runCaptureResult(process.execPath, [
      fileURLToPath(import.meta.url), '--worker', projectRoot, repoDir, resultPath], {
      // Only Go requests capacity. It finishes before the canonical publication
      // lock is acquired. The worker releases import custody before Go admission.
      cwd: repoDir, env,
    });
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
  } finally { await rm(resultDir, { recursive: true, force: true }); }
}

const entryPath = String(process.argv[1] ?? '').trim();
if (entryPath && pathToFileURL(resolve(entryPath)).href === import.meta.url && process.argv[2] === '--worker') {
  await prepareWorker(process.argv[3], process.argv[4], process.argv[5]);
}
