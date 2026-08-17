import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  resolveManagedChildInvocation,
  runManagedChildCommand,
} from './managedChildLifecycle.mjs';

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

describe('resolveManagedChildInvocation', () => {
  it('spawns an explicit Windows executable path as argv rather than a shell string', () => {
    // `shell: true` makes Node concatenate argv into one unescaped command line
    // (Node DEP0190). A default Windows Node install lives in `C:\Program Files`,
    // so the concatenated line splits at the space and the child never starts.
    const invocation = resolveManagedChildInvocation({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['--max-old-space-size=8192', 'C:\\Program Files\\repo\\run.mjs'],
      platform: 'win32',
    });

    expect(invocation).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['--max-old-space-size=8192', 'C:\\Program Files\\repo\\run.mjs'],
    });
  });

  it('routes a bare Windows command name through the canonical cmd shim', () => {
    // A bare name may resolve to a `.cmd`/`.bat` package shim, which Windows
    // cannot execute directly, so this case keeps the existing escaped shim.
    const invocation = resolveManagedChildInvocation({
      command: 'vitest',
      args: ['run', '--config', 'vitest.config.ts'],
      platform: 'win32',
      comspec: 'C:\\Windows\\system32\\cmd.exe',
    });

    expect(invocation.command).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(invocation.windowsVerbatimArguments).toBe(true);
    expect(invocation.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(invocation.args.at(-1)).toContain('vitest');
  });

  it('routes an explicit Windows batch-shim path through the canonical cmd shim', () => {
    // Windows cannot start a `.cmd`/`.bat` from argv even when the full path is
    // known, so an explicit shim path needs the same escaped comspec invocation as
    // a bare name — and the spaced path must survive the escaping.
    const invocation = resolveManagedChildInvocation({
      command: 'C:\\Users\\Ada Lovelace\\AppData\\Local\\Temp\\packed-external-agent.cmd',
      args: ['--version'],
      platform: 'win32',
      comspec: 'C:\\Windows\\system32\\cmd.exe',
    });

    expect(invocation.command).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(invocation.windowsVerbatimArguments).toBe(true);
    expect(invocation.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(invocation.args.at(-1)).toContain('Ada^ Lovelace');
  });

  it('spawns argv directly on every other platform', () => {
    const invocation = resolveManagedChildInvocation({
      command: '/usr/local/bin/node',
      args: ['run.mjs', 'a b'],
      platform: 'darwin',
    });

    expect(invocation).toEqual({ command: '/usr/local/bin/node', args: ['run.mjs', 'a b'] });
  });
});

describe('runManagedChildCommand', () => {
  it('owns spawn shaping and delivers the heap limit to a child under a spaced path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'managed child '));
    roots.push(root);
    const scriptPath = join(root, 'report node options.mjs');
    const reportPath = join(root, 'report.txt');
    await writeFile(
      scriptPath,
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(reportPath)}, String(process.env.NODE_OPTIONS ?? ''), 'utf8');`,
        '',
      ].join('\n'),
      'utf8',
    );

    const result = await runManagedChildCommand({
      command: process.execPath,
      args: [scriptPath],
      spawnOptions: {
        env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=8192' },
        stdio: 'inherit',
        // A caller cannot reintroduce the concatenating shell: the spawn owner
        // decides how a managed child is started.
        shell: true,
      },
      cleanupPollMs: 25,
      signalCleanupGraceMs: 0,
      exitCleanupGraceMs: 1_000,
    });

    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(await readFile(reportPath, 'utf8')).toContain('--max-old-space-size=8192');
  }, 60_000);
});
