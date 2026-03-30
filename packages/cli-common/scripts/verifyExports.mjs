import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function collectExportTargetStrings(value, acc) {
  if (typeof value === 'string') {
    acc.push(value);
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return;
  }

  for (const nested of Object.values(value)) {
    collectExportTargetStrings(nested, acc);
  }
}

export function collectMissingExportTargets({
  packageDir,
  packageJson,
  existsSyncImpl = existsSync,
}) {
  const resolvedPackageDir = resolve(packageDir);
  const targets = [];
  collectExportTargetStrings(packageJson.exports ?? {}, targets);

  return [...new Set(targets)]
    .map((target) => String(target).trim())
    .filter((target) => target.startsWith('./'))
    .filter((target) => !existsSyncImpl(resolve(resolvedPackageDir, target)))
    .map((target) => ({
      target,
      relativePath: relative(resolvedPackageDir, resolve(resolvedPackageDir, target)),
    }));
}

export function verifyPackageExportTargets({
  packageDir,
  packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')),
  existsSyncImpl = existsSync,
}) {
  const missingTargets = collectMissingExportTargets({
    packageDir,
    packageJson,
    existsSyncImpl,
  });

  if (missingTargets.length === 0) {
    return;
  }

  const formattedTargets = missingTargets
    .map(({ relativePath }) => `- ${relativePath}`)
    .join('\n');
  throw new Error(
    `Missing files for declared package exports in ${packageJson.name ?? 'package'}:\n${formattedTargets}`,
  );
}

export function main() {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  verifyPackageExportTargets({
    packageDir: dirname(scriptsDir),
  });
}

const isEntrypoint = (() => {
  const arg = typeof process.argv?.[1] === 'string' ? process.argv[1] : '';
  if (!arg) return false;
  return arg.endsWith('/scripts/verifyExports.mjs') || arg.endsWith('\\scripts\\verifyExports.mjs');
})();

if (isEntrypoint) {
  main();
}
