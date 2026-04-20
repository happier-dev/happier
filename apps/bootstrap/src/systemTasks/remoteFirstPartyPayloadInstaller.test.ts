import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { installRemoteFirstPartyComponent } from './remoteFirstPartyPayloadInstaller.js';

let tempDirs: string[] = [];

afterEach(() => {
    for (const tempDir of tempDirs) {
        rmSync(tempDir, { recursive: true, force: true });
    }
    tempDirs = [];
});

describe('installRemoteFirstPartyComponent', () => {
    it('uploads a verified payload and promotes it by updating the current symlink (no curl bash)', async () => {
        const remoteCommands: string[] = [];
        const copiedPaths: Array<Readonly<{ localPath: string; remotePath: string }>> = [];
        const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-bootstrap-first-party-payload-'));
        tempDirs.push(rootDir);
        const payloadRoot = join(rootDir, 'happier-linux-x64');
        mkdirSync(payloadRoot, { recursive: true });
        writeFileSync(join(payloadRoot, 'happier'), '#!/bin/sh\nexit 0\n', 'utf8');
        chmodSync(join(payloadRoot, 'happier'), 0o755);

        const result = await installRemoteFirstPartyComponent({
            componentId: 'happier-cli',
            channel: 'preview',
            ssh: {
                target: 'dev@example.test',
                auth: 'agent',
            },
            knownHostsMode: 'system',
        }, {
            now: () => 1700000000000,
            resolveRemoteReleaseTarget: async () => ({
                os: 'linux',
                arch: 'x64',
            }),
            preparePayload: async () => ({
                componentId: 'happier-cli',
                channel: 'preview',
                versionId: '1.2.3',
                payloadRoot,
                source: 'https://example.test/happier.tgz',
                cleanup: async () => undefined,
            }),
            copyLocalDirectoryToRemote: async ({ localPath, remotePath }) => {
                copiedPaths.push({ localPath, remotePath });
            },
            runRemoteText: async ({ remoteCommand }) => {
                remoteCommands.push(remoteCommand);
                return {
                    status: 0,
                    stdout: '',
                    stderr: '',
                };
            },
        });

        expect(copiedPaths).toHaveLength(1);
        expect(copiedPaths[0]).toEqual(expect.objectContaining({
            localPath: expect.stringContaining('happier-first-party-scp-archive-'),
            remotePath: '.happier/bootstrap-staging/happier-cli-1.2.3-1700000000000',
        }));
        expect(remoteCommands.join('\n')).not.toContain('curl -fsSL https://happier.dev/install');
        expect(remoteCommands.at(-1)).toContain('ln -sfn');
        expect(remoteCommands.at(-1)).toContain('/versions/');
        expect(result).toEqual({
            binaryPath: '$HOME/.happier/cli-preview/current/happier',
            versionId: '1.2.3',
            source: 'https://example.test/happier.tgz',
        });
    });
});
