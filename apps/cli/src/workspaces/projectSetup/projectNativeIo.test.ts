import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProjectNativeIo } from './projectNativeIo';

describe('Project native host IO', () => {
    const roots: string[] = [];
    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
    });
    async function fixture() {
        const root = await mkdtemp(join(tmpdir(), 'happier-native-io-'));
        roots.push(root);
        return root;
    }

    it.skipIf(process.platform === 'win32')('resolves installed native tools passively, without evaluating a version or falling through to package managers', async () => {
        const originalPath = process.env.PATH;
        const root = await fixture();
        const marker = join(root, 'must-not-run');
        const mise = join(root, 'mise');
        await writeFile(mise, `#!/bin/sh\nprintf evaluated > '${marker}'\n`);
        await chmod(mise, 0o755);
        await writeFile(join(root, 'pnpm'), '#!/bin/sh\nexit 0\n');
        await chmod(join(root, 'pnpm'), 0o755);
        // Environment and installed files are genuine OS boundaries; internal
        // resolution, native environment production and supervision stay real.
        vi.stubEnv('PATH', root);
        const { commandIo: io, environmentIo } = createProjectNativeIo();
        expect(await io.resolveTool('mise', { cwd: root, version: '2026.10.4' })).toEqual({ executablePath: mise, args: [] });
        await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await io.resolveTool('pnpm', { cwd: root, version: '11.0.0' })).toBeNull();
        expect(await io.resolveTool('make', { cwd: root })).toBeNull();
        // The admitted probe needs the real supervisor's OS tools; the fixture
        // still wins tool selection. A malformed version proves no provenance.
        vi.stubEnv('PATH', [root, originalPath].filter(Boolean).join(delimiter));
        expect(await environmentIo.resolveTool('mise')).toBeNull();
        expect(await readFile(marker, 'utf8')).toBe('evaluated');
    });

    it('uses the incumbent finite tuple owner with literal argv, cwd and complete environment', async () => {
        const cwd = await fixture();
        const args = ['literal $() ; " argument', 'trailing\\'];
        const output = await createProjectNativeIo().environmentIo.run({
            command: process.execPath,
            args: ['-e', 'process.stdout.write(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(1),keep:process.env.KEEP,removed:process.env.HAPPIER_HOME_DIR}));process.exitCode=7', ...args],
            cwd, env: { KEEP: 'native value' },
        });
        expect(output.exitCode).toBe(7);
        expect(JSON.parse(output.stdout)).toEqual({ cwd, args, keep: 'native value' });
    });

    it.skipIf(process.platform !== 'linux')('uses incumbent tree cancellation for a child that leaves the parent process group and permits fresh execution', async () => {
        const cwd = await fixture();
        const pidFile = join(cwd, 'child.pid');
        const controller = new AbortController();
        let childPid: number | undefined;
        const io = createProjectNativeIo().environmentIo;
        const running = io.run({
            command: process.execPath,
            args: ['-e', 'const {spawn}=require("node:child_process");const {writeFileSync}=require("node:fs");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});writeFileSync(process.argv[1],String(child.pid));setInterval(()=>{},1000)', pidFile],
            cwd, env: {}, signal: controller.signal,
        });
        // Attach rejection observation before abort; only the OS process boundary
        // is a fixture, while supervisor and tree owner are the real production path.
        const settled = running.then(value => ({ value }), error => ({ error: error as unknown }));
        try {
            for (;;) {
                const pid = await readFile(pidFile, 'utf8').catch(error => {
                    if (error.code === 'ENOENT') return null;
                    throw error;
                });
                if (pid !== null) { childPid = Number(pid); break; }
                const state = await Promise.race([settled, new Promise<null>(resolve => setImmediate(() => resolve(null)))]);
                if (state !== null) throw new Error('native process ended before creating its child');
            }
            controller.abort();
            expect(await settled).toMatchObject({ error: { code: 'plugin_exec_aborted' } });
            const stat = await readFile(`/proc/${childPid}/stat`, 'utf8').catch(error => {
                if (error.code === 'ENOENT') return null;
                throw error;
            });
            expect(stat === null || stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')).toBe(true);
            childPid = undefined;
            expect(await io.run({ command: process.execPath, args: ['-e', 'process.stdout.write("fresh")'], cwd, env: {} })).toEqual({ exitCode: 0, stdout: 'fresh' });
        } finally {
            controller.abort();
            await settled;
            if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} }
        }
    });
});
