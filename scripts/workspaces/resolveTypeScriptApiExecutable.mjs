import { createRequire } from 'node:module';

export const NATIVE_TYPESCRIPT_PACKAGE_JSON = '@typescript/native/package.json';

// The native API always uses Microsoft; the selected package owns its platform executable.
export function resolveTypeScriptApiExecutable(packageJsonPath = createRequire(import.meta.url).resolve(NATIVE_TYPESCRIPT_PACKAGE_JSON)) {
  return createRequire(packageJsonPath)('./lib/getExePath.js').default();
}
