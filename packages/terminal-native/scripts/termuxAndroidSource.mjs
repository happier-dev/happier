import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const policyPath = join(packageRoot, 'native-renderers.json');
const TERMUX_SOURCE_ROOT_ENV = 'HAPPIER_TERMINAL_NATIVE_TERMUX_SOURCE_ROOT';

export const TERMUX_ANDROID_VENDOR_METADATA_FILE = 'TERMUX-SOURCE.json';

export async function readTermuxAndroidPolicy() {
  const policy = JSON.parse(await readFile(policyPath, 'utf-8'));
  return policy.androidTermux;
}

export async function validateTermuxAndroidSource({ sourceRoot }) {
  const policy = await readTermuxAndroidPolicy();
  const requiredModules = policy.upstream.modules;
  const forbiddenModules = policy.forbiddenModules;
  const missingRequired = [];
  const forbiddenPresent = [];

  for (const module of requiredModules) {
    if (!await exists(join(sourceRoot, module.path))) {
      missingRequired.push(module.name);
    }
  }

  for (const module of forbiddenModules) {
    if (await exists(join(sourceRoot, module.name))) {
      forbiddenPresent.push(module.name);
    }
  }

  const forbiddenReferences = await findForbiddenReferences({
    sourceRoot,
    forbiddenTokens: [
      'com.termux.shared',
      'com.termux.app',
      'project(":termux-shared")',
      "project(':termux-shared')",
      'project(":app")',
      "project(':app')",
    ],
  });

  if (missingRequired.length > 0) {
    return {
      status: 'blocked',
      reason: 'missing-required-termux-modules',
      missingRequired,
      forbiddenPresent,
      forbiddenReferences,
    };
  }

  if (forbiddenPresent.length > 0) {
    return {
      status: 'blocked',
      reason: 'forbidden-termux-modules-present',
      missingRequired,
      forbiddenPresent,
      forbiddenReferences,
    };
  }

  if (forbiddenReferences.length > 0) {
    return {
      status: 'blocked',
      reason: 'forbidden-termux-dependency-reference',
      missingRequired,
      forbiddenPresent,
      forbiddenReferences,
    };
  }

  return {
    status: 'ok',
    modules: requiredModules,
    forbiddenPresent,
    forbiddenReferences,
    metadata: await readOptionalJson(join(sourceRoot, TERMUX_ANDROID_VENDOR_METADATA_FILE)),
  };
}

export async function installTermuxAndroidSource({ sourceRoot, vendorRoot, observedCommit }) {
  const policy = await readTermuxAndroidPolicy();
  const tempRoot = await mkdtemp(join(tmpdir(), 'happier-termux-android-vendor-'));

  try {
    for (const module of policy.upstream.modules) {
      await copyAllowedTermuxModule({
        sourceModuleRoot: join(sourceRoot, module.path),
        targetModuleRoot: join(tempRoot, module.path),
        moduleName: module.name,
      });
    }

    await patchTermuxViewResourceImports(tempRoot);

    const metadata = {
      observedCommit,
      upstream: {
        name: policy.upstream.name,
        url: policy.upstream.url,
        observedCommit,
      },
      sourceStrategy: policy.sourceStrategy,
      modules: policy.upstream.modules,
      forbiddenModules: policy.forbiddenModules,
      license: policy.license,
      installedBy: policy.sourceStrategy.fetchScript,
    };

    await writeFile(
      join(tempRoot, TERMUX_ANDROID_VENDOR_METADATA_FILE),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );

    const validation = await validateTermuxAndroidSource({ sourceRoot: tempRoot });
    if (validation.status !== 'ok') {
      return {
        status: 'blocked',
        reason: validation.reason,
        validation,
      };
    }

    await rm(vendorRoot, { force: true, recursive: true });
    await mkdir(dirname(vendorRoot), { recursive: true });
    await cp(tempRoot, vendorRoot, { recursive: true });

    return {
      status: 'ok',
      vendorRoot,
      metadata,
      validation,
    };
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

export async function ensureTermuxAndroidSourceFromEnvironment({
  vendorRoot = join(packageRoot, 'android', 'termux', 'vendor'),
  sourceRoot = process.env[TERMUX_SOURCE_ROOT_ENV],
  observedCommit,
} = {}) {
  const policy = await readTermuxAndroidPolicy();
  const commit = observedCommit ?? policy.upstream.observedCommit;
  const root = sourceRoot?.trim();

  if (!root) {
    return {
      status: 'blocked',
      reason: 'missing-termux-source-root-env',
      sourceEnv: TERMUX_SOURCE_ROOT_ENV,
      detail: `Set ${TERMUX_SOURCE_ROOT_ENV} to a locally audited Termux checkout pinned to ${commit}.`,
      upstream: policy.upstream,
      forbiddenModules: policy.forbiddenModules,
    };
  }

  return installTermuxAndroidSource({
    sourceRoot: root,
    vendorRoot,
    observedCommit: commit,
  });
}

async function copyAllowedTermuxModule({ sourceModuleRoot, targetModuleRoot, moduleName }) {
  if (!await exists(sourceModuleRoot)) {
    throw new Error(`Missing Termux module source: ${moduleName}`);
  }

  await mkdir(targetModuleRoot, { recursive: true });
  for (const fileName of ['build.gradle', 'proguard-rules.pro']) {
    await copyIfExists(join(sourceModuleRoot, fileName), join(targetModuleRoot, fileName));
  }

  await copyIfExists(
    join(sourceModuleRoot, 'src', 'main', 'java'),
    join(targetModuleRoot, 'src', 'main', 'java'),
  );
  await copyIfExists(
    join(sourceModuleRoot, 'src', 'main', 'res'),
    join(targetModuleRoot, 'src', 'main', 'res'),
  );
  await copyIfExists(
    join(sourceModuleRoot, 'src', 'main', 'AndroidManifest.xml'),
    join(targetModuleRoot, 'src', 'main', 'AndroidManifest.xml'),
  );
}

async function patchTermuxViewResourceImports(root) {
  const javaFiles = await listFiles(root, (filePath) => filePath.endsWith('.java'));
  await Promise.all(javaFiles.map(async (filePath) => {
    const source = await readFile(filePath, 'utf-8');
    const patched = source.replaceAll('import com.termux.view.R;', 'import dev.happier.terminal.R;');
    if (patched !== source) {
      await writeFile(filePath, patched);
    }
  }));
}

async function findForbiddenReferences({ sourceRoot, forbiddenTokens }) {
  const files = await listFiles(sourceRoot, (filePath) => (
    filePath.endsWith('.java')
    || filePath.endsWith('.kt')
    || filePath.endsWith('.gradle')
    || filePath.endsWith('.xml')
  ));
  const matches = [];

  for (const filePath of files) {
    const content = stripComments(await readFile(filePath, 'utf-8'));
    for (const token of forbiddenTokens) {
      if (content.includes(token)) {
        matches.push({
          file: relative(sourceRoot, filePath),
          token,
        });
      }
    }
  }

  return matches;
}

function stripComments(content) {
  return content
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replaceAll(/\/\/.*$/g, ''))
    .join('\n');
}

async function copyIfExists(source, target) {
  if (!await exists(source)) return;
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
}

async function readOptionalJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return null;
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(root, predicate) {
  if (!await exists(root)) return [];
  const files = [];
  const entries = await readdir(root, { withFileTypes: true });

  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(path, predicate));
    } else if (entry.isFile() && predicate(path)) {
      files.push(path);
    }
  }

  return files;
}
