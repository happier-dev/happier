import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { bundleWorkspaceDeps } from '../bundleWorkspaceDeps.mjs';

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

describe('bundleWorkspaceDeps', () => {
  it('copies dist + writes a sanitized package.json without install scripts', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happy-bundle-workspace-deps-'));
    writeJson(resolve(repoRoot, 'package.json'), { name: 'repo', private: true });
    writeFileSync(resolve(repoRoot, 'yarn.lock'), '# lock\n', 'utf8');

    const agentsDir = resolve(repoRoot, 'packages', 'happy-agents');
    const protocolDir = resolve(repoRoot, 'packages', 'happy-protocol');
    const happyCliDir = resolve(repoRoot, 'packages', 'happy-cli');

    mkdirSync(resolve(agentsDir, 'dist'), { recursive: true });
    mkdirSync(resolve(protocolDir, 'dist'), { recursive: true });
    mkdirSync(happyCliDir, { recursive: true });

    writeJson(resolve(agentsDir, 'package.json'), {
      name: '@happy/agents',
      version: '0.0.0',
      type: 'module',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
      scripts: { postinstall: 'echo should-not-run' },
      devDependencies: { typescript: '^5' },
    });
    writeJson(resolve(protocolDir, 'package.json'), {
      name: '@happy/protocol',
      version: '0.0.0',
      type: 'module',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
      scripts: { postinstall: 'echo should-not-run' },
    });

    writeFileSync(resolve(agentsDir, 'dist', 'index.js'), 'export const x = 1;\n', 'utf8');
    writeFileSync(resolve(protocolDir, 'dist', 'index.js'), 'export const y = 2;\n', 'utf8');

    bundleWorkspaceDeps({ repoRoot, happyCliDir });

    const bundledAgentsPkgJson = JSON.parse(
      readFileSync(resolve(happyCliDir, 'node_modules', '@happy', 'agents', 'package.json'), 'utf8'),
    );
    const bundledProtocolPkgJson = JSON.parse(
      readFileSync(resolve(happyCliDir, 'node_modules', '@happy', 'protocol', 'package.json'), 'utf8'),
    );

    expect(bundledAgentsPkgJson.scripts).toBeUndefined();
    expect(bundledAgentsPkgJson.devDependencies).toBeUndefined();
    expect(bundledAgentsPkgJson.name).toBe('@happy/agents');

    expect(bundledProtocolPkgJson.scripts).toBeUndefined();
    expect(bundledProtocolPkgJson.name).toBe('@happy/protocol');
  });
});
