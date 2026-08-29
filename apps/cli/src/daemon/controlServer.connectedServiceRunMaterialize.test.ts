import { describe, expect, it, vi } from 'vitest';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';

import {
    deriveConnectedServiceRunMaterializeToken,
    isValidConnectedServiceRunMaterializeToken,
} from './connectedServices/runs/capabilityToken';
import { createDaemonControlApp } from './controlServer';

const RUN_BINDINGS = {
    v: 1,
    bindingsByServiceId: {
        'happier.agent.codex/openai-codex': {
            source: 'connected',
            selection: 'profile',
            profileId: 'profile_1',
        },
    },
} as const;

function createApp(overrides: Record<string, unknown> = {}) {
    return createDaemonControlApp({
        getChildren: () => [],
        machineId: 'machine',
        stopSession: async () => ({ status: 'not_found' as const }),
        spawnSession: async () => ({
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
            errorMessage: 'unused',
        }),
        requestShutdown: () => {},
        onHappySessionWebhook: () => {},
        controlToken: 'master-token',
        verifyRunMaterializeToken: (provided: string) =>
            isValidConnectedServiceRunMaterializeToken(provided, 'master-token'),
        ...overrides,
    } as Parameters<typeof createDaemonControlApp>[0]);
}

describe('connected-service run materialize capability token', () => {
    it('derives a scoped token distinct from the master and verifies constant-time', () => {
        const scoped = deriveConnectedServiceRunMaterializeToken('master-token');
        expect(scoped).not.toBe('');
        expect(scoped).not.toBe('master-token');
        expect(isValidConnectedServiceRunMaterializeToken(scoped, 'master-token')).toBe(true);
        expect(isValidConnectedServiceRunMaterializeToken('master-token', 'master-token')).toBe(false);
        expect(isValidConnectedServiceRunMaterializeToken('', 'master-token')).toBe(false);
        expect(isValidConnectedServiceRunMaterializeToken(scoped, '')).toBe(false);
    });

});

describe('createDaemonControlApp connected-service run materialization bridge', () => {
    const scopedToken = deriveConnectedServiceRunMaterializeToken('master-token');
    const activationId = '11111111-1111-4111-8111-111111111111';

    it('rejects the master control token and bad tokens on the run-materialize endpoint', async () => {
        const materializeConnectedServicesForExecutionRun = vi.fn();
        const app = createApp({ materializeConnectedServicesForExecutionRun });
        try {
            for (const token of ['master-token', 'nonsense', '']) {
                const response = await app.inject({
                    method: 'POST',
                    url: '/connected-service-run/materialize',
                    headers: token ? { 'x-happier-daemon-token': token } : {},
                    payload: {
                        runId: 'run_1',
                        runnerPid: 4242,
                        agentId: 'codex',
                        connectedServices: RUN_BINDINGS,
                        cwd: '/tmp/project',
                    },
                });
                expect(response.statusCode).toBe(401);
            }
            expect(materializeConnectedServicesForExecutionRun).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it('fails closed with 501 when no run materialization handler is wired', async () => {
        const app = createApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/connected-service-run/materialize',
                headers: { 'x-happier-daemon-token': scopedToken },
                payload: {
                    runId: 'run_1',
                    runnerPid: 4242,
                    agentId: 'codex',
                    connectedServices: RUN_BINDINGS,
                    cwd: '/tmp/project',
                },
            });
            expect(response.statusCode).toBe(501);
            expect(response.json()).toEqual({
                ok: false,
                errorCode: 'connected_service_run_materialization_unavailable',
            });
        } finally {
            await app.close();
        }
    });

    it('materializes via the injected daemon handler and returns the run env', async () => {
        const registration = {
            v: 1 as const,
            activationId,
            runKey: 'run_1',
            agentId: 'codex',
            materializationKey: 'run_1',
            connectedServicesBindings: RUN_BINDINGS,
            connectedServiceSelectionsEnv: { HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: '{"v":1}' },
            sessionDirectory: '/tmp/project',
            materializedRoot: '/stack/daemon/connected-services/materialized/run_1/codex',
        };
        const materializeConnectedServicesForExecutionRun = vi.fn(async () => ({
            ok: true as const,
            activationId,
            env: { CODEX_HOME: '/stack/daemon/connected-services/materialized/run_1/codex-home' },
            connectedServicesBindings: RUN_BINDINGS,
            registration,
        }));
        const app = createApp({ materializeConnectedServicesForExecutionRun });
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/connected-service-run/materialize',
                headers: { 'x-happier-daemon-token': scopedToken },
                payload: {
                    runId: 'run_1',
                    runnerPid: 4242,
                    agentId: 'codex',
                    connectedServices: RUN_BINDINGS,
                    cwd: '/tmp/project',
                },
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({
                ok: true,
                result: {
                    activationId,
                    env: { CODEX_HOME: '/stack/daemon/connected-services/materialized/run_1/codex-home' },
                    connectedServicesBindings: RUN_BINDINGS,
                    registration,
                },
            });
            expect(materializeConnectedServicesForExecutionRun).toHaveBeenCalledWith({
                runId: 'run_1',
                runnerPid: 4242,
                agentId: 'codex',
                connectedServices: expect.objectContaining({ v: 1 }),
                cwd: '/tmp/project',
            });
        } finally {
            await app.close();
        }
    });

    it('propagates fail-closed materialization denials as 403 with the handler errorCode', async () => {
        const materializeConnectedServicesForExecutionRun = vi.fn(async () => ({
            ok: false as const,
            errorCode: 'connected_service_run_materialization_blocked' as const,
            errorMessage: 'credential expired',
        }));
        const app = createApp({ materializeConnectedServicesForExecutionRun });
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/connected-service-run/materialize',
                headers: { 'x-happier-daemon-token': scopedToken },
                payload: {
                    runId: 'run_1',
                    runnerPid: 4242,
                    agentId: 'codex',
                    connectedServices: RUN_BINDINGS,
                    cwd: '/tmp/project',
                },
            });
            expect(response.statusCode).toBe(403);
            expect(response.json()).toEqual({
                ok: false,
                errorCode: 'connected_service_run_materialization_blocked',
                errorMessage: 'credential expired',
            });
        } finally {
            await app.close();
        }
    });

    it('releases run materialization through the injected release handler', async () => {
        const releaseConnectedServicesForExecutionRun = vi.fn(async () => ({ ok: true as const, released: true }));
        const app = createApp({ releaseConnectedServicesForExecutionRun });
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/connected-service-run/release',
                headers: { 'x-happier-daemon-token': scopedToken },
                payload: {
                    runId: 'run_1',
                    runnerPid: 4242,
                    activationId,
                },
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ ok: true, released: true });
            expect(releaseConnectedServicesForExecutionRun).toHaveBeenCalledWith({
                runId: 'run_1',
                runnerPid: 4242,
                activationId,
            });
        } finally {
            await app.close();
        }
    });

    it('checks generation through the scoped endpoint and fails closed without a handler', async () => {
        const checkConnectedServicesGenerationForExecutionRun = vi.fn(async () => ({ ok: true as const, current: true }));
        const app = createApp({ checkConnectedServicesGenerationForExecutionRun });
        try {
            const authorized = await app.inject({
                method: 'POST',
                url: '/connected-service-run/generation-current',
                headers: { 'x-happier-daemon-token': scopedToken },
                payload: { runId: 'run_1', runnerPid: 4242 },
            });
            expect(authorized.json()).toEqual({ ok: true, current: true });
            expect(checkConnectedServicesGenerationForExecutionRun).toHaveBeenCalledWith({ runId: 'run_1', runnerPid: 4242 });
        } finally {
            await app.close();
        }

        const appWithoutHandler = createApp();
        try {
            const closed = await appWithoutHandler.inject({
                method: 'POST',
                url: '/connected-service-run/generation-current',
                headers: { 'x-happier-daemon-token': scopedToken },
                payload: { runId: 'run_1', runnerPid: 4242 },
            });
            expect(closed.json()).toEqual({ ok: true, current: false });
        } finally {
            await appWithoutHandler.close();
        }
    });

    it('release is a bounded no-op success when no release handler is wired', async () => {
        const app = createApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/connected-service-run/release',
                headers: { 'x-happier-daemon-token': scopedToken },
                payload: { runId: 'run_1', runnerPid: 4242, activationId },
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ ok: true, released: false });
        } finally {
            await app.close();
        }
    });
});
