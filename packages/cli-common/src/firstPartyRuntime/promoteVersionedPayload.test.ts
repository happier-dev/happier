import { existsSync } from 'node:fs';
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    promoteVersionedPayload,
    resolveInstalledFirstPartyComponentPaths,
} from './index.js';

async function createPayload(rootDir: string, versionId: string, contents: string): Promise<string> {
    const payloadRoot = join(rootDir, `payload-${versionId}`);
    await mkdir(join(payloadRoot, 'package-dist'), { recursive: true });
    await mkdir(join(payloadRoot, 'tools', 'unpacked'), { recursive: true });
    await writeFile(join(payloadRoot, 'happier'), contents, 'utf8');
    await writeFile(join(payloadRoot, 'package-dist', 'index.mjs'), `export default ${JSON.stringify(versionId)};\n`, 'utf8');
    const managedRuntimePath = join(payloadRoot, 'tools', 'unpacked', 'happier-cliproxyapi-managed');
    await writeFile(managedRuntimePath, `managed-runtime-${versionId}\n`, 'utf8');
    await chmod(managedRuntimePath, 0o755);
    await writeFile(join(payloadRoot, 'tools', 'unpacked', 'CLIProxyAPI-LICENSE'), 'CLIProxyAPI license\n', 'utf8');
    await writeFile(
        join(payloadRoot, 'tools', 'unpacked', 'CLIProxyAPI-THIRD-PARTY-NOTICES'),
        `CLIProxyAPI third-party notices ${versionId}\n`,
        'utf8',
    );
    return payloadRoot;
}

describe('promoteVersionedPayload', () => {
    it('ignores AppleDouble metadata files in the staged payload', async () => {
        const homeDir = await mkdtemp(join(tmpdir(), 'happier-promote-versioned-payload-appledouble-'));
        const env = { ...process.env, HAPPIER_HOME_DIR: homeDir };

        try {
            const stagedPayloadPath = await createPayload(homeDir, '1.0.0', 'first-version');
            await writeFile(join(stagedPayloadPath, '._happier'), 'appledouble', 'utf8');
            await mkdir(join(stagedPayloadPath, 'package-dist', 'nested'), { recursive: true });
            await writeFile(join(stagedPayloadPath, 'package-dist', 'nested', '._index.mjs'), 'appledouble', 'utf8');

            const promotion = await promoteVersionedPayload({
                componentId: 'happier-cli',
                processEnv: env,
                versionId: '1.0.0',
                stagedPayloadPath,
            });

            expect(promotion.currentVersionId).toBe('1.0.0');

            const paths = resolveInstalledFirstPartyComponentPaths({
                componentId: 'happier-cli',
                processEnv: env,
            });
            expect(existsSync(join(paths.currentPath, '._happier'))).toBe(false);
            expect(existsSync(join(paths.currentPath, 'package-dist', 'nested', '._index.mjs'))).toBe(false);
            expect(await readFile(paths.binaryPath, 'utf8')).toBe('first-version');
        } finally {
            await rm(homeDir, { recursive: true, force: true });
        }
    });

    it('moves the staged payload into the versioned install tree on posix platforms', async () => {
        const homeDir = await mkdtemp(join(tmpdir(), 'happier-promote-versioned-payload-move-'));
        const env = { ...process.env, HAPPIER_HOME_DIR: homeDir };

        try {
            const stagedPayloadPath = await createPayload(homeDir, '1.0.1', 'moved-version');

            const promotion = await promoteVersionedPayload({
                componentId: 'happier-cli',
                processEnv: env,
                versionId: '1.0.1',
                stagedPayloadPath,
            });

            expect(promotion.versionPath).not.toBe(stagedPayloadPath);
            await expect(stat(stagedPayloadPath)).rejects.toMatchObject({ code: 'ENOENT' });

            const paths = resolveInstalledFirstPartyComponentPaths({
                componentId: 'happier-cli',
                processEnv: env,
            });
            expect(await readFile(paths.binaryPath, 'utf8')).toBe('moved-version');
            expect((await lstat(paths.currentPath)).isSymbolicLink()).toBe(true);
        } finally {
            await rm(homeDir, { recursive: true, force: true });
        }
    });

    it('keeps the managed wrapper executable and exact release metadata in current and previous payloads', async () => {
        const homeDir = await mkdtemp(join(tmpdir(), 'happier-promote-versioned-payload-managed-runtime-'));
        const env = { ...process.env, HAPPIER_HOME_DIR: homeDir };

        try {
            await promoteVersionedPayload({
                componentId: 'happier-cli',
                processEnv: env,
                versionId: '1.0.0',
                stagedPayloadPath: await createPayload(homeDir, '1.0.0', 'first-version'),
            });
            await promoteVersionedPayload({
                componentId: 'happier-cli',
                processEnv: env,
                versionId: '2.0.0',
                stagedPayloadPath: await createPayload(homeDir, '2.0.0', 'second-version'),
            });

            const paths = resolveInstalledFirstPartyComponentPaths({
                componentId: 'happier-cli',
                processEnv: env,
            });
            const currentWrapper = join(paths.currentPath, 'tools', 'unpacked', 'happier-cliproxyapi-managed');
            const previousWrapper = join(paths.previousPath, 'tools', 'unpacked', 'happier-cliproxyapi-managed');
            expect(await readFile(currentWrapper, 'utf8')).toBe('managed-runtime-2.0.0\n');
            expect(await readFile(previousWrapper, 'utf8')).toBe('managed-runtime-1.0.0\n');
            if (process.platform !== 'win32') {
                expect((await stat(currentWrapper)).mode & 0o777).toBe(0o755);
                expect((await stat(previousWrapper)).mode & 0o777).toBe(0o755);
            }
            await expect(readFile(join(paths.currentPath, 'tools', 'unpacked', 'CLIProxyAPI-LICENSE'), 'utf8'))
                .resolves.toBe('CLIProxyAPI license\n');
            await expect(readFile(join(paths.currentPath, 'tools', 'unpacked', 'CLIProxyAPI-THIRD-PARTY-NOTICES'), 'utf8'))
                .resolves.toBe('CLIProxyAPI third-party notices 2.0.0\n');
            await expect(readFile(join(paths.previousPath, 'tools', 'unpacked', 'CLIProxyAPI-THIRD-PARTY-NOTICES'), 'utf8'))
                .resolves.toBe('CLIProxyAPI third-party notices 1.0.0\n');

        } finally {
            await rm(homeDir, { recursive: true, force: true });
        }
    });
});
