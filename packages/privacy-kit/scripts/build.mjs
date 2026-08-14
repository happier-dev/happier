import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function rebaseDistTarget(value) {
  if (typeof value !== 'string') return value;
  if (value === './dist') return '.';
  if (value.startsWith('./dist/')) return `./${value.slice('./dist/'.length)}`;
  return value;
}

function rebaseDistTargets(value) {
  if (Array.isArray(value)) {
    return value.map(rebaseDistTargets);
  }
  if (!value || typeof value !== 'object') {
    return rebaseDistTarget(value);
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, rebaseDistTargets(nested)]),
  );
}

function collectTargetStrings(value, output) {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const nested of Object.values(value)) {
    collectTargetStrings(nested, output);
  }
}

function collectDistOutputFiles(packageJson) {
  const targets = [];
  for (const key of ['main', 'module', 'types']) {
    collectTargetStrings(packageJson[key], targets);
  }
  collectTargetStrings(packageJson.exports, targets);

  return [...new Set(targets)].map((target) => {
    if (!target.startsWith('./dist/')) {
      throw new Error(`privacy-kit pkgroll entrypoint must be inside ./dist: ${target}`);
    }
    return target.slice('./dist/'.length);
  });
}

function runBuild() {
  const packageJsonPath = join(packageRoot, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const outputFiles = collectDistOutputFiles(packageJson);
  const requestedOutputDir = String(process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR ?? '').trim();
  const outputDir = resolve(packageRoot, requestedOutputDir || 'dist');
  const sourceDir = realpathSync.native(join(packageRoot, 'src'));

  mkdirSync(outputDir, { recursive: true });
  const physicalOutputDir = realpathSync.native(outputDir);
  const sourceFromOutput = relative(physicalOutputDir, sourceDir);
  if (isAbsolute(sourceFromOutput)) {
    throw new Error('privacy-kit staged output must be on the same filesystem volume as its source');
  }

  const stageManifest = {
    ...packageJson,
    main: rebaseDistTargets(packageJson.main),
    module: rebaseDistTargets(packageJson.module),
    types: rebaseDistTargets(packageJson.types),
    exports: rebaseDistTargets(packageJson.exports),
  };
  const stageManifestPath = join(physicalOutputDir, 'package.json');
  const pkgrollCliPath = require.resolve('pkgroll/dist/cli.mjs');
  const dependencyNodeModules = dirname(dirname(require.resolve('typescript/package.json')));
  const srcdist = `${sourceFromOutput.replaceAll('\\', '/') || '.'}:.`;
  const args = [
    pkgrollCliPath,
    '--packagejson=false',
    '--srcdist',
    srcdist,
    '--tsconfig',
    join(packageRoot, 'tsconfig.json'),
  ];
  for (const outputFile of outputFiles) {
    args.push('--input', outputFile);
  }

  let manifestWritten = false;
  try {
    writeFileSync(stageManifestPath, `${JSON.stringify(stageManifest, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    manifestWritten = true;
    const result = spawnSync(process.execPath, args, {
      cwd: physicalOutputDir,
      env: {
        ...process.env,
        NODE_PATH: [dependencyNodeModules, process.env.NODE_PATH].filter(Boolean).join(delimiter),
      },
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.signal) throw new Error(`pkgroll terminated by signal ${result.signal}`);
    if (result.status !== 0) {
      throw new Error(`pkgroll exited without success (status=${result.status ?? 'null'})`);
    }
  } finally {
    if (manifestWritten) rmSync(stageManifestPath, { force: true });
  }

  const missing = outputFiles.filter((outputFile) => !existsSync(join(physicalOutputDir, outputFile)));
  if (missing.length > 0) {
    throw new Error(`privacy-kit build did not emit declared entrypoints: ${missing.join(', ')}`);
  }
}

runBuild();
