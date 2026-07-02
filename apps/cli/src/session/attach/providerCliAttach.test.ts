import { describe, expect, it, vi } from 'vitest';

import { createProviderCliAttachOps } from './providerCliAttach';

type SpawnExitHandler = (code: number | null, signal: NodeJS.Signals | null) => void;
type SpawnErrorHandler = (error: Error) => void;

describe('createProviderCliAttachOps', () => {
    it('launches provider-native attach with descriptor args and inherited stdio', async () => {
        const exitHandlers: SpawnExitHandler[] = [];
        const errorHandlers: SpawnErrorHandler[] = [];
        const spawnProcess = vi.fn(() => ({
            once: (event: 'exit' | 'error', handler: SpawnExitHandler | SpawnErrorHandler) => {
                if (event === 'exit') exitHandlers.push(handler as SpawnExitHandler);
                if (event === 'error') errorHandlers.push(handler as SpawnErrorHandler);
            },
        }));

        const ops = createProviderCliAttachOps<{
            providerSessionId: string;
            directory: string;
            baseUrl: string;
        }>({
            agentId: 'opencode',
            resolveTarget: ({ metadata, fallbackServerBaseUrl }) => ({
                ok: true,
                value: {
                    providerSessionId: String(metadata.providerSessionId),
                    directory: String(metadata.directory),
                    baseUrl: fallbackServerBaseUrl ?? String(metadata.baseUrl),
                },
            }),
            createArgs: (target) => [
                'attach',
                target.baseUrl,
                '--dir',
                target.directory,
                '--session',
                target.providerSessionId,
            ],
            readFallbackServerBaseUrl: async () => 'https://fallback-opencode.example.test',
            resolveLaunchSpec: () => ({
                source: 'managed',
                resolvedPath: '/managed/opencode',
                command: 'opencode',
                args: ['--managed'],
            }),
            spawnProcess: spawnProcess as unknown as Parameters<typeof createProviderCliAttachOps>[0]['spawnProcess'],
        });

        const attachPromise = ops.attach({
            sessionId: 'happier-session-1',
            metadata: {
                providerSessionId: 'oc-session-1',
                directory: '/repo',
            },
        });

        await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1));
        expect(spawnProcess).toHaveBeenCalledWith(
            'opencode',
            [
                '--managed',
                'attach',
                'https://fallback-opencode.example.test',
                '--dir',
                '/repo',
                '--session',
                'oc-session-1',
            ],
            expect.objectContaining({
                shell: false,
                stdio: 'inherit',
            }),
        );
        expect(errorHandlers).toHaveLength(1);
        expect(exitHandlers).toHaveLength(1);

        exitHandlers[0]?.(0, null);
        await expect(attachPromise).resolves.toBe(0);
    });

    it('probes descriptor health URL with a bounded request', async () => {
        const fetchFn = vi.fn(async () => ({ ok: true }));
        const ops = createProviderCliAttachOps<{ healthUrl: string }>({
            agentId: 'opencode',
            resolveTarget: () => ({ ok: true, value: { healthUrl: 'https://opencode.example.test/global/health' } }),
            createArgs: () => [],
            buildHealthUrl: (target) => target.healthUrl,
            fetchFn: fetchFn as unknown as typeof fetch,
            reachabilityTimeoutMs: 25,
        });

        await expect(ops.probeReachability?.({ metadata: {} })).resolves.toEqual({ reachable: true });
        expect(fetchFn).toHaveBeenCalledWith(
            'https://opencode.example.test/global/health',
            expect.objectContaining({ method: 'GET' }),
        );
    });

    it('does not use local managed-server fallback when evaluating a remote provider attach target', async () => {
        const resolveTarget = vi.fn(({ fallbackServerBaseUrl }: { fallbackServerBaseUrl?: string | null }) =>
            fallbackServerBaseUrl
                ? { ok: true as const, value: { baseUrl: fallbackServerBaseUrl } }
                : { ok: false as const, reason: 'missing explicit remote server URL' },
        );
        const ops = createProviderCliAttachOps<{ baseUrl: string }>({
            agentId: 'opencode',
            resolveTarget,
            createArgs: () => [],
            readFallbackServerBaseUrl: async () => 'http://127.0.0.1:4096/',
        });

        await expect(ops.evaluateAvailability({
            sessionId: 'session-1',
            metadata: {},
            currentMachineId: 'machine-local',
            sessionMachineId: 'machine-remote',
            hasLocalAttachmentInfo: false,
        })).resolves.toEqual({
            eligible: false,
            reason: 'missing explicit remote server URL',
        });
        expect(resolveTarget).toHaveBeenCalledWith({ metadata: {}, fallbackServerBaseUrl: null });
    });

    it('spawns the resolved platform invocation instead of the raw provider command', async () => {
        const exitHandlers: SpawnExitHandler[] = [];
        const spawnProcess = vi.fn(() => ({
            once: (event: 'exit' | 'error', handler: SpawnExitHandler | SpawnErrorHandler) => {
                if (event === 'exit') exitHandlers.push(handler as SpawnExitHandler);
            },
        }));
        const ops = createProviderCliAttachOps<{ providerSessionId: string }>({
            agentId: 'opencode',
            resolveTarget: () => ({ ok: true, value: { providerSessionId: 'oc-session-1' } }),
            createArgs: (target) => ['attach', '--session', target.providerSessionId],
            resolveLaunchSpec: () => ({
                source: 'managed',
                resolvedPath: 'opencode.cmd',
                command: 'opencode.cmd',
                args: ['--managed'],
            }),
            resolveCommandInvocation: ({ command, args }) => ({
                command: 'cmd.exe',
                args: ['/d', '/s', '/c', `"${command} ${args.join(' ')}"`],
                windowsVerbatimArguments: true,
            }),
            spawnProcess: spawnProcess as unknown as Parameters<typeof createProviderCliAttachOps>[0]['spawnProcess'],
        });

        const attachPromise = ops.attach({ sessionId: 'session-1', metadata: {} });

        await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1));
        expect(spawnProcess).toHaveBeenCalledWith(
            'cmd.exe',
            ['/d', '/s', '/c', '"opencode.cmd --managed attach --session oc-session-1"'],
            expect.objectContaining({
                shell: false,
                stdio: 'inherit',
                windowsVerbatimArguments: true,
            }),
        );

        exitHandlers[0]?.(0, null);
        await expect(attachPromise).resolves.toBe(0);
    });
});
