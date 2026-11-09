import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { cp, mkdir, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { installRemoteFirstPartyComponent } from './remoteFirstPartyPayloadInstaller.js';
import { createCliPayloadFixture } from '../../../../packages/cli-common/src/systemTasks/testkit/createCliPayloadFixture.js';

const execFileAsync = promisify(execFile);
let tempDirs: string[] = [];

afterEach(() => {
    for (const tempDir of tempDirs) {
        rmSync(tempDir, { recursive: true, force: true });
    }
    tempDirs = [];
});

describe('installRemoteFirstPartyComponent', () => {
    // Execute the POSIX guest commands locally; native Windows hosts need a remote guest.
    it.skipIf(process.platform === 'win32')('uploads and promotes the actual payload through the shared installer (no curl bash)', async () => {
        const remoteCommands: string[] = [];
        const copiedPaths: Array<Readonly<{ localPath: string; remotePath: string }>> = [];
        const controller = new AbortController();
        const observedSignals: Array<AbortSignal | undefined> = [];
        const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-bootstrap-first-party-payload-'));
        tempDirs.push(rootDir);
        const remoteHome = join(rootDir, 'remote-home');
        await mkdir(remoteHome);
        const remoteEnv = {
            ...process.env,
            HOME: remoteHome,
            HAPPIER_HOME_DIR: join(remoteHome, 'private-happier'),
            HAPPIER_FIRST_PARTY_INSTALL_HOME: join(remoteHome, '.happier'),
        };
        const fixture = await createCliPayloadFixture();
        try {
            const payloadBytes = await readFile(join(fixture.payloadRoot, 'happier'));

            const result = await installRemoteFirstPartyComponent({
                componentId: 'happier-cli',
                channel: 'preview',
                ssh: {
                    target: 'dev@example.test',
                    auth: 'agent',
                },
                knownHostsMode: 'system',
                signal: controller.signal,
            }, {
                now: () => 1700000000000,
                resolveRemoteReleaseTarget: async ({ signal }) => {
                    observedSignals.push(signal);
                    return { os: 'linux', arch: 'x64' };
                },
                preparePayload: async () => ({
                    componentId: 'happier-cli',
                    channel: 'preview',
                    versionId: '1.2.3',
                    payloadRoot: fixture.payloadRoot,
                    source: 'https://example.test/happier.tgz',
                    cleanup: fixture.cleanup,
                }),
                copyLocalDirectoryToRemote: async ({ localPath, remotePath, signal }) => {
                    observedSignals.push(signal);
                    copiedPaths.push({ localPath, remotePath });
                    // SCP recursively copies the source directory beneath the destination.
                    await cp(localPath, join(remoteHome, remotePath, basename(localPath)), { recursive: true });
                },
                runRemoteText: async ({ remoteCommand, signal }) => {
                    observedSignals.push(signal);
                    remoteCommands.push(remoteCommand);
                    return { status: 0, ...await execFileAsync('/bin/sh', ['-c', remoteCommand], {
                        cwd: remoteHome,
                        env: remoteEnv,
                        signal,
                    }) };
                },
            });

            expect(copiedPaths).toHaveLength(1);
            expect(copiedPaths[0]).toEqual(expect.objectContaining({
                remotePath: '.happier/bootstrap-staging/happier-cli-1.2.3-1700000000000',
            }));
            expect(remoteCommands.join('\n')).not.toContain('curl -fsSL https://happier.dev/install');
            for (const signal of observedSignals) expect(signal).toBe(controller.signal);
            expect(result).toEqual({
                binaryPath: '$HOME/.happier/cli-preview/current/happier',
                versionId: '1.2.3',
                source: 'https://example.test/happier.tgz',
            });
            const installRoot = join(remoteHome, '.happier', 'cli-preview');
            const currentBinary = join(installRoot, 'current', 'happier');
            expect(await realpath(currentBinary)).toBe(await realpath(join(installRoot, 'versions', '1.2.3', 'happier')));
            expect(await readFile(currentBinary)).toEqual(payloadBytes);
        } finally {
            await fixture.cleanup();
        }
    });
});
