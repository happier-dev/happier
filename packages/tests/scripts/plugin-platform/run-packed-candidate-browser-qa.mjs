import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MANIFEST_ENV = 'HAPPIER_PLUGIN_PLATFORM_CANDIDATE_MANIFEST';
const NOVEL_HANDOFF_MANIFEST_ENV =
  'HAPPIER_E2E_PACKED_NOVEL_QA_HANDOFF_MANIFEST';

export function requirePackedCandidateBrowserQaInputs({
  argv,
  env,
  cwd,
}) {
  const values = {
    candidate: null,
    novelHandoff: null,
  };
  const flags = {
    '--candidate': 'candidate',
    '--novel-handoff': 'novelHandoff',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const key = flags[argument];
    if (!key) {
      throw new Error(`packed_candidate_browser_qa_unknown_argument:${argument}`);
    }
    if (values[key] !== null) {
      throw new Error(`packed_candidate_browser_qa_${key}_repeated`);
    }
    const value = argv[index + 1]?.trim();
    if (!value || value.startsWith('--')) {
      throw new Error(`packed_candidate_browser_qa_${key}_value_required`);
    }
    values[key] = value;
    index += 1;
  }

  const candidateEnvironmentValue = env[MANIFEST_ENV]?.trim() || null;
  if (
    values.candidate
    && candidateEnvironmentValue
    && resolve(cwd, values.candidate) !== resolve(cwd, candidateEnvironmentValue)
  ) {
    throw new Error('packed_candidate_browser_qa_manifest_conflict');
  }
  const candidateValue = values.candidate ?? candidateEnvironmentValue;
  if (!candidateValue) {
    throw new Error('packed_candidate_browser_qa_manifest_required');
  }

  const novelHandoffEnvironmentValue =
    env[NOVEL_HANDOFF_MANIFEST_ENV]?.trim() || null;
  if (
    values.novelHandoff
    && novelHandoffEnvironmentValue
    && resolve(cwd, values.novelHandoff)
      !== resolve(cwd, novelHandoffEnvironmentValue)
  ) {
    throw new Error('packed_candidate_browser_qa_novel_handoff_conflict');
  }
  const novelHandoffValue =
    values.novelHandoff ?? novelHandoffEnvironmentValue;
  if (!novelHandoffValue) {
    throw new Error('packed_candidate_browser_qa_novel_handoff_required');
  }

  return {
    manifestPath: isAbsolute(candidateValue)
      ? candidateValue
      : resolve(cwd, candidateValue),
    novelHandoffManifestPath: isAbsolute(novelHandoffValue)
      ? novelHandoffValue
      : resolve(cwd, novelHandoffValue),
  };
}

export function buildPackedCandidateBrowserQaInvocation({
  testsPackageRoot,
  manifestPath,
  novelHandoffManifestPath,
  processExecPath,
}) {
  return {
    command: processExecPath,
    args: [
      join(testsPackageRoot, 'scripts', 'run-playwright-with-heartbeat.mjs'),
      '--config',
      'playwright.ui.config.mjs',
      'settings.plugins.details.spec.ts',
    ],
    cwd: testsPackageRoot,
    envPatch: {
      [MANIFEST_ENV]: manifestPath,
      [NOVEL_HANDOFF_MANIFEST_ENV]: novelHandoffManifestPath,
    },
  };
}

async function runPackedCandidateBrowserQa() {
  const testsPackageRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
  );
  const inputs = requirePackedCandidateBrowserQaInputs({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
  });
  await Promise.all([
    access(inputs.manifestPath),
    access(inputs.novelHandoffManifestPath),
  ]);
  const invocation = buildPackedCandidateBrowserQaInvocation({
    testsPackageRoot,
    ...inputs,
    processExecPath: process.execPath,
  });
  const child = spawn(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: { ...process.env, ...invocation.envPatch },
    stdio: 'inherit',
  });
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`packed_candidate_browser_qa_terminated:${signal}`));
        return;
      }
      resolveExit(code ?? 1);
    });
  });
  process.exitCode = exitCode;
}

if (
  process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  runPackedCandidateBrowserQa().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
