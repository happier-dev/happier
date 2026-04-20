import { describe, expect, it, vi } from 'vitest';

describe('RelayHostEngine (local legacy systemd unit ownership guard)', () => {
    it('does not control the legacy unsuffixed unit when it is not owned by the requested channel install root', async () => {
        const originalPlatform = process.platform;

        Object.defineProperty(process, 'platform', { value: 'linux' });

        const invoked: string[] = [];

        try {
            vi.doMock('node:os', async () => {
                const actual = await vi.importActual<typeof import('node:os')>('node:os');
                return {
                    ...actual,
                    homedir: () => '/tmp/happy-home',
                };
            });

            vi.doMock('node:child_process', async () => {
                const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
                return {
                    ...actual,
                    spawnSync: (cmd: string, args?: readonly string[]) => {
                        invoked.push([cmd, ...(Array.isArray(args) ? args : [])].join(' '));
                        if (cmd === 'systemctl' && Array.isArray(args) && args.includes('show') && args.includes('--property=LoadState')) {
                            const unit = String(args.find((value) => String(value).endsWith('.service')) ?? '');
                            if (unit === 'happier-server-preview.service') {
                                return { status: 0, stdout: 'LoadState=not-found\n', stderr: '' };
                            }
                            if (unit === 'happier-server.service') {
                                return { status: 0, stdout: 'LoadState=loaded\n', stderr: '' };
                            }
                        }
                        return { status: 0, stdout: '', stderr: '' };
                    },
                };
            });

            vi.doMock('node:fs', async () => {
                const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
                return {
                    ...actual,
                    existsSync: (path: string) => path.endsWith('/.config/systemd/user/happier-server.service'),
                };
            });

            vi.doMock('node:fs/promises', async () => {
                const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
                return {
                    ...actual,
                    readFile: async (path: string) => {
                        if (path.endsWith('/.config/systemd/user/happier-server.service')) {
                            // Stable install root, not preview.
                            return '[Service]\nWorkingDirectory=/tmp/happy-home/.happier/self-host\n';
                        }
                        return '';
                    },
                    rm: async () => undefined,
                };
            });

            const { createRelayHostEngine } = await import('./relayHostEngine.js');
            const engine = createRelayHostEngine({
                resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
                runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
                copyLocalDirectoryToRemote: async () => {},
                installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'preview-1' }),
            });

            await engine.control({
                target: { kind: 'local' },
                mode: 'user',
                channel: 'preview',
                action: 'stop',
            });

            expect(invoked.some((line) => line.includes('systemctl --user stop happier-server-preview.service'))).toBe(true);
            expect(invoked.some((line) => line.includes('systemctl --user stop happier-server.service'))).toBe(false);
        } finally {
            Object.defineProperty(process, 'platform', { value: originalPlatform });
            vi.resetModules();
            vi.clearAllMocks();
        }
    }, 60_000);

    it('does not uninstall the legacy unsuffixed unit when it is not owned by the requested channel install root', async () => {
        const originalPlatform = process.platform;

        Object.defineProperty(process, 'platform', { value: 'linux' });

        const invoked: string[] = [];

        try {
            vi.doMock('node:os', async () => {
                const actual = await vi.importActual<typeof import('node:os')>('node:os');
                return {
                    ...actual,
                    homedir: () => '/tmp/happy-home',
                };
            });

            vi.doMock('node:child_process', async () => {
                const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
                return {
                    ...actual,
                    spawnSync: (cmd: string, args?: readonly string[]) => {
                        invoked.push([cmd, ...(Array.isArray(args) ? args : [])].join(' '));
                        if (cmd === 'systemctl' && Array.isArray(args) && args.includes('show') && args.includes('--property=LoadState')) {
                            const unit = String(args.find((value) => String(value).endsWith('.service')) ?? '');
                            if (unit === 'happier-server-preview.service') {
                                return { status: 0, stdout: 'LoadState=not-found\n', stderr: '' };
                            }
                            if (unit === 'happier-server.service') {
                                return { status: 0, stdout: 'LoadState=loaded\n', stderr: '' };
                            }
                        }
                        return { status: 0, stdout: '', stderr: '' };
                    },
                };
            });

            vi.doMock('node:fs', async () => {
                const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
                return {
                    ...actual,
                    existsSync: (path: string) => path.endsWith('/.config/systemd/user/happier-server.service'),
                };
            });

            vi.doMock('node:fs/promises', async () => {
                const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
                return {
                    ...actual,
                    readFile: async (path: string) => {
                        if (path.endsWith('/.config/systemd/user/happier-server.service')) {
                            return '[Service]\nWorkingDirectory=/tmp/happy-home/.happier/self-host\n';
                        }
                        return '';
                    },
                    rm: async () => undefined,
                };
            });

            const { createRelayHostEngine } = await import('./relayHostEngine.js');
            const engine = createRelayHostEngine({
                resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
                runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
                copyLocalDirectoryToRemote: async () => {},
                installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'preview-1' }),
            });

            await engine.control({
                target: { kind: 'local' },
                mode: 'user',
                channel: 'preview',
                action: 'uninstall',
            });

            expect(invoked.some((line) =>
                line.includes('systemctl')
                && line.includes('disable')
                && line.includes('happier-server.service')
            )).toBe(false);
        } finally {
            Object.defineProperty(process, 'platform', { value: originalPlatform });
            vi.resetModules();
            vi.clearAllMocks();
        }
    }, 60_000);
});
