import { describe, expect, it, vi } from 'vitest';

import { buildLocalRelayRuntimeSystemTaskSpec } from './specs/localControl/buildLocalRelayRuntimeSystemTaskSpec';
import { buildLocalTailscaleSecureAccessSystemTaskSpec } from './specs/localControl/buildLocalTailscaleSecureAccessSystemTaskSpec';
import {
    buildRelayAccessConfigureSystemTaskSpec,
    buildRelayAccessStatusSystemTaskSpec,
} from './specs/relayAccess/buildRelayAccessSystemTaskSpec';
import { buildRemoteSshBootstrapMachineSystemTaskSpec } from './remoteSshBootstrap/buildRemoteSshBootstrapMachineSystemTaskSpec';
import { createDeterministicSystemTaskBridge } from './createDeterministicSystemTaskBridge';
import { createSystemTaskRunner } from './createSystemTaskRunner';

describe('createDeterministicSystemTaskBridge', () => {
    it('can simulate a healthy local relay runtime for dev-only e2e scenarios', async () => {
        const previousScenarios = (globalThis as typeof globalThis & {
            __HAPPIER_DEV_SYSTEM_TASK_SCENARIOS__?: Record<string, unknown>;
        }).__HAPPIER_DEV_SYSTEM_TASK_SCENARIOS__;

        (globalThis as typeof globalThis & {
            __HAPPIER_DEV_SYSTEM_TASK_SCENARIOS__?: Record<string, unknown>;
        }).__HAPPIER_DEV_SYSTEM_TASK_SCENARIOS__ = {
            ...(previousScenarios ?? {}),
            'relay.runtime.status.v1': 'ready',
        };

        try {
            const bridge = createDeterministicSystemTaskBridge();
            const runner = createSystemTaskRunner({ bridge, mode: 'dev' });
            const taskId = await runner.start(buildLocalRelayRuntimeSystemTaskSpec('relay.runtime.status.v1'));

            await new Promise((resolve) => setTimeout(resolve, 250));

            const snapshot = runner.getSnapshot(taskId);
            expect(snapshot?.status).toBe('succeeded');
            const result = snapshot?.result;
            expect(result?.ok).toBe(true);
            if (!result?.ok) {
                throw new Error('Expected successful system task result.');
            }
            expect(result.data).toMatchObject({
                installed: true,
                healthy: true,
                relayUrl: 'http://127.0.0.1:53288',
                service: {
                    active: true,
                    enabled: true,
                },
            });
        } finally {
            (globalThis as typeof globalThis & {
                __HAPPIER_DEV_SYSTEM_TASK_SCENARIOS__?: Record<string, unknown>;
            }).__HAPPIER_DEV_SYSTEM_TASK_SCENARIOS__ = previousScenarios;
        }
    });

    it('can simulate tailscale secure access for the deterministic setup runner', async () => {
        const bridge = createDeterministicSystemTaskBridge();
        const runner = createSystemTaskRunner({ bridge, mode: 'dev' });
        const taskId = await runner.start(buildLocalTailscaleSecureAccessSystemTaskSpec({
            upstreamUrl: 'https://relay.example.test',
        }));

        await new Promise((resolve) => setTimeout(resolve, 250));

        const snapshot = runner.getSnapshot(taskId);
        expect(snapshot?.status).toBe('succeeded');
        const result = snapshot?.result;
        expect(result?.ok).toBe(true);
        if (!result?.ok) {
            throw new Error('Expected successful system task result.');
        }
        expect(result.data).toMatchObject({
            tailscaleInstalled: true,
            tailscaleLoggedIn: true,
            serveEnabled: true,
            shareableHttpsUrl: 'https://relay.tailnet.ts.net',
        });
    });

    it('supports a visible-success tailscale secure-access scenario for browser assertions', async () => {
        const previousScenarios = (globalThis as typeof globalThis & {
            __HAPPIER_DEV_SYSTEM_TASK_SCENARIOS__?: Record<string, unknown>;
        }).__HAPPIER_DEV_SYSTEM_TASK_SCENARIOS__;

        vi.useFakeTimers();
        (globalThis as typeof globalThis & {
            __HAPPIER_DEV_SYSTEM_TASK_SCENARIOS__?: Record<string, unknown>;
        }).__HAPPIER_DEV_SYSTEM_TASK_SCENARIOS__ = {
            ...(previousScenarios ?? {}),
            'secureAccess.tailscale.v1': 'visibleSuccess',
        };

        try {
            const bridge = createDeterministicSystemTaskBridge();
            const runner = createSystemTaskRunner({ bridge, mode: 'dev' });
            const taskId = await runner.start(buildLocalTailscaleSecureAccessSystemTaskSpec({
                upstreamUrl: 'https://relay.example.test',
            }));

            await vi.advanceTimersByTimeAsync(250);
            expect(runner.getSnapshot(taskId)?.status).toBe('running');

            await vi.advanceTimersByTimeAsync(2_500);

            const snapshot = runner.getSnapshot(taskId);
            expect(snapshot?.status).toBe('succeeded');
            const result = snapshot?.result;
            expect(result?.ok).toBe(true);
            if (!result?.ok) {
                throw new Error('Expected successful system task result.');
            }
            expect(result.data).toMatchObject({
                tailscaleInstalled: true,
                tailscaleLoggedIn: true,
                serveEnabled: true,
                shareableHttpsUrl: 'https://relay.tailnet.ts.net',
            });
        } finally {
            vi.useRealTimers();
            (globalThis as typeof globalThis & {
                __HAPPIER_DEV_SYSTEM_TASK_SCENARIOS__?: Record<string, unknown>;
            }).__HAPPIER_DEV_SYSTEM_TASK_SCENARIOS__ = previousScenarios;
        }
    });

    it('can simulate tailscale ensure-ready for reachability remediation', async () => {
        const bridge = createDeterministicSystemTaskBridge();
        const runner = createSystemTaskRunner({ bridge, mode: 'dev' });
        const taskId = await runner.start({
            protocolVersion: 1,
            kind: 'tailscale.ensureReady.v1',
            params: {
                installPolicy: 'installIfMissing',
                loginPolicy: 'interactive',
                mode: 'normalUser',
            },
        });

        await new Promise((resolve) => setTimeout(resolve, 250));

        const snapshot = runner.getSnapshot(taskId);
        expect(snapshot?.status).toBe('succeeded');
        const result = snapshot?.result;
        expect(result?.ok).toBe(true);
        if (!result?.ok) {
            throw new Error('Expected successful system task result.');
        }
        expect(result.data).toMatchObject({
            tailscaleInstalled: true,
            tailscaleLoggedIn: true,
            authUrl: null,
        });
    });

    it('can simulate remote relay-host bootstrap completion for deterministic setup flows', async () => {
        const previousScenarios = (globalThis as typeof globalThis & {
            __HAPPIER_DEV_SYSTEM_TASK_SCENARIOS__?: Record<string, unknown>;
        }).__HAPPIER_DEV_SYSTEM_TASK_SCENARIOS__;

        (globalThis as typeof globalThis & {
            __HAPPIER_DEV_SYSTEM_TASK_SCENARIOS__?: Record<string, unknown>;
        }).__HAPPIER_DEV_SYSTEM_TASK_SCENARIOS__ = {
            ...(previousScenarios ?? {}),
            'remote.ssh.bootstrapMachine.v1': 'relayHostReady',
        };

        try {
            const bridge = createDeterministicSystemTaskBridge();
            const runner = createSystemTaskRunner({ bridge, mode: 'dev' });
            const taskId = await runner.start(buildRemoteSshBootstrapMachineSystemTaskSpec({
                relayUrl: 'https://relay.example.test',
                publicRelayUrl: 'https://public-relay.example.test',
                channel: 'dev',
                sshUsername: 'dev',
                sshHost: 'remote.example.test',
                sshAuth: 'agent',
                serviceMode: 'none',
                installRelayRuntime: true,
            }));

            await new Promise((resolve) => setTimeout(resolve, 250));

            const snapshot = runner.getSnapshot(taskId);
            expect(snapshot?.status).toBe('succeeded');
            const result = snapshot?.result;
            expect(result?.ok).toBe(true);
            if (!result?.ok) {
                throw new Error('Expected successful system task result.');
            }
            expect(result.data).toMatchObject({
                machineId: 'machine-remote-dev-1',
                relayRuntime: {
                    relayUrl: 'https://remote-relay.example.test',
                },
            });
        } finally {
            (globalThis as typeof globalThis & {
                __HAPPIER_DEV_SYSTEM_TASK_SCENARIOS__?: Record<string, unknown>;
            }).__HAPPIER_DEV_SYSTEM_TASK_SCENARIOS__ = previousScenarios;
        }
    });

    it('persists configured relay-access status for follow-up status checks', async () => {
        const bridge = createDeterministicSystemTaskBridge();
        const runner = createSystemTaskRunner({ bridge, mode: 'dev' });
        const configureTaskId = await runner.start(buildRelayAccessConfigureSystemTaskSpec({
            providerId: 'lan',
            config: {
                providerId: 'lan',
                url: 'https://relay.example.test',
            },
            upstreamUrl: 'http://127.0.0.1:53288',
        }));

        await new Promise((resolve) => setTimeout(resolve, 250));

        const configureSnapshot = runner.getSnapshot(configureTaskId);
        expect(configureSnapshot?.status).toBe('succeeded');
        expect(configureSnapshot?.result).toMatchObject({
            ok: true,
            data: {
                configured: true,
                providerId: 'lan',
                status: {
                    state: 'enabled',
                    shareUrl: 'https://relay.example.test',
                },
            },
        });

        const statusTaskId = await runner.start(buildRelayAccessStatusSystemTaskSpec());
        await new Promise((resolve) => setTimeout(resolve, 250));

        const statusSnapshot = runner.getSnapshot(statusTaskId);
        expect(statusSnapshot?.status).toBe('succeeded');
        expect(statusSnapshot?.result).toMatchObject({
            ok: true,
            data: {
                configured: true,
                providerId: 'lan',
                status: {
                    state: 'enabled',
                    shareUrl: 'https://relay.example.test',
                },
            },
        });
    });
});
