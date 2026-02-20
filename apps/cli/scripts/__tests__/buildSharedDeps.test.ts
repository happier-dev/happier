import { describe, expect, it, vi } from 'vitest';
import { sep } from 'node:path';

import { resolveTscBin, runTsc, syncBundledWorkspaceDist } from '../buildSharedDeps.mjs';

describe('buildSharedDeps', () => {
  it('surfaces which tsconfig failed when compilation throws', () => {
    const execFileSync = vi.fn(() => {
      throw new Error('tsc failed');
    });

    expect(() => runTsc('/repo/packages/protocol/tsconfig.json', { execFileSync })).toThrow(
      /tsconfig\.json/i,
    );
  });

  it('invokes tsc.cmd via cmd.exe on Windows', () => {
    const execFileSync = vi.fn(() => undefined);

    runTsc('C:\\repo\\packages\\protocol\\tsconfig.json', {
      execFileSync,
      tscBin: 'C:\\repo\\node_modules\\.bin\\tsc.cmd',
      platform: 'win32',
    });

    expect(execFileSync).toHaveBeenCalled();
    const [cmd, args, opts] = execFileSync.mock.calls[0] ?? [];
    expect(cmd).toBe('cmd.exe');
    expect(args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(String(args[3])).toContain('tsc.cmd');
    expect(String(args[3])).toContain('-p');
    expect(opts).toHaveProperty('stdio', 'inherit');
  });

  it('prefers the workspace root tsc binary when present', () => {
    const bin = resolveTscBin({
      exists: (candidate: string) =>
        candidate.includes(`${sep}node_modules${sep}typescript${sep}bin${sep}`) &&
        !candidate.includes(`${sep}cli${sep}node_modules${sep}`),
    });

    expect(bin).toMatch(/node_modules/);
    expect(bin).not.toMatch(/cli[\\/]+node_modules/);
  });

  it('executes tsc via node to avoid .bin symlink ENOENT issues', () => {
    const execFileSync = vi.fn(() => undefined);

    runTsc('/repo/packages/protocol/tsconfig.json', {
      execFileSync,
      tscBin: '/repo/node_modules/typescript/bin/tsc',
      platform: 'darwin',
    });

    const [cmd, args] = execFileSync.mock.calls[0] ?? [];
    expect(cmd).toBe(process.execPath);
    expect(args).toEqual(['/repo/node_modules/typescript/bin/tsc', '-p', '/repo/packages/protocol/tsconfig.json']);
  });

  it('syncs workspace dist outputs into bundled deps when present', () => {
    const cpSync = vi.fn(() => undefined);
    const existsSync = vi.fn((p: any) => String(p).includes('/apps/cli/node_modules/@happier-dev/protocol/dist'));

    syncBundledWorkspaceDist({
      repoRoot: '/repo',
      cpSync,
      existsSync,
      packages: ['protocol'],
    });

    expect(cpSync).toHaveBeenCalledTimes(1);
    const [src, dest, opts] = cpSync.mock.calls[0] ?? [];
    expect(src).toBe('/repo/packages/protocol/dist');
    expect(dest).toBe('/repo/apps/cli/node_modules/@happier-dev/protocol/dist');
    expect(opts).toMatchObject({ recursive: true, force: true });
  });

  it('syncs bundled workspace package.json exports when present', () => {
    const cpSync = vi.fn(() => undefined);
    const existsSync = vi.fn((p: any) =>
      String(p).includes('/apps/cli/node_modules/@happier-dev/protocol/dist') ||
      String(p).endsWith('/apps/cli/node_modules/@happier-dev/protocol/package.json'),
    );
    const readFileSync = vi.fn(() =>
      JSON.stringify({
        name: '@happier-dev/protocol',
        version: '0.0.0',
        type: 'module',
        exports: { '.': { default: './dist/index.js' }, './installables': { default: './dist/installables.js' } },
        dependencies: { zod: '1.0.0' },
      }),
    );
    const writeFileSync = vi.fn(() => undefined);

    syncBundledWorkspaceDist({
      repoRoot: '/repo',
      cpSync,
      existsSync,
      readFileSync,
      writeFileSync,
      packages: ['protocol'],
    });

    expect(writeFileSync).toHaveBeenCalledTimes(1);
    const [destPath, payload] = writeFileSync.mock.calls[0] ?? [];
    expect(destPath).toBe('/repo/apps/cli/node_modules/@happier-dev/protocol/package.json');
    const parsed = JSON.parse(String(payload));
    expect(parsed.exports?.['./installables']).toBeTruthy();
    expect(parsed.private).toBe(true);
  });
});
