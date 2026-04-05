import { describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { __testables } from './uiWebMetro';

type ResolveExpoCliPath = (params: Readonly<{ rootDir: string; uiWorkspaceDir: string }>) => string;

describe('uiWebMetro resolveExpoCliPath', () => {
  it('prefers the repo-root expo cli when it exists', async () => {
    const rootDir = resolve(join(tmpdir(), `happier-uiwebmetro-root-${Date.now()}`));
    const uiWorkspaceDir = resolve(join(rootDir, 'apps', 'ui'));

    const rootExpoCli = resolve(rootDir, 'node_modules', 'expo', 'bin', 'cli');
    await mkdir(resolve(rootExpoCli, '..'), { recursive: true });
    await writeFile(rootExpoCli, '#!/usr/bin/env node\nconsole.log("ok")\n', 'utf8');

    const fn = (__testables as unknown as { resolveExpoCliPath?: ResolveExpoCliPath }).resolveExpoCliPath;
    expect(typeof fn).toBe('function');
    expect(fn?.({ rootDir, uiWorkspaceDir })).toBe(rootExpoCli);
  });

  it('falls back to the apps/ui workspace expo cli when repo-root expo is not present', async () => {
    const rootDir = resolve(join(tmpdir(), `happier-uiwebmetro-root-${Date.now()}-${Math.random().toString(16).slice(2)}`));
    const uiWorkspaceDir = resolve(join(rootDir, 'apps', 'ui'));

    const workspaceExpoCli = resolve(uiWorkspaceDir, 'node_modules', 'expo', 'bin', 'cli');
    await mkdir(resolve(workspaceExpoCli, '..'), { recursive: true });
    await writeFile(workspaceExpoCli, '#!/usr/bin/env node\nconsole.log("ok")\n', 'utf8');

    const fn = (__testables as unknown as { resolveExpoCliPath?: ResolveExpoCliPath }).resolveExpoCliPath;
    expect(typeof fn).toBe('function');
    expect(fn?.({ rootDir, uiWorkspaceDir })).toBe(workspaceExpoCli);
  });
});
