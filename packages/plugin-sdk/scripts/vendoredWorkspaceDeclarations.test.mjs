import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertVendoredWorkspaceDeclarationsAreCurrent } from './vendoredWorkspaceDeclarations.mjs';

/**
 * Builds a throwaway repository whose layout matches the real one: a workspace
 * package under `packages/<name>`, the yarn workspace link the package name
 * resolves through, and — optionally — the physical vendored copy
 * `bundleWorkspaceDeps` publishes under the host package's own `node_modules`.
 */
async function createRepoFixture({ vendoredDeclarations }) {
  const repoRoot = await mkdtemp(resolve(tmpdir(), 'vendored-declarations-'));
  const packageRoot = resolve(repoRoot, 'packages', 'plugin-sdk');
  const workspaceRoot = resolve(repoRoot, 'packages', 'protocol');

  await writeFile(resolve(repoRoot, 'package.json'), `${JSON.stringify({ private: true }, null, 2)}\n`);
  await writeFile(resolve(repoRoot, 'yarn.lock'), '# fixture\n');

  await mkdir(resolve(workspaceRoot, 'dist', 'plugins'), { recursive: true });
  await writeFile(
    resolve(workspaceRoot, 'package.json'),
    `${JSON.stringify({ name: '@happier-dev/protocol', version: '0.0.0' }, null, 2)}\n`,
  );
  await writeFile(
    resolve(workspaceRoot, 'dist', 'plugins', 'manifest.d.ts'),
    'export type PluginDeclarativeNodeV2 = { kind: string };\n',
  );
  await writeFile(resolve(workspaceRoot, 'dist', 'plugins', 'manifest.js'), 'export {};\n');

  await mkdir(resolve(repoRoot, 'node_modules', '@happier-dev'), { recursive: true });
  await symlink(
    resolve(repoRoot, 'packages', 'protocol'),
    resolve(repoRoot, 'node_modules', '@happier-dev', 'protocol'),
  );

  await mkdir(packageRoot, { recursive: true });
  if (vendoredDeclarations) {
    const vendorRoot = resolve(packageRoot, 'node_modules', '@happier-dev', 'protocol');
    await mkdir(vendorRoot, { recursive: true });
    await writeFile(
      resolve(vendorRoot, 'package.json'),
      `${JSON.stringify({ name: '@happier-dev/protocol', version: '0.0.0' }, null, 2)}\n`,
    );
    for (const [relativePath, contents] of Object.entries(vendoredDeclarations)) {
      const absolutePath = resolve(vendorRoot, relativePath);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, contents);
    }
  }

  return { repoRoot, packageRoot, workspaceRoot };
}

test('vendored declaration freshness accepts a package that resolves through the workspace link', async () => {
  const fixture = await createRepoFixture({ vendoredDeclarations: null });
  try {
    await assertVendoredWorkspaceDeclarationsAreCurrent({
      packageRoot: fixture.packageRoot,
      repoRoot: fixture.repoRoot,
    });
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('vendored declaration freshness accepts a copy whose declarations match the workspace build', async () => {
  const fixture = await createRepoFixture({
    vendoredDeclarations: {
      'dist/plugins/manifest.d.ts': 'export type PluginDeclarativeNodeV2 = { kind: string };\n',
      'dist/plugins/manifest.js': 'export {};\n',
    },
  });
  try {
    await assertVendoredWorkspaceDeclarationsAreCurrent({
      packageRoot: fixture.packageRoot,
      repoRoot: fixture.repoRoot,
    });
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('vendored declaration freshness ignores canonical workspace sync staging copies', async () => {
  const fixture = await createRepoFixture({
    vendoredDeclarations: {
      'dist/plugins/manifest.d.ts': 'export type PluginDeclarativeNodeV2 = { kind: string };\n',
      'dist/plugins/manifest.js': 'export {};\n',
    },
  });
  try {
    for (const stagingName of [
      '.protocol.__sync_tmp__.12345',
      '.protocol.__sync_backup__.12345',
    ]) {
      const stagingRoot = resolve(
        fixture.packageRoot,
        'node_modules',
        '@happier-dev',
        stagingName,
      );
      await mkdir(resolve(stagingRoot, 'dist', 'plugins'), { recursive: true });
      await writeFile(
        resolve(stagingRoot, 'dist', 'plugins', 'manifest.d.ts'),
        'export type PluginDeclarativeNodeV2 = never;\n',
      );
    }

    await assert.doesNotReject(
      assertVendoredWorkspaceDeclarationsAreCurrent({
        packageRoot: fixture.packageRoot,
        repoRoot: fixture.repoRoot,
      }),
    );
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('vendored declaration freshness rejects a copy that predates a workspace declaration change', async () => {
  const fixture = await createRepoFixture({
    vendoredDeclarations: {
      'dist/plugins/manifest.d.ts': 'export type PluginDeclarativeNodeV2 = never;\n',
      'dist/plugins/manifest.js': 'export {};\n',
    },
  });
  try {
    await assert.rejects(
      assertVendoredWorkspaceDeclarationsAreCurrent({
        packageRoot: fixture.packageRoot,
        repoRoot: fixture.repoRoot,
      }),
      (error) => {
        assert.match(error.message, /@happier-dev\/protocol/u);
        assert.match(error.message, /dist\/plugins\/manifest\.d\.ts/u);
        assert.match(error.message, /node \.\/scripts\/bundleWorkspaceDeps\.mjs/u);
        return true;
      },
    );
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('vendored declaration freshness rejects a declaration the workspace build no longer produces', async () => {
  const fixture = await createRepoFixture({
    vendoredDeclarations: {
      'dist/plugins/manifest.d.ts': 'export type PluginDeclarativeNodeV2 = { kind: string };\n',
      'dist/plugins/manifest.js': 'export {};\n',
      'dist/plugins/retired.d.ts': 'export type RetiredV1 = string;\n',
    },
  });
  try {
    await assert.rejects(
      assertVendoredWorkspaceDeclarationsAreCurrent({
        packageRoot: fixture.packageRoot,
        repoRoot: fixture.repoRoot,
      }),
      (error) => {
        assert.match(error.message, /dist\/plugins\/retired\.d\.ts/u);
        return true;
      },
    );
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('vendored declaration freshness has nothing to assert outside a monorepo checkout', async () => {
  const fixture = await createRepoFixture({
    vendoredDeclarations: {
      'dist/plugins/manifest.d.ts': 'export type PluginDeclarativeNodeV2 = never;\n',
    },
  });
  await rm(resolve(fixture.repoRoot, 'yarn.lock'), { force: true });
  try {
    await assertVendoredWorkspaceDeclarationsAreCurrent({ packageRoot: fixture.packageRoot });
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('vendored declaration freshness rejects a copy it cannot compare against a workspace package', async () => {
  const fixture = await createRepoFixture({
    vendoredDeclarations: {
      'dist/plugins/manifest.d.ts': 'export type PluginDeclarativeNodeV2 = { kind: string };\n',
    },
  });
  await rm(resolve(fixture.repoRoot, 'node_modules', '@happier-dev', 'protocol'), { force: true });
  try {
    await assert.rejects(
      assertVendoredWorkspaceDeclarationsAreCurrent({
        packageRoot: fixture.packageRoot,
        repoRoot: fixture.repoRoot,
      }),
      (error) => {
        assert.match(error.message, /@happier-dev\/protocol/u);
        return true;
      },
    );
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('the plugin-sdk API surface run guards vendored declaration freshness before it reads types', async () => {
  const { runApiSurfaceCli } = await import('./apiSurfaceCli.mjs');
  const phases = [];

  await runApiSurfaceCli({
    packageRoot: fileURLToPath(new URL('..', import.meta.url)),
    check: true,
    onProgress: (phase) => phases.push(phase),
  });

  assert.ok(
    phases.includes('vendored-declarations'),
    `API surface run must guard vendored declarations; observed phases: ${phases.join(', ')}`,
  );
  assert.ok(
    phases.indexOf('vendored-declarations') < phases.indexOf('author-signature-closure'),
    'the vendored declaration guard must run before any phase that reads vendored types',
  );
});
