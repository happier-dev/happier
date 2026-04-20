import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);

function rewritePackageDistPath(value) {
  if (typeof value !== 'string') return value;
  if (value === './package-dist') return './dist';
  if (value.startsWith('./package-dist/')) {
    return `./dist/${value.slice('./package-dist/'.length)}`;
  }
  return value;
}

export function preparePkgrollPackageManifest(value) {
  if (Array.isArray(value)) {
    return value.map((item) => preparePkgrollPackageManifest(item));
  }
  if (!value || typeof value !== 'object') {
    return rewritePackageDistPath(value);
  }

  const out = {};
  for (const [key, entryValue] of Object.entries(value)) {
    // pkgroll emits warnings for `bin` entries that point outside the built output.
    // Since bin files are not part of pkgroll's bundling inputs, omit them from the
    // temporary manifest we hand to pkgroll (the original package.json is restored).
    if (key === 'bin') continue;
    if (key === 'files') {
      out[key] = entryValue;
      continue;
    }
    out[key] = preparePkgrollPackageManifest(entryValue);
  }
  return out;
}

export function resolvePkgrollCliPath() {
  return require.resolve('pkgroll/dist/cli.mjs');
}

function readPkgrollCliKind(pkgrollCliPath, read = readFileSync) {
  const source = read(pkgrollCliPath, 'utf8');
  const prefix = source.slice(0, 64);
  if (/^#!\/bin\/sh\b/.test(prefix) || /^@echo off\b/i.test(prefix)) {
    return 'shell-wrapper';
  }
  return 'node-module';
}

export function runPkgrollBuild(options = {}) {
  const packageJsonPath = options.packageJsonPath ?? 'package.json';
  const spawn = options.spawn ?? spawnSync;
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const read = options.readFileSync ?? readFileSync;
  const original = readFileSync(packageJsonPath, 'utf8');
  const manifest = JSON.parse(original);
  const pkgrollManifest = `${JSON.stringify(preparePkgrollPackageManifest(manifest), null, 2)}\n`;
  const pkgrollCliPath = options.pkgrollCliPath ?? resolvePkgrollCliPath();

  writeFileSync(packageJsonPath, pkgrollManifest, 'utf8');
  try {
    if (readPkgrollCliKind(pkgrollCliPath, read) !== 'node-module') {
      throw new Error(
        `Local pkgroll install is invalid at ${pkgrollCliPath}: expected a JavaScript entrypoint but found a shell wrapper. Reinstall dependencies before building apps/cli.`,
      );
    }
    const result = spawn(nodeExecutable, [pkgrollCliPath], {
      stdio: 'inherit',
    });
    if (typeof result.status === 'number' && result.status !== 0) {
      throw new Error(`pkgroll exited with status ${result.status}`);
    }
    if (result.error) {
      throw result.error;
    }
  } finally {
    writeFileSync(packageJsonPath, original, 'utf8');
  }
}

const isEntrypoint = (() => {
  const arg = typeof process.argv?.[1] === 'string' ? process.argv[1] : '';
  return arg.endsWith('/runPkgrollBuild.mjs') || arg.endsWith('\\runPkgrollBuild.mjs');
})();

if (isEntrypoint) {
  runPkgrollBuild();
}
