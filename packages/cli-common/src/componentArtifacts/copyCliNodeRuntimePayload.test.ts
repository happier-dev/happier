import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import {
  compareCliNodeRuntimePayloadEntryNames,
  copyCliNodeRuntimePayload,
  copyCliNodeWorkspaceRuntimePackagesFromRuntimeRoot,
  readCliNodeWorkspaceRuntimeIdentity,
} from './copyCliNodeRuntimePayload.js';

function writeWorkspacePackage(
  root: string,
  source: string,
  packageName = '@happier-dev/protocol',
): void {
  const packageJson = `${JSON.stringify({
    name: packageName,
    private: true,
    type: 'module',
    exports: { '.': './dist/index.js' },
  }, null, 2)}\n`;
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'package.json'), packageJson, 'utf8');
  writeFileSync(join(root, 'dist', 'index.js'), source, 'utf8');
}

it('orders Unicode sibling names by code units for a locale-independent runtime identity', () => {
  const siblingNames = ['🧪', 'ä', 'z'];
  const codeUnitOrder = ['z', 'ä', '🧪'];

  expect([...siblingNames].sort(compareCliNodeRuntimePayloadEntryNames)).toEqual(codeUnitOrder);
  expect([...siblingNames].sort((left, right) => left.localeCompare(right, 'sv-SE')))
    .not.toEqual(codeUnitOrder);
  expect([...siblingNames].sort((left, right) => left.localeCompare(right, 'de-DE')))
    .not.toEqual(codeUnitOrder);
  // U+10000 begins with a surrogate code unit below U+E000, unlike code-point
  // or UTF-8 byte ordering.
  expect(compareCliNodeRuntimePayloadEntryNames('\u{10000}', '\uE000')).toBeLessThan(0);
});

it('rejects workspace package bytes that do not match the admitted runtime identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-cli-runtime-workspace-'));
  try {
    const packageName = '@happier-dev/protocol';
    const hostRoot = join(root, 'apps', 'cli');
    mkdirSync(hostRoot, { recursive: true });
    writeFileSync(join(hostRoot, 'package.json'), JSON.stringify({
      name: '@happier-dev/cli',
      dependencies: { [packageName]: 'workspace:*' },
      bundledDependencies: [packageName],
    }), 'utf8');
    writeWorkspacePackage(join(root, 'packages', 'protocol'), 'export const generation = "source";\n');
    writeWorkspacePackage(
      join(hostRoot, 'node_modules', '@happier-dev', 'protocol'),
      'export const generation = "admitted";\n',
    );
    const admittedIdentity = readCliNodeWorkspaceRuntimeIdentity({ repoRoot: root });

    const runtimeRoot = join(root, 'runtime-artifact');
    writeWorkspacePackage(
      join(runtimeRoot, 'node_modules', '@happier-dev', 'protocol'),
      'export const generation = "tampered";\n',
    );

    expect(() => copyCliNodeWorkspaceRuntimePackagesFromRuntimeRoot({
      runtimeRoot,
      payloadDir: join(root, 'pinned-runner'),
      packageNames: admittedIdentity.packageNames,
      expectedWorkspaceRuntimeIdentity: admittedIdentity.fingerprint,
    })).toThrow(/does not match its dist publication/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('preserves hidden workspace runtime files when pinning an admitted runtime root', () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-cli-runtime-hidden-file-'));
  try {
    const packageName = '@happier-dev/plugins-example';
    const runtimeRoot = join(root, 'runtime-artifact');
    const packageRoot = join(runtimeRoot, 'node_modules', '@happier-dev', 'plugins-example');
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(join(runtimeRoot, 'package.json'), JSON.stringify({
      name: '@happier-dev/cli-runtime-fixture',
      dependencies: { [packageName]: 'workspace:*' },
      bundledDependencies: [packageName],
    }), 'utf8');
    writeWorkspacePackage(
      packageRoot,
      'export const generation = "admitted";\n',
      packageName,
    );
    mkdirSync(join(packageRoot, '.happier-plugin'), { recursive: true });
    writeFileSync(
      join(packageRoot, '.happier-plugin', 'plugin.json'),
      '{"id":"happier.example"}\n',
      'utf8',
    );

    const admittedIdentity = readCliNodeWorkspaceRuntimeIdentity({
      repoRoot: root,
      hostPackageDir: runtimeRoot,
    });
    const payloadDir = join(root, 'pinned-runner');

    expect(() => copyCliNodeWorkspaceRuntimePackagesFromRuntimeRoot({
      runtimeRoot,
      payloadDir,
      packageNames: admittedIdentity.packageNames,
      expectedWorkspaceRuntimeIdentity: admittedIdentity.fingerprint,
    })).not.toThrow();
    expect(existsSync(join(
      payloadDir,
      'node_modules',
      '@happier-dev',
      'plugins-example',
      '.happier-plugin',
      'plugin.json',
    ))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('returns the exact staged identity when artifact packaging excludes source-only package files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-cli-runtime-payload-'));
  try {
    const packageName = '@happier-dev/protocol';
    const hostRoot = join(root, 'apps', 'cli');
    const hostPackageRoot = join(hostRoot, 'node_modules', '@happier-dev', 'protocol');
    mkdirSync(hostRoot, { recursive: true });
    writeFileSync(join(hostRoot, 'package.json'), JSON.stringify({
      name: '@happier-dev/cli',
      dependencies: { [packageName]: 'workspace:*' },
      bundledDependencies: [packageName],
    }), 'utf8');
    writeWorkspacePackage(join(root, 'packages', 'protocol'), 'export const generation = "source";\n');
    writeWorkspacePackage(hostPackageRoot, 'export const generation = "admitted";\n');
    writeFileSync(join(hostPackageRoot, 'API.md'), '# source-only documentation\n', 'utf8');
    const admittedIdentity = readCliNodeWorkspaceRuntimeIdentity({ repoRoot: root });

    const distDir = join(hostRoot, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'index.mjs'), 'export {};\n', 'utf8');
    const payloadDir = join(root, 'runtime-artifact');
    const staged = await copyCliNodeRuntimePayload({
      repoRoot: root,
      payloadDir,
      distDir,
      expectedWorkspaceRuntimeIdentity: admittedIdentity.fingerprint,
    });
    const stagedIdentity = staged;

    expect(stagedIdentity).toMatchObject({ packageNames: [packageName] });
    expect(stagedIdentity.fingerprint).not.toBe(admittedIdentity.fingerprint);
    expect(existsSync(join(payloadDir, 'node_modules', '@happier-dev', 'protocol', 'API.md'))).toBe(false);
    expect(() => copyCliNodeWorkspaceRuntimePackagesFromRuntimeRoot({
      runtimeRoot: payloadDir,
      payloadDir: join(root, 'pinned-runner'),
      packageNames: stagedIdentity.packageNames,
      expectedWorkspaceRuntimeIdentity: stagedIdentity.fingerprint,
    })).not.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
