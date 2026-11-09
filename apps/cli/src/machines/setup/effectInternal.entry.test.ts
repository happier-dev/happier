import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { MachineEffectInternalRecordSchema } from './effectInternalProtocol';

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));

describe('actual CLI source process effect entry', () => {
    it('settles the fixed private entry before Account, update or daemon bootstrap', async ({ onTestFinished }) => {
        const controller = new AbortController();
        const started = performance.now();
        let phase: 'version' | 'effect' | 'settled' = 'version';
        let versionControlMs: number | undefined;
        onTestFinished(() => {
            controller.abort();
            if (phase !== 'settled') throw new Error(`Source child did not settle: phase=${phase}, versionControlMs=${versionControlMs ?? 'pending'}, elapsedMs=${Math.round(performance.now() - started)}`);
        });
        const cliHome = await mkdtemp(resolve(tmpdir(), 'happier-effect-entry-'));
        try {
            const options = {
                cwd: packageRoot,
                env: { ...process.env, HAPPIER_HOME_DIR: cliHome, HAPPIER_SERVER_URL: 'http://127.0.0.1:1', HAPPIER_WEBAPP_URL: 'http://127.0.0.1:1',
                    HAPPIER_TOKEN: 'invalid-test-token', HAPPIER_CLI_API_TOKEN_HANDOFF_V1: 'invalid-test-token' },
                encoding: 'utf8' as const,
                signal: controller.signal,
            };
            const runtimeArgs = ['--conditions=happier-source', '--import', 'tsx', 'src/index.ts'];
            // Version succeeds in this same source runtime; a malformed
            // unrelated Account token must not intercept the root protocol.
            const version = await execFileAsync(process.execPath, [...runtimeArgs, '--version'], options);
            versionControlMs = Math.round(performance.now() - started);
            expect(version.stdout.trim()).not.toBe('');
            phase = 'effect';
            // The source subprocess runs the actual entry. UID is the only OS
            // boundary substituted; no host elevation or native mutation runs.
            let stdout = '';
            let stderr = '';
            let code: number | undefined;
            try {
                const uidBoundary = 'data:text/javascript,' + encodeURIComponent('process.getuid = () => 0;');
                const pending = execFileAsync(process.execPath, ['--import', uidBoundary, ...runtimeArgs,
                    'machine', 'effect-internal', '--operation-id=operation-a'], options);
                pending.child.stdin?.end(JSON.stringify({ v: 1, mode: 'check', basis: {
                    kind: 'bootstrap', managedId: 'managed-a', operationId: 'operation-a', admittedInputDigest: 'a'.repeat(64),
                }, steps: [] }) + '\n');
                const result = await pending;
                stdout = result.stdout;
                stderr = result.stderr;
                code = 0;
            } catch (error) {
                if (!error || typeof error !== 'object' || !('stdout' in error) || !('stderr' in error) || !('code' in error)) throw error;
                stdout = String(error.stdout);
                stderr = String(error.stderr);
                code = typeof error.code === 'number' ? error.code : undefined;
            }
            phase = 'settled';
            expect(code).toBe(0);
            expect(stdout).toContain('"type":"result"');
            const records = stdout.trim().split('\n').map(line => MachineEffectInternalRecordSchema.parse(JSON.parse(line)));
            expect(records[0]).toEqual({ type: 'ready' });
            expect(records.at(-1)).toMatchObject({ type: 'result', result: { status: 'checked', plan: {
                basis: { kind: 'bootstrap', managedId: 'managed-a', operationId: 'operation-a', admittedInputDigest: 'a'.repeat(64) },
                steps: [], nativeFacts: [],
            } } });
            expect(stdout + stderr).not.toContain('invalid-test-token');
            expect(stderr).toBe('');
        } finally {
            await rm(cliHome, { recursive: true, force: true });
        }
    });
});
