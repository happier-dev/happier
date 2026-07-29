import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../../../../../../', import.meta.url));

const claudeHostBackendTree = 'apps/cli/src/backends/claude';

describe('Claude runtime auth host import closure', () => {
  it('does not keep a legacy Claude host backend tree', () => {
    expect(existsSync(new URL(claudeHostBackendTree, `file://${repoRoot}`))).toBe(false);
  });

  it('keeps Claude plugin source imports inside the plugin and public package boundaries', () => {
    const srcRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
    const files: string[] = [];
    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const fullPath = join(dir, entry);
        const metadata = statSync(fullPath);
        if (metadata.isDirectory()) {
          if (entry === 'dist' || entry === 'node_modules') continue;
          visit(fullPath);
          continue;
        }
        if (entry.endsWith('.ts')) files.push(fullPath);
      }
    };
    visit(srcRoot);

    const forbiddenImports = files.flatMap((filePath) => {
      const source = readFileSync(filePath, 'utf8');
      const matches = source.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gu);
      return Array.from(matches, (match) => String(match[1] ?? '')).filter((specifier) =>
        specifier.startsWith('@/') ||
        specifier.startsWith('apps/') ||
        specifier.startsWith('@happier-dev/')
          && !specifier.startsWith('@happier-dev/plugin-sdk')
          && !specifier.startsWith('@happier-dev/agents')
          && !specifier.startsWith('@happier-dev/protocol')
      ).map((specifier) => `${relative(srcRoot, filePath)} -> ${specifier}`);
    });

    expect(forbiddenImports).toEqual([]);
  });
});
