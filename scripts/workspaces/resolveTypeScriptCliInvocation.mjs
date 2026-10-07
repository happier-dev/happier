import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NATIVE_TYPESCRIPT_PACKAGE_JSON = '@typescript/native/package.json';
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

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
    // Routing markers select transport; only the native admission owner can
    // validate/reuse an admitted ancestor or wait for compilation headroom.
    return {
      command: resolve(REPO_ROOT, 'apps/stack/bin/hstack-exec'),
      argsPrefix: ['--heavyweight-admission', `--class=${params.admissionClass ?? 'compilation'}`,
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
