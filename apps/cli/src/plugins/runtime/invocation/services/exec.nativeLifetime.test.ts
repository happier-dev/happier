import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { withTempDir } from '@/testkit/fs/tempDir';
import { spawnDetachedTestProcess, waitForProcessExit } from '@/testkit/process/spawn';

it.skipIf(process.platform === 'win32')('keeps a native supervisor outside daemon ownership and alive after its parent group terminates', async ({ task }) => {
    await withTempDir('happier-native-parent-lifetime-', async directory => {
        const readyPath = join(directory, 'ready.json');
        const nativeSource = `
            const fs = require('node:fs');
            fs.writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({ pid: process.pid,
                markers: Object.keys(process.env).filter(key => key.startsWith('HAPPIER_STACK_')),
                configuration: process.env.NATIVE_CONFIGURATION }));
            setInterval(() => {}, 1000);
        `;
        const execModule = pathToFileURL(join(process.cwd(), 'src/plugins/runtime/invocation/services/exec.ts')).href;
        const parentSource = `
            import { createStablePluginExecService } from ${JSON.stringify(execModule)};
            const service = createStablePluginExecService({ signal: new AbortController().signal,
                isOccurrenceCurrent: () => true, environment: { ...process.env },
                resolveExecutable: async () => ({ command: process.execPath }), resolvePath: async () => process.cwd() });
            await service.spawn({ executable: { kind: 'systemTool', id: 'fixture.native' },
                args: ['-e', ${JSON.stringify(nativeSource)}], env: { NATIVE_CONFIGURATION: 'selected' } },
                { descendantDisposition: 'preserve-on-success' });
        `;
        const parent = spawnDetachedTestProcess(process.execPath,
            ['--import', 'tsx/esm', '--input-type=module', '-e', parentSource], {
                env: { ...process.env, HAPPIER_STACK_STACK: 'native-lifetime-fixture',
                    HAPPIER_STACK_ENV_FILE: join(directory, 'env'), HAPPIER_STACK_PROCESS_KIND: 'daemon' },
                stdio: ['ignore', 'ignore', 'pipe'],
            });
        let stderr = '';
        parent.stderr?.on('data', chunk => { stderr += String(chunk); });
        let native: { pid: number; markers: string[]; configuration: string } | undefined;
        try {
            await vi.waitUntil(async () => {
                if (parent.exitCode !== null || parent.signalCode !== null) throw new Error(`Native parent exited: ${stderr}`);
                try { native = JSON.parse(await readFile(readyPath, 'utf8')); return true; }
                catch (error) {
                    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
                    throw error;
                }
            }, { timeout: task.timeout });
            if (!native) throw new Error('Native readiness missing');
            const ps = promisify(execFile);
            const group = async (pid: number) => (await ps('ps', ['-o', 'pgid=', '-p', String(pid)])).stdout.trim();
            expect(await group(native.pid)).not.toBe(await group(parent.pid!));
            if (process.platform === 'linux') {
                const session = async (pid: number) => (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1]!.split(' ')[3];
                expect(await session(native.pid)).not.toBe(await session(parent.pid!));
                const keys = (await readFile(`/proc/${native.pid}/environ`, 'utf8')).split('\0')
                    .map(entry => entry.slice(0, entry.indexOf('='))).filter(key => key.startsWith('HAPPIER_STACK_'));
                expect(keys).toEqual([]);
                expect(await readFile(`/proc/${native.pid}/cgroup`, 'utf8')).not.toBe(await readFile(`/proc/${parent.pid}/cgroup`, 'utf8'));
            }
            process.kill(-parent.pid!, 'SIGTERM');
            expect(await waitForProcessExit(parent.pid!)).toBe(true);
            expect(await waitForProcessExit(native.pid, { timeoutMs: 200 })).toBe(false);
            expect(native).toMatchObject({ markers: [], configuration: 'selected' });
        } finally {
            if (!native) { try { native = JSON.parse(await readFile(readyPath, 'utf8')); } catch {} }
            if (native) { try { process.kill(native.pid, 'SIGKILL'); } catch {} }
            try { process.kill(-parent.pid!, 'SIGKILL'); } catch {}
        }
    });
// A fresh native parent loads the source dependency graph outside Vitest's cache.
}, 120_000);
