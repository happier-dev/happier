import { describe, expect, it } from 'vitest';

import { installRemoteFirstPartyComponent } from './remoteFirstPartyPayloadInstaller.js';

describe('installRemoteFirstPartyComponent', () => {
    it('uploads a verified payload and installs it with happier self __install-payload instead of curl bash', async () => {
        const remoteCommands: string[] = [];
        const copiedPaths: Array<Readonly<{ localPath: string; remotePath: string }>> = [];

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
                payloadRoot: '/tmp/local/happier-linux-x64',
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

        expect(copiedPaths).toEqual([
            {
                localPath: '/tmp/local/happier-linux-x64',
                remotePath: '$HOME/.happier/bootstrap-staging/happier-cli-1.2.3-1700000000000',
            },
        ]);
        expect(remoteCommands.join('\n')).not.toContain('curl -fsSL https://happier.dev/install');
        expect(remoteCommands.at(-1)).toContain('self __install-payload');
        expect(remoteCommands.at(-1)).toMatch(/--component\b[^;]*happier-cli/);
        expect(result).toEqual({
            binaryPath: '$HOME/.happier/cli-preview/current/happier',
            versionId: '1.2.3',
            source: 'https://example.test/happier.tgz',
        });
    });
});
