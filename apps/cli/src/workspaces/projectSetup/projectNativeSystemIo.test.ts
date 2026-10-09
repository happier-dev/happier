import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectNativeSystemIo } from './projectNativeSystemIo';
import { createProjectNativeIo } from './projectNativeIo';
import { produceProjectNativeEnvironment } from '@/workspaces/environment/produceProjectNativeEnvironment';

const roots: string[] = [];
const hostPath = process.env.PATH ?? '';
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'happier-native-installed-tools-'));
    roots.push(root);
    await mkdir(join(root, 'bin'));
    vi.stubEnv('PATH', join(root, 'bin'));
    vi.stubEnv('HAPPIER_JS_RUNTIME_PATH', process.execPath);
    return root;
}

describe('installed native tool producer', () => {
    it.each(['npm', 'yarn', 'pnpm'])('resolves installed %s metadata through managed JS runtime without executing the package or trusting the requested version', async tool => {
        const root = await fixture();
        const pkg = process.platform === 'win32' ? join(root, 'bin', 'node_modules', tool) : join(root, 'installed', tool);
        await mkdir(join(pkg, 'bin'), { recursive: true });
        const script = join(pkg, 'bin', 'cli.cjs');
        await writeFile(script, '#!/usr/bin/env node\nthrow new Error("inspection must not execute this");\n');
        await chmod(script, 0o755);
        await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: tool, version: '4.6.0', bin: { [tool]: 'bin/cli.cjs' } }));
        if (process.platform === 'win32') {
            vi.stubEnv('PATHEXT', '.CMD;.EXE');
            await writeFile(join(root, 'bin', `${tool}.cmd`), '@echo off\r\nexit /b 1\r\n');
        } else await symlink(script, join(root, 'bin', tool));
        const resolved = await projectNativeSystemIo.resolveTool(tool, { cwd: root, version: '99.0.0' });
        expect(resolved).toMatchObject({ executablePath: process.execPath, args: [script], version: '4.6.0' });
        expect(resolved?.executablePath).not.toBe(join(root, 'bin', tool));
        expect(await readFile(script, 'utf8')).toContain('inspection must not execute');
    });

    it('does not turn an arbitrary package-manager shim or a missing explicit runtime into a launchable tool', async () => {
        const root = await fixture();
        await writeFile(join(root, 'bin', process.platform === 'win32' ? 'yarn.cmd' : 'yarn'), process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        expect(await projectNativeSystemIo.resolveTool('yarn', { cwd: root })).toBeNull();
        vi.stubEnv('HAPPIER_JS_RUNTIME_PATH', join(root, 'missing-runtime'));
        expect(await projectNativeSystemIo.resolveTool('node', { cwd: root })).toBeNull();
    });

    it('reports the actually selected current Node runtime version without a process probe', async () => {
        const root = await fixture();
        expect(await projectNativeSystemIo.resolveTool('node', { cwd: root, version: '99.0.0' }))
            .toMatchObject({ executablePath: process.execPath, version: process.versions.node });
    });

    it.skipIf(process.platform === 'win32')('keeps passive Mise presence separate from admitted version probing, and allows repair after malformed native output', async () => {
        const root = await fixture();
        // The real process supervisor needs its OS tools; only Mise selection is controlled.
        vi.stubEnv('PATH', [join(root, 'bin'), hostPath].join(delimiter));
        const binary = join(root, 'bin', 'mise');
        const called = join(root, 'called');
        const source = (output: string, code = 0) => `#!/bin/sh\nprintf '%s' "$*" > '${called}'\nprintf '%s\\n' '${output}'\nexit ${code}\n`;
        await writeFile(binary, source('2026.10.4 linux-x64 (2026-10-07)'), { mode: 0o755 });
        expect(await projectNativeSystemIo.resolveTool('mise', { cwd: root })).toMatchObject({ executablePath: binary });
        await expect(readFile(called)).rejects.toMatchObject({ code: 'ENOENT' });
        const io = createProjectNativeIo();
        expect(await io.environmentIo.resolveTool('mise')).toMatchObject({ executablePath: binary, args: [], version: '2026.10.4' });
        expect(await readFile(called, 'utf8')).toBe('--version');
        await writeFile(binary, source('unrelated 2026.10.4'));
        expect(await io.environmentIo.resolveTool('mise')).toBeNull();
        await writeFile(binary, source('2026.10.4 linux-x64 (2026-10-07)', 1));
        expect(await io.environmentIo.resolveTool('mise')).toBeNull();
        await writeFile(binary, source('2026.10.4 linux-arm64 (2026-10-07)'));
        expect(await io.environmentIo.resolveTool('mise')).toBeNull();
        await writeFile(binary, source('2026.10.4 linux-x64 (2026-10-07)'));
        expect(await io.environmentIo.resolveTool('mise')).toMatchObject({ version: '2026.10.4' });
        const abort = new AbortController(); abort.abort();
        await expect(io.environmentIo.resolveTool('mise', abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    });

    it.skipIf(!process.env.B3_NATIVE_MISE_PATH)('uses installed qualified Mise version facts through the real environment producer', async () => {
        const binary = process.env.B3_NATIVE_MISE_PATH;
        if (!binary) throw new Error('Installed qualification requires the verified B3 binary');
        const root = await fixture();
        vi.stubEnv('PATH', [dirname(binary), hostPath].join(delimiter));
        await writeFile(join(root, 'mise.toml'), '[env]\nB1B_NATIVE="produced"\nB1B_REMOVE=false\n');
        const io = createProjectNativeIo();
        expect(await io.commandIo.resolveTool('mise', { cwd: root })).toMatchObject({ executablePath: binary });
        expect(await io.environmentIo.resolveTool('mise')).toMatchObject({ executablePath: binary, version: '2026.10.4' });
        const result = await produceProjectNativeEnvironment({ selection: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' },
            root, cwd: root, platform: process.platform, io: io.environmentIo, env: {
                ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
                MISE_TRUSTED_CONFIG_PATHS: root, MISE_DATA_DIR: join(root, 'data'), MISE_CACHE_DIR: join(root, 'cache'),
                MISE_STATE_DIR: join(root, 'state'), MISE_CONFIG_DIR: join(root, 'config'), B1B_REMOVE: 'host',
            } });
        expect(result).toMatchObject({ status: 'ready', env: { B1B_NATIVE: 'produced' } });
        if (result.status !== 'ready') throw new Error(result.code);
        expect(result.env).not.toHaveProperty('B1B_REMOVE');
    });
});
