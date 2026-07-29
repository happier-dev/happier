import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

function cliSourcePath(path: string): string {
  const cwd = process.cwd();
  const cliRoot = existsSync(resolve(cwd, 'apps/cli/package.json'))
    ? resolve(cwd, 'apps/cli')
    : cwd;
  return resolve(cliRoot, 'src', path);
}

describe('connected-service credential API import boundary', () => {
  it('keeps low-level runtime credential and quota readers off the full ApiClient graph', () => {
    const modules = [
      {
        label: 'Runtime connected-service recovery capability projection',
        path: 'plugins/projection/registry/agentCatalogEntryHooks.ts',
      },
      {
        label: 'SCM hosting-provider runtime services',
        path: 'scm/hostingProviders/runtimeServices.ts',
      },
    ] as const;

    for (const module of modules) {
      const source = readFileSync(cliSourcePath(module.path), 'utf8');

      expect(source, module.label).not.toMatch(/\bfrom\s+['"]@\/api\/api['"]/u);
      expect(source, module.label).not.toMatch(/\bimport\s*\(\s*['"]@\/api\/api['"]\s*\)/u);
    }
  });
});
