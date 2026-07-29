import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MANIFEST_ENV = 'HAPPIER_PLUGIN_PLATFORM_CANDIDATE_MANIFEST';

export function requirePackedResourcesBrowserQaManifestPath({
  argv,
  env,
  cwd,
}) {
  let candidateArgument = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== '--candidate') {
      throw new Error(`packed_resources_browser_qa_unknown_argument:${argument}`);
    }
    if (candidateArgument !== null) {
      throw new Error('packed_resources_browser_qa_candidate_repeated');
    }
    const value = argv[index + 1]?.trim();
    if (!value || value.startsWith('--')) {
      throw new Error('packed_resources_browser_qa_candidate_value_required');
    }
    candidateArgument = value;
    index += 1;
  }

  const environmentValue = env[MANIFEST_ENV]?.trim() || null;
  if (
    candidateArgument
    && environmentValue
    && resolve(cwd, candidateArgument) !== resolve(cwd, environmentValue)
  ) {
    throw new Error('packed_resources_browser_qa_manifest_conflict');
  }
  const manifestPath = candidateArgument ?? environmentValue;
  if (!manifestPath) {
    throw new Error('packed_resources_browser_qa_manifest_required');
  }
  return isAbsolute(manifestPath) ? manifestPath : resolve(cwd, manifestPath);
}

export function buildPackedResourcesBrowserQaInvocation({
  testsPackageRoot,
  manifestPath,
  processExecPath,
}) {
  return {
    command: processExecPath,
    args: [
      join(testsPackageRoot, 'scripts', 'run-playwright-with-heartbeat.mjs'),
      '--config',
      'playwright.ui.config.mjs',
      'plugins.resourcesBrowser.candidate.spec.ts',
    ],
    cwd: testsPackageRoot,
    envPatch: {
      [MANIFEST_ENV]: manifestPath,
      HAPPIER_PACKED_RESOURCES_BROWSER_QA: '1',
    },
  };
}

async function runPackedResourcesBrowserQa() {
  const testsPackageRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
  );
  const manifestPath = requirePackedResourcesBrowserQaManifestPath({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
  });
  await access(manifestPath);
  const invocation = buildPackedResourcesBrowserQaInvocation({
    testsPackageRoot,
    manifestPath,
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
        reject(new Error(`packed_resources_browser_qa_terminated:${signal}`));
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
  runPackedResourcesBrowserQa().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
