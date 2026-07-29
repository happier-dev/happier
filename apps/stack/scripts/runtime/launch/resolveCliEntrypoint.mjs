import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { readCliDistIntegrity, resolveCliDistEntrypointFromBin } from '../../utils/cli/cliDistIntegrity.mjs';

function resolveTsxLoaderPath(cliDir) {
  const resolvers = [
    createRequire(join(cliDir, 'package.json')),
    createRequire(import.meta.url),
  ];

  for (const require of resolvers) {
    try {
      const tsxPkgJsonPath = require.resolve('tsx/package.json');
      const tsxLoaderPath = join(dirname(tsxPkgJsonPath), 'dist', 'esm', 'index.mjs');
      if (existsSync(tsxLoaderPath)) return tsxLoaderPath;
    } catch {
      // Try the next resolver.
    }
  }

  return null;
}

function resolveTsxCliEntrypoint(cliDir) {
  const srcEntrypoint = join(cliDir, 'src', 'index.ts');
  if (!existsSync(srcEntrypoint)) {
    return null;
  }

  const tsxLoaderPath = resolveTsxLoaderPath(cliDir);
  if (!tsxLoaderPath) {
    return null;
  }

  return {
    kind: 'tsx',
    nodeArgs: ['--import', tsxLoaderPath, srcEntrypoint],
    distEntrypoint: resolveCliDistEntrypointFromBin(join(cliDir, 'bin', 'happier.mjs')),
    tsconfigPath: join(cliDir, 'tsconfig.json'),
  };
}

function resolveDistCliEntrypoint(cliDir) {
  const packagedEntrypoint = resolveCliDistEntrypointFromBin(join(cliDir, 'bin', 'happier.mjs'));
  const packagedIntegrity = readCliDistIntegrity(packagedEntrypoint);
  if (!packagedIntegrity.ok) {
    return null;
  }
  return { kind: 'dist', nodeArgs: [packagedEntrypoint], distEntrypoint: packagedEntrypoint };
}

export function resolveCliEntrypoint({ cliDir, preferSource = false } = {}) {
  const root = String(cliDir ?? '').trim();
  if (!root) return null;

  if (preferSource) {
    return resolveTsxCliEntrypoint(root) ?? resolveDistCliEntrypoint(root);
  }

  return resolveDistCliEntrypoint(root) ?? resolveTsxCliEntrypoint(root);
}
