import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyRewriteMap,
  buildEscapeRewriteMap,
  findMonorepoRootFrom,
  patchExtractedPackage,
  patchPackedTarballForWorkspaces,
  rewriteBackToUtilsImport,
  VENDOR_SPECS,
} from './patchPackedTarballForWorkspaces.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function tarCreate(outTarball, cwd) {
  execFileSync('tar', ['-czf', outTarball, '-C', cwd, 'package'], { stdio: 'pipe' });
}

function tarExtract(tarball, cwd) {
  execFileSync('tar', ['-xzf', tarball, '-C', cwd], { stdio: 'pipe' });
}

const PM_ESCAPE = "from '../../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';";
const PM_REWRITTEN = "from '../workspaces/ensureWorkspacePackagesBuilt.mjs';";
const PROCINST_ESCAPE = "from '../../../../../packages/cli-common/processInstance.mjs';";
const PROCINST_REWRITTEN = "from '../workspaces/processInstance.mjs';";
const BACK_IMPORT = "from '../../apps/stack/scripts/utils/paths/paths.mjs';";
const BACK_REWRITTEN = "from '../paths/paths.mjs';";

// Build a fake monorepo root (with the escaped source files) + a fake extracted package/ (with the
// escaping importers). Mirrors the real layout: source files live under scripts/workspaces/ and
// packages/cli-common/, importers under apps/stack's scripts/utils/{proc,stack}/.
function buildFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'happier-stack-postpack-test-'));
  const monorepoRoot = path.join(root, 'source-root');

  // Escaped source files (repo-root-relative per VENDOR_SPECS).
  mkdirSync(path.join(monorepoRoot, 'scripts', 'workspaces'), { recursive: true });
  writeFileSync(
    path.join(monorepoRoot, 'scripts', 'workspaces', 'ensureWorkspacePackagesBuilt.mjs'),
    `import { resolveYarnCommandInvocation } from './execYarnCommand.mjs'\nimport { coerceHappyMonorepoRootFromPath } ${BACK_IMPORT}\nexport async function ensureWorkspacePackagesBuiltForComponent() {}\n`,
  );
  writeFileSync(
    path.join(monorepoRoot, 'scripts', 'workspaces', 'execYarnCommand.mjs'),
    `import { execFileSync } from 'node:child_process';\nexport function resolveYarnCommandInvocation() {}\n`,
  );
  writeFileSync(
    path.join(monorepoRoot, 'scripts', 'workspaces', 'workspacePackageBuildLock.mjs'),
    `import { coerceHappyMonorepoRootFromPath } ${BACK_IMPORT}\nexport function resolveWorkspacePackageBuildLockPath() {}\n`,
  );
  mkdirSync(path.join(monorepoRoot, 'packages', 'cli-common'), { recursive: true });
  writeFileSync(
    path.join(monorepoRoot, 'packages', 'cli-common', 'processInstance.mjs'),
    `import { spawnSync } from 'node:child_process';\nimport { readFileSync } from 'node:fs';\nexport function readProcessInstanceFingerprintSync() {}\n`,
  );

  // Fake packed package/ tree with the escaping importers.
  const packageDir = path.join(root, 'package');
  const procDir = path.join(packageDir, 'scripts', 'utils', 'proc');
  const stackDir = path.join(packageDir, 'scripts', 'utils', 'stack');
  mkdirSync(procDir, { recursive: true });
  mkdirSync(stackDir, { recursive: true });
  writeFileSync(path.join(packageDir, 'package.json'), '{"name":"@happier-dev/stack","version":"0.0.0"}\n');
  writeFileSync(
    path.join(procDir, 'pm.mjs'),
    `import { ensureWorkspacePackagesBuiltForComponent } ${PM_ESCAPE}\nexport { ensureWorkspacePackagesBuiltForComponent };\n`,
  );
  writeFileSync(
    path.join(procDir, 'ensureWorkspacePackagesBuilt.test.mjs'),
    `import { ensureWorkspacePackagesBuiltForComponent } ${PM_ESCAPE}\nimport { test } from 'node:test';\n`,
  );
  writeFileSync(
    path.join(stackDir, 'runtime_daemon_state.mjs'),
    `import { readProcessInstanceFingerprintSync } ${PROCINST_ESCAPE}\nexport function readRuntimeDaemonState() {}\n`,
  );

  return { root, monorepoRoot, packageDir };
}

test('rewriteBackToUtilsImport rewrites the apps/stack back-import to an in-package relative path', () => {
  const out = rewriteBackToUtilsImport(`import { x } ${BACK_IMPORT}\n`);
  assert.equal(out, `import { x } ${BACK_REWRITTEN}\n`);
});

test('buildEscapeRewriteMap maps every VENDOR_SPEC escape to its vendored import', () => {
  const map = buildEscapeRewriteMap();
  assert.equal(map.size, VENDOR_SPECS.length);
  assert.equal(map.get("../../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs"), '../workspaces/ensureWorkspacePackagesBuilt.mjs');
  assert.equal(map.get("../../../../../packages/cli-common/processInstance.mjs"), '../workspaces/processInstance.mjs');
});

test('applyRewriteMap rewrites all known escapes in a single pass', () => {
  const out = applyRewriteMap(`a ${PM_ESCAPE}\nb ${PROCINST_ESCAPE}\n`, buildEscapeRewriteMap());
  assert.ok(out.includes(PM_REWRITTEN));
  assert.ok(out.includes(PROCINST_REWRITTEN));
  assert.ok(!out.includes('../../../../../'));
});

test('patchExtractedPackage vendors every spec and rewrites every escaping import', () => {
  const { root, monorepoRoot, packageDir } = buildFixture();
  try {
    patchExtractedPackage({ extractedPackageDir: packageDir, monorepoRoot });

    const vendoredDir = path.join(packageDir, 'scripts', 'utils', 'workspaces');
    for (const spec of VENDOR_SPECS) {
      assert.ok(existsSync(path.join(vendoredDir, path.basename(spec))), `vendored file missing: ${spec}`);
    }

    // Vendored helpers had their back-imports rewritten (processInstance.mjs has none — unchanged).
    const vendoredEnsure = readFileSync(path.join(vendoredDir, 'ensureWorkspacePackagesBuilt.mjs'), 'utf8');
    assert.ok(!vendoredEnsure.includes('../../apps/stack/scripts/utils/'));
    assert.ok(vendoredEnsure.includes('../paths/paths.mjs'));
    const vendoredProcInst = readFileSync(path.join(vendoredDir, 'processInstance.mjs'), 'utf8');
    assert.ok(vendoredProcInst.includes("from 'node:child_process'"));

    // pm.mjs + packed test had their scripts/workspaces escape rewritten.
    const pm = readFileSync(path.join(packageDir, 'scripts', 'utils', 'proc', 'pm.mjs'), 'utf8');
    assert.ok(pm.includes('../workspaces/ensureWorkspacePackagesBuilt.mjs'));
    assert.ok(!pm.includes('../../../../../scripts/workspaces/'));

    const packedTest = readFileSync(path.join(packageDir, 'scripts', 'utils', 'proc', 'ensureWorkspacePackagesBuilt.test.mjs'), 'utf8');
    assert.ok(packedTest.includes('../workspaces/ensureWorkspacePackagesBuilt.mjs'));

    // runtime_daemon_state.mjs had its packages/cli-common escape rewritten.
    const rds = readFileSync(path.join(packageDir, 'scripts', 'utils', 'stack', 'runtime_daemon_state.mjs'), 'utf8');
    assert.ok(rds.includes('../workspaces/processInstance.mjs'));
    assert.ok(!rds.includes('../../../../../packages/cli-common/'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('patchPackedTarballForWorkspaces round-trips a real tarball: all specs vendored + imports rewritten', () => {
  const { root, monorepoRoot, packageDir } = buildFixture();
  const tarballPath = path.join(root, 'artifact.tgz');
  tarCreate(tarballPath, root);

  const extractDir = mkdtempSync(path.join(os.tmpdir(), 'happier-stack-postpack-extract-'));
  try {
    const result = patchPackedTarballForWorkspaces({ tarballPath, monorepoRoot });
    assert.equal(result.tarballPath, tarballPath);

    tarExtract(tarballPath, extractDir);
    const extractedPackage = path.join(extractDir, 'package');
    const vendoredDir = path.join(extractedPackage, 'scripts', 'utils', 'workspaces');
    for (const spec of VENDOR_SPECS) {
      assert.ok(existsSync(path.join(vendoredDir, path.basename(spec))), `vendored missing in tarball: ${spec}`);
    }

    const pm = readFileSync(path.join(extractedPackage, 'scripts', 'utils', 'proc', 'pm.mjs'), 'utf8');
    assert.ok(pm.includes('../workspaces/ensureWorkspacePackagesBuilt.mjs'));
    const rds = readFileSync(path.join(extractedPackage, 'scripts', 'utils', 'stack', 'runtime_daemon_state.mjs'), 'utf8');
    assert.ok(rds.includes('../workspaces/processInstance.mjs'));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(extractDir, { recursive: true, force: true });
  }
});

// Guard: the real repo files must still use the import prefixes this postpack rewrites. If someone
// changes the import style in pm.mjs / runtime_daemon_state.mjs or the vendored sources, this fails
// loudly so the postpack transform stays in sync with the source.
test('real repo escaping imports + vendor sources still use the prefixes this postpack rewrites', () => {
  const repoRoot = findMonorepoRootFrom(__dirname);
  assert.ok(repoRoot, 'could not locate monorepo root from postpack test');

  const realPm = path.join(repoRoot, 'apps', 'stack', 'scripts', 'utils', 'proc', 'pm.mjs');
  const realRds = path.join(repoRoot, 'apps', 'stack', 'scripts', 'utils', 'stack', 'runtime_daemon_state.mjs');
  const realEnsure = path.join(repoRoot, 'scripts', 'workspaces', 'ensureWorkspacePackagesBuilt.mjs');
  assert.ok(existsSync(realPm), `real pm.mjs missing at ${realPm}`);
  assert.ok(existsSync(realRds), `real runtime_daemon_state.mjs missing at ${realRds}`);
  assert.ok(existsSync(realEnsure), `real ensureWorkspacePackagesBuilt.mjs missing at ${realEnsure}`);

  const pmContent = readFileSync(realPm, 'utf8');
  assert.ok(
    pmContent.includes('../../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs'),
    'pm.mjs no longer imports the repo-root workspace helper — postpack rewrite may be stale',
  );

  const rdsContent = readFileSync(realRds, 'utf8');
  assert.ok(
    rdsContent.includes('../../../../../packages/cli-common/processInstance.mjs'),
    'runtime_daemon_state.mjs no longer imports the repo-root cli-common helper — postpack rewrite may be stale',
  );

  const ensureContent = readFileSync(realEnsure, 'utf8');
  assert.ok(
    ensureContent.includes('../../apps/stack/scripts/utils/'),
    'ensureWorkspacePackagesBuilt.mjs no longer reaches back into apps/stack/scripts/utils — postpack rewrite may be stale',
  );
});
