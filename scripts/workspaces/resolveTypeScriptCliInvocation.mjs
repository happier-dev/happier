import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const NATIVE_TYPESCRIPT_PACKAGE_JSON = '@typescript/native/package.json';

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

  return {
    command: processExecPath,
    argsPrefix: [resolve(dirname(packageJsonPath), tscBin)],
  };
}
