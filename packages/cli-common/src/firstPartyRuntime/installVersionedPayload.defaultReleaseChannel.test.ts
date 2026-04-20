import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    installVersionedPayload,
    resolveDefaultManagedReleaseChannelStatePath,
} from './index.js';

async function createPayload(rootDir: string, versionId: string, contents: string): Promise<string> {
    const payloadRoot = join(rootDir, `payload-${versionId}`);
    await mkdir(join(payloadRoot, 'package-dist'), { recursive: true });
    await writeFile(join(payloadRoot, 'happier'), contents, 'utf8');
    await writeFile(join(payloadRoot, 'package-dist', 'index.mjs'), `export default ${JSON.stringify(versionId)};\n`, 'utf8');
    return payloadRoot;
}

async function readJsonReleaseChannel(path: string): Promise<string> {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw).releaseChannel;
}

describe('installVersionedPayload default release-channel persistence', () => {
    it('writes the effective default release channel for stable and preview installs', async () => {
        const homeDir = await mkdtemp(join(tmpdir(), 'happier-install-versioned-payload-channel-'));
        const env = { ...process.env, HAPPIER_HOME_DIR: homeDir };
        const statePath = resolveDefaultManagedReleaseChannelStatePath({ processEnv: env });

        try {
            await installVersionedPayload({
                componentId: 'happier-cli',
                versionId: '1.0.0',
                payloadRoot: await createPayload(homeDir, '1.0.0', 'stable-version'),
                processEnv: env,
            });
            expect(await readJsonReleaseChannel(statePath)).toBe('stable');

            await installVersionedPayload({
                componentId: 'happier-cli',
                versionId: '2.0.0-preview.1',
                payloadRoot: await createPayload(homeDir, '2.0.0-preview.1', 'preview-version'),
                processEnv: env,
                channel: 'preview',
            });
            expect(await readJsonReleaseChannel(statePath)).toBe('preview');
        } finally {
            await rm(homeDir, { recursive: true, force: true });
        }
    });

    it('does not advance the persisted default release channel when shim sync fails', async () => {
        const homeDir = await mkdtemp(join(tmpdir(), 'happier-install-versioned-payload-channel-failure-'));
        const env = { ...process.env, HAPPIER_HOME_DIR: homeDir };
        const statePath = resolveDefaultManagedReleaseChannelStatePath({ processEnv: env });

        try {
            await installVersionedPayload({
                componentId: 'happier-cli',
                versionId: '1.0.0',
                payloadRoot: await createPayload(homeDir, '1.0.0', 'stable-version'),
                processEnv: env,
            });
            expect(await readJsonReleaseChannel(statePath)).toBe('stable');

            await rm(join(homeDir, 'bin'), { recursive: true, force: true });
            await writeFile(join(homeDir, 'bin'), 'not-a-directory', 'utf8');

            await expect(installVersionedPayload({
                componentId: 'happier-cli',
                versionId: '2.0.0-preview.1',
                payloadRoot: await createPayload(homeDir, '2.0.0-preview.1', 'preview-version'),
                processEnv: env,
                channel: 'preview',
            })).rejects.toThrow();

            expect(await readJsonReleaseChannel(statePath)).toBe('stable');
        } finally {
            await rm(homeDir, { recursive: true, force: true });
        }
    });

    it('does not update the persisted default release channel when installing non-default-shim components', async () => {
        const homeDir = await mkdtemp(join(tmpdir(), 'happier-install-versioned-payload-channel-non-cli-'));
        const env = { ...process.env, HAPPIER_HOME_DIR: homeDir };
        const statePath = resolveDefaultManagedReleaseChannelStatePath({ processEnv: env });

        try {
            await installVersionedPayload({
                componentId: 'happier-cli',
                versionId: '1.0.0',
                payloadRoot: await createPayload(homeDir, '1.0.0', 'stable-version'),
                processEnv: env,
            });
            expect(await readJsonReleaseChannel(statePath)).toBe('stable');

            await installVersionedPayload({
                componentId: 'happier-server',
                versionId: '2.0.0-preview.1',
                payloadRoot: await createPayload(homeDir, '2.0.0-preview.1', 'preview-server'),
                processEnv: env,
                channel: 'preview',
            });
            expect(await readJsonReleaseChannel(statePath)).toBe('stable');

            await installVersionedPayload({
                componentId: 'happier-daemon',
                versionId: '2.5.0-preview.1',
                payloadRoot: await createPayload(homeDir, '2.5.0-preview.1', 'preview-daemon'),
                processEnv: env,
                channel: 'preview',
            });
            expect(await readJsonReleaseChannel(statePath)).toBe('stable');

            await installVersionedPayload({
                componentId: 'hstack',
                versionId: '3.0.0-preview.1',
                payloadRoot: await createPayload(homeDir, '3.0.0-preview.1', 'preview-stack'),
                processEnv: env,
                channel: 'preview',
            });
            expect(await readJsonReleaseChannel(statePath)).toBe('stable');
        } finally {
            await rm(homeDir, { recursive: true, force: true });
        }
    });
});
