import * as childProcess from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { expect, it, vi } from 'vitest';

// Collect the real Exec chain before the case's runtime budget begins.
import '@/plugins/runtime/invocation/services/exec';
import { createHostScmCommandRunner, runScmCommand, runWithScmCommandRunner } from './runtime';

vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, spawn: vi.fn(actual.spawn) };
});

it.each([
    { outcome: 'successful', args: ['rev-parse', '--is-inside-work-tree'], success: true, exitCode: 0, stdout: 'true\n' },
    { outcome: 'failed', args: ['rev-parse', '--verify', 'refs/heads/nonexistent'], success: false, exitCode: 128, stdout: '' },
])('preserves a $outcome finite SCM result when the OS destroys stdin during its close', async ({ args, success, exitCode, stdout }) => {
    const cwd = mkdtempSync(join(tmpdir(), 'happier-scm-stdin-close-'));
    childProcess.execFileSync('git', ['init', '-q'], { cwd });
    const { spawn } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    let closedDuringFinal = false;
    // The OS stream is the mocked boundary. Keep SCM, Exec admission, the
    // supervisor, and the child command/result real beneath that boundary.
    const spawnBoundary = vi.spyOn(childProcess, 'spawn').mockImplementation((command, args, options) => {
        const child = spawn(command, args, options);
        const nativeStdin = child.stdin;
        const stdin = new Writable({
            final() {
                nativeStdin?.end();
                queueMicrotask(() => {
                    closedDuringFinal = true;
                    this.destroy();
                });
            },
        });
        Object.defineProperty(child, 'stdin', { value: stdin });
        return child;
    });
    const runner = createHostScmCommandRunner({
        agentIsolation: { read: () => ({ enabled: false, status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, workspaceRoots: [] }) },
        isCurrent: () => true,
    });
    try {
        const result = await runWithScmCommandRunner(runner, () => runScmCommand({
            bin: 'git', cwd, args,
        }));
        expect(closedDuringFinal).toBe(true);
        expect(result).toMatchObject({ success, exitCode, stdout });
        expect(result.stderr).not.toContain('ERR_STREAM_DESTROYED');
    } finally {
        spawnBoundary.mockRestore();
        rmSync(cwd, { recursive: true, force: true });
    }
});
