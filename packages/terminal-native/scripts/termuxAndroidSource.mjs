import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { replaceDirectoryPreservingLastGood } from './atomicNativeBuildInputInstall.mjs';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const policyPath = join(packageRoot, 'native-renderers.json');
const TERMUX_SOURCE_ROOT_ENV = 'HAPPIER_TERMINAL_NATIVE_TERMUX_SOURCE_ROOT';
const TERMUX_SOURCE_COMMIT_ENV = 'HAPPIER_TERMINAL_NATIVE_TERMUX_COMMIT';
const TERMUX_PACKAGE_NOTICE_PATH = 'android/termux/NOTICE.md';
const TERMUX_UPSTREAM_LICENSE_FILE = 'TERMUX-UPSTREAM-LICENSE.md';
const TERMUX_UPSTREAM_NOTICE_FILE = 'TERMUX-UPSTREAM-NOTICE.md';
const execFileAsync = promisify(execFile);

export const TERMUX_ANDROID_VENDOR_METADATA_FILE = 'TERMUX-SOURCE.json';

export async function readTermuxAndroidPolicy() {
  const policy = JSON.parse(await readFile(policyPath, 'utf-8'));
  return policy.androidTermux;
}

export async function validateTermuxAndroidSource({ sourceRoot }) {
  const policy = await readTermuxAndroidPolicy();
  const requiredModules = policy.upstream.modules;
  const forbiddenModules = policy.forbiddenModules;
  const metadata = await readOptionalJson(join(sourceRoot, TERMUX_ANDROID_VENDOR_METADATA_FILE));
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

  const provenance = await validateTermuxVendorProvenance({
    sourceRoot,
    policy,
    metadata,
  });
  if (provenance != null) {
    return {
      status: 'blocked',
      reason: provenance.reason,
      detail: provenance.detail,
      missingRequired,
      forbiddenPresent,
      forbiddenReferences,
      metadata,
    };
  }

  return {
    status: 'ok',
    modules: requiredModules,
    forbiddenPresent,
    forbiddenReferences,
    metadata,
  };
}

export async function installTermuxAndroidSource({ sourceRoot, vendorRoot, observedCommit, sourceArchive }) {
  const policy = await readTermuxAndroidPolicy();
  const expectedCommit = policy.upstream.observedCommit;
  if (observedCommit !== expectedCommit) {
    return {
      status: 'blocked',
      reason: 'termux-source-revision-mismatch',
      detail: `Termux source revision must be ${expectedCommit}.`,
      expectedCommit,
      observedCommit,
    };
  }

  const licenseClosure = await copyTermuxLicenseClosure({
    sourceRoot,
    targetRoot: null,
    policy,
  });
  if (licenseClosure.status !== 'ok') {
    return licenseClosure;
  }

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
    await copyTermuxLicenseClosure({
      sourceRoot,
      targetRoot: tempRoot,
      closure: licenseClosure.closure,
      policy,
    });

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
      licenseClosure: licenseClosure.closure,
      installedBy: policy.sourceStrategy.fetchScript,
      ...(sourceArchive ? { sourceArchive } : {}),
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

    const vendorParent = dirname(vendorRoot);
    await mkdir(vendorParent, { recursive: true });
    const stagingRoot = await mkdtemp(join(vendorParent, `.${basename(vendorRoot)}-`));
    const stagedVendorRoot = join(stagingRoot, basename(vendorRoot));
    try {
      await cp(tempRoot, stagedVendorRoot, { recursive: true });
      await replaceDirectoryPreservingLastGood({
        stagedPath: stagedVendorRoot,
        destinationPath: vendorRoot,
        validate: () => validateTermuxAndroidSource({ sourceRoot: vendorRoot }),
      });
    } finally {
      await rm(stagingRoot, { force: true, recursive: true });
    }

    return {
      status: 'ok',
      vendorRoot,
      metadata,
      validation: await validateTermuxAndroidSource({ sourceRoot: vendorRoot }),
    };
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

export async function ensureTermuxAndroidSourceFromEnvironment({
  vendorRoot = join(packageRoot, 'android', 'termux', 'vendor'),
  sourceRoot = process.env[TERMUX_SOURCE_ROOT_ENV],
  observedCommit = process.env[TERMUX_SOURCE_COMMIT_ENV],
} = {}) {
  const policy = await readTermuxAndroidPolicy();
  const expectedCommit = policy.upstream.observedCommit;
  const requestedCommit = observedCommit?.trim();
  const root = sourceRoot?.trim();

  if (requestedCommit && requestedCommit !== expectedCommit) {
    return {
      status: 'blocked',
      reason: 'termux-source-revision-mismatch',
      detail: `HAPPIER_TERMINAL_NATIVE_TERMUX_COMMIT must equal ${expectedCommit}.`,
      expectedCommit,
      observedCommit: requestedCommit,
      upstream: policy.upstream,
    };
  }

  if (!root) {
    return {
      status: 'blocked',
      reason: 'missing-termux-source-root-env',
      sourceEnv: TERMUX_SOURCE_ROOT_ENV,
      detail: `Set ${TERMUX_SOURCE_ROOT_ENV} to a clean locally audited Termux checkout pinned to ${expectedCommit}.`,
      upstream: policy.upstream,
      forbiddenModules: policy.forbiddenModules,
    };
  }

  const checkout = await inspectTermuxCheckout({ sourceRoot: root, expectedCommit });
  if (checkout.status !== 'ok') {
    return {
      ...checkout,
      upstream: policy.upstream,
      forbiddenModules: policy.forbiddenModules,
    };
  }

  return installTermuxAndroidSource({
    sourceRoot: root,
    vendorRoot,
    observedCommit: checkout.observedCommit,
  });
}

async function inspectTermuxCheckout({ sourceRoot, expectedCommit }) {
  let observedCommit;
  try {
    ({ stdout: observedCommit } = await execFileAsync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD']));
  } catch {
    return {
      status: 'blocked',
      reason: 'termux-source-provenance-unverified',
      detail: 'Termux source must be a readable Git checkout so its exact revision can be verified.',
    };
  }

  observedCommit = observedCommit.trim();
  if (observedCommit !== expectedCommit) {
    return {
      status: 'blocked',
      reason: 'termux-source-revision-mismatch',
      detail: `Termux checkout is at ${observedCommit || 'an unknown revision'}, not ${expectedCommit}.`,
      expectedCommit,
      observedCommit,
    };
  }

  try {
    const { stdout: dirtyStatus } = await execFileAsync('git', [
      '-C',
      sourceRoot,
      'status',
      '--porcelain',
      '--untracked-files=all',
    ]);
    if (dirtyStatus.trim()) {
      return {
        status: 'blocked',
        reason: 'termux-source-dirty',
        detail: 'Termux source checkout has tracked or untracked changes; extract from a clean checkout.',
        observedCommit,
      };
    }
  } catch {
    return {
      status: 'blocked',
      reason: 'termux-source-provenance-unverified',
      detail: 'Termux source checkout cleanliness could not be verified.',
      observedCommit,
    };
  }

  return {
    status: 'ok',
    observedCommit,
  };
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

async function copyTermuxLicenseClosure({ sourceRoot, targetRoot, closure, policy }) {
  const upstreamLicensePath = join(sourceRoot, 'LICENSE.md');
  if (!await exists(upstreamLicensePath)) {
    return {
      status: 'blocked',
      reason: 'termux-source-license-missing',
      detail: 'Termux source must include its root LICENSE.md before terminal libraries are extracted.',
    };
  }

  const upstreamNoticeSource = await firstExistingPath(sourceRoot, ['NOTICE', 'NOTICE.md']);
  const resolvedClosure = closure ?? {
    upstreamLicensePath: TERMUX_UPSTREAM_LICENSE_FILE,
    upstreamNoticePath: upstreamNoticeSource == null ? null : TERMUX_UPSTREAM_NOTICE_FILE,
    noticePath: TERMUX_PACKAGE_NOTICE_PATH,
    redistributionLicensePath: policy.license.redistributionLicensePath,
    redistributionLicenseSha256: policy.license.redistributionLicenseSha256,
    redistributionNoticePath: policy.license.redistributionNoticePath,
    redistributionNoticeSha256: policy.license.redistributionNoticeSha256,
  };

  const redistributionLicensePath = join(packageRoot, resolvedClosure.redistributionLicensePath);
  const redistributionNoticePath = join(packageRoot, resolvedClosure.redistributionNoticePath);
  if (!await exists(redistributionLicensePath)
    || !await exists(redistributionNoticePath)
    || await sha256File(redistributionLicensePath) !== resolvedClosure.redistributionLicenseSha256
    || await sha256File(redistributionNoticePath) !== resolvedClosure.redistributionNoticeSha256) {
    return {
      status: 'blocked',
      reason: 'termux-redistribution-license-closure-invalid',
      detail: 'The complete Apache-2.0 license and Termux attribution must match the policy-pinned distribution files.',
    };
  }

  if (targetRoot != null) {
    await cp(upstreamLicensePath, join(targetRoot, resolvedClosure.upstreamLicensePath));
    if (upstreamNoticeSource != null && resolvedClosure.upstreamNoticePath != null) {
      await cp(upstreamNoticeSource, join(targetRoot, resolvedClosure.upstreamNoticePath));
    }
  }

  return {
    status: 'ok',
    closure: resolvedClosure,
  };
}

async function validateTermuxVendorProvenance({ sourceRoot, policy, metadata }) {
  if (!isRecord(metadata)
    || metadata.observedCommit !== policy.upstream.observedCommit
    || !isRecord(metadata.upstream)
    || metadata.upstream.name !== policy.upstream.name
    || metadata.upstream.url !== policy.upstream.url
    || metadata.upstream.observedCommit !== policy.upstream.observedCommit
    || !sameJson(metadata.modules, policy.upstream.modules)
    || !sameJson(metadata.forbiddenModules, policy.forbiddenModules)
    || !sameJson(metadata.sourceStrategy, policy.sourceStrategy)
    || !sameJson(metadata.license, policy.license)
    || (metadata.sourceArchive !== undefined
      && !sameJson(metadata.sourceArchive, policy.upstream.sourceArchive))) {
    return {
      reason: 'termux-source-provenance-unverified',
      detail: 'Termux vendor source must record the policy-pinned revision, terminal-only module closure, and license policy.',
    };
  }

  const closure = metadata.licenseClosure;
  if (!isRecord(closure)
    || closure.upstreamLicensePath !== TERMUX_UPSTREAM_LICENSE_FILE
    || (closure.upstreamNoticePath !== null && closure.upstreamNoticePath !== TERMUX_UPSTREAM_NOTICE_FILE)
    || closure.noticePath !== TERMUX_PACKAGE_NOTICE_PATH
    || closure.redistributionLicensePath !== policy.license.redistributionLicensePath
    || closure.redistributionLicenseSha256 !== policy.license.redistributionLicenseSha256
    || closure.redistributionNoticePath !== policy.license.redistributionNoticePath
    || closure.redistributionNoticeSha256 !== policy.license.redistributionNoticeSha256
    || !await exists(join(sourceRoot, TERMUX_UPSTREAM_LICENSE_FILE))
    || (closure.upstreamNoticePath != null && !await exists(join(sourceRoot, closure.upstreamNoticePath)))
    || !await exists(join(packageRoot, TERMUX_PACKAGE_NOTICE_PATH))
    || !await exists(join(packageRoot, closure.redistributionLicensePath))
    || !await exists(join(packageRoot, closure.redistributionNoticePath))
    || await sha256File(join(packageRoot, closure.redistributionLicensePath)) !== closure.redistributionLicenseSha256
    || await sha256File(join(packageRoot, closure.redistributionNoticePath)) !== closure.redistributionNoticeSha256) {
    return {
      reason: 'termux-source-license-closure-missing',
      detail: 'Termux vendor source must retain its upstream license and the package Android notice closure.',
    };
  }

  return null;
}

async function sha256File(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
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

async function firstExistingPath(root, names) {
  for (const name of names) {
    const candidate = join(root, name);
    if (await exists(candidate)) return candidate;
  }
  return null;
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

function isRecord(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
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
