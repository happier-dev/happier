import { describe, expect, it } from 'vitest';

import { buildLocalRelayRuntimeSystemTaskSpec } from './specs/localControl/buildLocalRelayRuntimeSystemTaskSpec';
import { buildLocalTailscaleSecureAccessSystemTaskSpec } from './specs/localControl/buildLocalTailscaleSecureAccessSystemTaskSpec';
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
            expect(snapshot?.result?.ok).toBe(true);
            expect(snapshot?.result?.data).toMatchObject({
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
        expect(snapshot?.result?.ok).toBe(true);
        expect(snapshot?.result?.data).toMatchObject({
            tailscaleInstalled: true,
            tailscaleLoggedIn: true,
            serveEnabled: true,
            shareableHttpsUrl: 'https://relay.tailnet.ts.net',
        });
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
        expect(snapshot?.result?.ok).toBe(true);
        expect(snapshot?.result?.data).toMatchObject({
            tailscaleInstalled: true,
            tailscaleLoggedIn: true,
            authUrl: null,
        });
    });
});
