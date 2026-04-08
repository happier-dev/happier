import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HappierServiceInventory } from '@happier-dev/cli-common/happierRuntime';
import { reloadConfiguration } from '@/configuration';
import { writeCredentialsLegacy } from '@/persistence';
import { addServerProfile, useServerProfile } from '@/server/serverProfiles';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';

const promptAnswers: string[] = [];
const promptQuestions: string[] = [];
const { spawnHappyCLIMock, discoverHappierServicesMock } = vi.hoisted(() => ({
    spawnHappyCLIMock: vi.fn(),
    discoverHappierServicesMock: vi.fn<(...args: unknown[]) => Promise<HappierServiceInventory>>(async () => ({ services: [] })),
}));

vi.mock('node:readline', () => ({
    createInterface: () => ({
        question: (prompt: string, cb: (answer: string) => void) => {
            promptQuestions.push(prompt);
            cb(promptAnswers.shift() ?? '');
        },
        close: () => {},
    }),
}));

vi.mock('@/utils/spawnHappyCLI', () => ({
    spawnHappyCLI: (...args: unknown[]) => spawnHappyCLIMock(...args),
}));

vi.mock('@happier-dev/cli-common/happierRuntime', async () => {
    const actual = await vi.importActual<typeof import('@happier-dev/cli-common/happierRuntime')>('@happier-dev/cli-common/happierRuntime');
    return {
        ...actual,
        discoverHappierServices: (...args: Parameters<typeof actual.discoverHappierServices>) => discoverHappierServicesMock(...args),
    };
});

function setTtyMode(stdinIsTTY: boolean, stdoutIsTTY: boolean): () => void {
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: stdinIsTTY });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: stdoutIsTTY });

    return () => {
        if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
        else delete (process.stdin as { isTTY?: boolean }).isTTY;
        if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
        else delete (process.stdout as { isTTY?: boolean }).isTTY;
    };
}

describe('happier server background service follow-up', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        spawnHappyCLIMock.mockReset();
        discoverHappierServicesMock.mockReset();
        promptAnswers.length = 0;
        promptQuestions.length = 0;
    });

    it('prompts to restart a default-following background service after switching active servers', async () => {
        const home = await mkdtemp(join(tmpdir(), 'happier-server-use-followup-'));
        const previousHome = process.env.HAPPIER_HOME_DIR;
        const restoreTty = setTtyMode(true, true);

        try {
            process.env.HAPPIER_HOME_DIR = home;
            reloadConfiguration();

            const serverA = await addServerProfile({
                name: 'A',
                serverUrl: 'https://a.example.test',
                webappUrl: 'https://a.example.test',
                use: true,
            });
            const serverB = await addServerProfile({
                name: 'B',
                serverUrl: 'https://b.example.test',
                webappUrl: 'https://b.example.test',
                use: false,
            });

            await useServerProfile(serverB.id);
            reloadConfiguration();
            await writeCredentialsLegacy({
                token: 'token-b',
                secret: new Uint8Array([1, 2, 3, 4]),
            });
            await useServerProfile(serverA.id);
            reloadConfiguration();

            discoverHappierServicesMock.mockResolvedValue({
                services: [{
                    id: 'svc-default',
                    serviceType: 'daemon',
                    platform: process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32' ? process.platform : 'darwin',
                    backend: process.platform === 'linux' ? 'systemd-user' : process.platform === 'win32' ? 'schtasks-user' : 'launchd',
                    label: 'happier-default',
                    targetMode: 'default-following',
                    verification: 'verified',
                    ring: null,
                    instanceId: null,
                    scope: 'user',
                    definitionPath: '/tmp/happier-default',
                    executablePath: '/tmp/happier',
                    installed: true,
                    running: true,
                    serverUrl: 'https://a.example.test',
                    publicServerUrl: 'https://a.example.test',
                }],
            });
            spawnHappyCLIMock.mockReturnValue({
                on: (event: string, cb: (value?: number) => void) => {
                    if (event === 'close') cb(0);
                    return undefined;
                },
            });
            promptAnswers.push('y');

            const { handleServerCommand } = await import('./server');
            await handleServerCommand(['use', serverB.id]);

            expect(spawnHappyCLIMock).toHaveBeenCalledWith(['service', 'restart'], expect.objectContaining({
                stdio: 'inherit',
            }));
        } finally {
            restoreTty();
            if (previousHome === undefined) delete process.env.HAPPIER_HOME_DIR;
            else process.env.HAPPIER_HOME_DIR = previousHome;
            reloadConfiguration();
            await rm(home, { recursive: true, force: true });
        }
    });

    it('does not restart the default-following background service when authentication for the new server is declined', async () => {
        const home = await mkdtemp(join(tmpdir(), 'happier-server-use-auth-declined-'));
        const previousHome = process.env.HAPPIER_HOME_DIR;
        const restoreTty = setTtyMode(true, true);
        const output = captureConsoleLogAndMuteStdout();

        try {
            process.env.HAPPIER_HOME_DIR = home;
            reloadConfiguration();

            const serverA = await addServerProfile({
                name: 'A',
                serverUrl: 'https://a.example.test',
                webappUrl: 'https://a.example.test',
                use: true,
            });
            const serverB = await addServerProfile({
                name: 'B',
                serverUrl: 'https://b.example.test',
                webappUrl: 'https://b.example.test',
                use: false,
            });

            discoverHappierServicesMock.mockResolvedValue({
                services: [{
                    id: 'svc-default',
                    serviceType: 'daemon',
                    platform: process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32' ? process.platform : 'darwin',
                    backend: process.platform === 'linux' ? 'systemd-user' : process.platform === 'win32' ? 'schtasks-user' : 'launchd',
                    label: 'happier-default',
                    targetMode: 'default-following',
                    verification: 'verified',
                    ring: null,
                    instanceId: null,
                    scope: 'user',
                    definitionPath: '/tmp/happier-default',
                    executablePath: '/tmp/happier',
                    installed: true,
                    running: true,
                    serverUrl: 'https://a.example.test',
                    publicServerUrl: 'https://a.example.test',
                }],
            });
            promptAnswers.push('n');

            const { handleServerCommand } = await import('./server');
            await handleServerCommand(['use', serverB.id]);

            expect(promptQuestions).toEqual([
                'Authenticate Happier against https://b.example.test now? [Y/n]: ',
            ]);
            expect(spawnHappyCLIMock).not.toHaveBeenCalled();
            expect(output.logs.join('\n')).toContain('Background service was not restarted');
        } finally {
            output.restore();
            restoreTty();
            if (previousHome === undefined) delete process.env.HAPPIER_HOME_DIR;
            else process.env.HAPPIER_HOME_DIR = previousHome;
            reloadConfiguration();
            await rm(home, { recursive: true, force: true });
        }
    });

    it('prints manual follow-up guidance in non-interactive mode when a default-following background service exists', async () => {
        const home = await mkdtemp(join(tmpdir(), 'happier-server-use-noninteractive-followup-'));
        const previousHome = process.env.HAPPIER_HOME_DIR;
        const restoreTty = setTtyMode(false, false);
        const output = captureConsoleLogAndMuteStdout();

        try {
            process.env.HAPPIER_HOME_DIR = home;
            reloadConfiguration();

            await addServerProfile({
                name: 'A',
                serverUrl: 'https://a.example.test',
                webappUrl: 'https://a.example.test',
                use: true,
            });
            const serverB = await addServerProfile({
                name: 'B',
                serverUrl: 'https://b.example.test',
                webappUrl: 'https://b.example.test',
                use: false,
            });

            await useServerProfile(serverB.id);
            reloadConfiguration();
            await writeCredentialsLegacy({
                token: 'token-b',
                secret: new Uint8Array([1, 2, 3, 4]),
            });
            await addServerProfile({
                name: 'C',
                serverUrl: 'https://c.example.test',
                webappUrl: 'https://c.example.test',
                use: false,
            });
            await useServerProfile('A');
            reloadConfiguration();

            discoverHappierServicesMock.mockResolvedValue({
                services: [{
                    id: 'svc-default',
                    serviceType: 'daemon',
                    platform: process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32' ? process.platform : 'darwin',
                    backend: process.platform === 'linux' ? 'systemd-user' : process.platform === 'win32' ? 'schtasks-user' : 'launchd',
                    label: 'happier-default',
                    targetMode: 'default-following',
                    verification: 'verified',
                    ring: null,
                    instanceId: null,
                    scope: 'user',
                    definitionPath: '/tmp/happier-default',
                    executablePath: '/tmp/happier',
                    installed: true,
                    running: true,
                }],
            });

            const { handleServerCommand } = await import('./server');
            await handleServerCommand(['use', serverB.id]);

            expect(spawnHappyCLIMock).not.toHaveBeenCalled();
            const out = output.logs.join('\n');
            expect(out).toContain('happier service restart');
            expect(out).toContain('https://b.example.test');
        } finally {
            output.restore();
            restoreTty();
            if (previousHome === undefined) delete process.env.HAPPIER_HOME_DIR;
            else process.env.HAPPIER_HOME_DIR = previousHome;
            reloadConfiguration();
            await rm(home, { recursive: true, force: true });
        }
    });
});
