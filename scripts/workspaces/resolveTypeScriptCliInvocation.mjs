import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRemoteCommandPolicy } from '../../apps/stack/scripts/utils/dev_targets/remote_commands.mjs';

const NATIVE_TYPESCRIPT_PACKAGE_JSON = '@typescript/native/package.json';
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Native 7.0.2 incremental snapshots use xxh3.HashString128(text).Bytes()
// encoded as hexadecimal (typescript-go 2bd066d, incremental/snapshot.go).
// File text is UTF-8 decoded with its leading BOM removed. Keep this compiler
// adapter here; source bundle records still use their existing SHA-256 digests.
export async function matchesNativeTypeScriptInputVersion(contents, version) {
  const { xxhash128 } = await import('hash-wasm');
  return await xxhash128(contents.toString('utf8').replace(/^\uFEFF/, '')) === version;
}

export function shouldRouteTypeScriptCliThroughHstack(params) {
  if (!params.args.includes('--noEmit')) return false;
  if (params.env.HAPPIER_DEV_TARGET_EXECUTION === '1') return false;
  if (params.env.HAPPIER_HSTACK_EXECUTION === '1') return false;
  if (params.env.HAPPIER_TYPECHECK_DISPATCHED === '1') return false;
  return true;
}

export function resolveTypeScriptCliInvocation(params) {
  const processExecPath = params.processExecPath ?? process.execPath;
  const requireResolve = params.requireResolve ?? createRequire(import.meta.url).resolve;
  const readFileSyncImpl = params.readFileSyncImpl ?? readFileSync;
  const packageJsonPath = requireResolve(NATIVE_TYPESCRIPT_PACKAGE_JSON);
  const packageJson = JSON.parse(readFileSyncImpl(packageJsonPath, 'utf8'));
  const tscBin = packageJson?.bin?.tsc;
  if (typeof tscBin !== 'string' || !tscBin.trim()) {
    throw new Error(`${NATIVE_TYPESCRIPT_PACKAGE_JSON} does not declare a tsc binary`);
  }

  const compilerPath = resolve(dirname(packageJsonPath), tscBin);
  const env = params.env ?? process.env;
  // Match the native local admission owner's ordinary CI exemption. Placed
  // workers and descendants carrying an admission token still validate it.
  const requiresAdmission = !env.CI || env.HAPPIER_DEV_TARGET_EXECUTION === '1'
    || Boolean(env.HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN);
  if ((params.platform ?? process.platform) === 'linux' && requiresAdmission) {
    const admissionClass = params.admissionClass ?? resolveRemoteCommandPolicy(
      ['node', 'scripts/workspaces/runTypeScriptCli.mjs', ...(params.args ?? [])],
      { cwd: relative(REPO_ROOT, params.workspaceDir ?? process.cwd()) || '.' },
    ).heavyClass;
    // Routing markers select transport; only the native admission owner can
    // validate/reuse an admitted ancestor or wait for compilation headroom.
    return {
      command: resolve(REPO_ROOT, 'apps/stack/bin/hstack-exec'),
      argsPrefix: ['--heavyweight-admission', `--class=${admissionClass}`,
        `--machine=${env.HAPPIER_DEV_TARGET_EXECUTION === '1' ? 'worker' : 'local'}`,
        '--exec-admitted', '--', processExecPath, compilerPath],
      compilerPath,
    };
  }
  return {
    command: processExecPath,
    argsPrefix: [compilerPath],
    compilerPath,
  };
}
