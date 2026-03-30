import { existsSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function resolveRepoRoot() {
  // `packages/tests/scripts/runWsreplLimaMatrix.shared.mjs` -> repo root.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

function trimEnvValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveWsreplLimaMatrixScriptPath(env, repoRoot = resolveRepoRoot()) {
  const override = trimEnvValue(env?.HAPPIER_E2E_WSREPL_LIMA_SCRIPT);
  if (override) {
    return isAbsolute(override) ? override : resolve(repoRoot, override);
  }

  return resolve(repoRoot, 'packages', 'tests', 'scripts', 'wsrepl-lima-matrix.sh');
}

export function resolveWsreplLimaMatrixWorkingDirectory(repoRoot = resolveRepoRoot()) {
  return resolve(repoRoot, 'apps', 'stack');
}

export function resolveWsreplLimaMatrixInvocation({
  argv,
  env,
  platform,
  repoRoot = resolveRepoRoot(),
}) {
  const scriptPath = resolveWsreplLimaMatrixScriptPath(env, repoRoot);
  const hasOverride = trimEnvValue(env?.HAPPIER_E2E_WSREPL_LIMA_SCRIPT).length > 0;
  const isSupportedHostPlatform = platform === 'darwin' || platform === 'linux';

  if (!hasOverride && !isSupportedHostPlatform) {
    return {
      ok: false,
      exitCode: 1,
      message: '[tests] WSREPL Lima matrix runs only on macOS and Linux hosts (typically self-hosted runners).',
    };
  }

  if (!existsSync(scriptPath)) {
    return {
      ok: false,
      exitCode: 1,
      message: `[tests] Missing WSREPL Lima matrix harness: ${scriptPath}`,
    };
  }

  const passThrough = Array.isArray(argv) ? argv : [];
  const cwd = resolveWsreplLimaMatrixWorkingDirectory(repoRoot);
  const scriptExtension = extname(scriptPath).toLowerCase();

  let command;
  let args;
  if (scriptExtension === '.mjs' || scriptExtension === '.cjs' || scriptExtension === '.js') {
    command = process.execPath;
    args = [scriptPath, ...passThrough];
  } else if (scriptExtension === '.sh') {
    command = 'bash';
    args = [scriptPath, ...passThrough];
  } else {
    command = scriptPath;
    args = [...passThrough];
  }

  return {
    ok: true,
    command,
    args,
    configLabel: passThrough[0] || basename(scriptPath),
    spawnOptions: {
      stdio: 'inherit',
      env: {
        ...env,
      },
      cwd,
      detached: platform !== 'win32',
    },
  };
}
