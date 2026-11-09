import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findBuiltinNativeToolchainAdapterV1 } from '@happier-dev/protocol/plugins/contributions/projectNativeAdapters';
import { projectNativeSystemIo } from './projectNativeSystemIo';
import { createProjectNativeIo } from './projectNativeIo';
import { prepareProjectNativeToolchain } from '@/workspaces/toolchain/prepareProjectNativeToolchain';

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
    it.each([
        { version: '1.22.22', requested: undefined, singleFile: false },
        { version: '1.22.21', requested: '1.22.21', singleFile: false },
        { version: '4.6.0', requested: '4.6.0', singleFile: true },
    ])('resolves completed Corepack Yarn $version (requested $requested) without executing its shim or downloading', async ({ version, requested, singleFile }) => {
        const root = await fixture();
        const corepack = join(root, 'corepack');
        const cache = join(root, 'corepack-cache');
        const yarn = join(cache, 'v1/yarn', version);
        vi.stubEnv('COREPACK_HOME', cache);
        await mkdir(join(corepack, 'dist'), { recursive: true });
        await mkdir(join(yarn, 'bin'), { recursive: true });
        const shim = join(corepack, 'dist/yarn.js');
        const entrypoint = join(yarn, singleFile ? 'yarn.js' : 'bin/yarn.js');
        await writeFile(shim, '#!/usr/bin/env node\nthrow new Error("must not execute Corepack");\n', { mode: 0o755 });
        await writeFile(join(corepack, 'package.json'), JSON.stringify({ name: 'corepack', version: '0.36.0', bin: { yarn: 'dist/yarn.js' } }));
        await writeFile(entrypoint, '#!/usr/bin/env node\nthrow new Error("inspection must not execute Yarn");\n', { mode: 0o755 });
        if (!singleFile) await writeFile(join(yarn, 'package.json'), JSON.stringify({ name: 'yarn', version, bin: { yarn: 'bin/yarn.js' } }));
        // Corepack 0.36 persists an array for its single-file Yarn >=2 distribution.
        const receipt = { locator: { name: 'yarn', reference: `${version}+sha512.installed` },
            bin: singleFile ? ['yarn', 'yarnpkg'] : { yarn: './bin/yarn.js' } };
        await writeFile(join(yarn, '.corepack'), JSON.stringify(receipt));
        await writeFile(join(cache, 'lastKnownGood.json'), JSON.stringify({ yarn: '1.22.22+sha512.installed' }));
        if (requested && version !== '1.22.22') {
            const defaultYarn = join(cache, 'v1/yarn/1.22.22');
            await mkdir(join(defaultYarn, 'bin'), { recursive: true });
            await writeFile(join(defaultYarn, 'bin/yarn.js'), '#!/usr/bin/env node\nthrow new Error("must not execute default Yarn");\n');
            await writeFile(join(defaultYarn, 'package.json'), JSON.stringify({ name: 'yarn', version: '1.22.22', bin: { yarn: 'bin/yarn.js' } }));
            await writeFile(join(defaultYarn, '.corepack'), JSON.stringify({ locator: { name: 'yarn', reference: '1.22.22' }, bin: { yarn: './bin/yarn.js' } }));
        }
        if (process.platform === 'win32') {
            await mkdir(join(root, 'bin/node_modules'), { recursive: true });
            await symlink(corepack, join(root, 'bin/node_modules/corepack'), 'junction');
            vi.stubEnv('PATHEXT', '.CMD;.EXE');
            await writeFile(join(root, 'bin/yarn.cmd'), '@echo off\r\nexit /b 1\r\n');
        } else await symlink(shim, join(root, 'bin/yarn'));
        const request = { cwd: root, ...(requested ? { version: requested } : {}) };
        expect(await projectNativeSystemIo.resolveTool('yarn', request))
            .toMatchObject({ executablePath: process.execPath, args: [entrypoint], version });
        expect(await projectNativeSystemIo.resolveTool('yarn', { cwd: root, version: '99.0.0' })).toBeNull();
        if (singleFile) {
            // Requested version must not substitute for mismatching installed facts.
            await writeFile(join(yarn, '.corepack'), JSON.stringify({ ...receipt, locator: { name: 'yarn', reference: '4.5.0' } }));
            expect(await projectNativeSystemIo.resolveTool('yarn', request)).toBeNull();
            await writeFile(join(yarn, '.corepack'), JSON.stringify(receipt));
            await rm(entrypoint);
            expect(await projectNativeSystemIo.resolveTool('yarn', request)).toBeNull();
        }
        // An incomplete native installation remains unavailable; the probe never
        // invokes Corepack to fill its existing cache.
        await rm(join(yarn, '.corepack'));
        expect(await projectNativeSystemIo.resolveTool('yarn', request)).toBeNull();
    });
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

    it.skipIf(process.platform === 'win32')('qualifies Mise version probes for supported hosts, and allows repair after malformed native output', async () => {
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
        if (process.arch !== 'x64' || !findBuiltinNativeToolchainAdapterV1('mise', process.platform)) {
            expect(await io.environmentIo.resolveTool('mise')).toBeNull();
            await expect(readFile(called)).rejects.toMatchObject({ code: 'ENOENT' });
            return;
        }
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
        const result = await prepareProjectNativeToolchain({ selection: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' },
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
