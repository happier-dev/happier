import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from 'socket.io';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createTerminalAttachmentId, readTerminalHostAttachmentInfo, writeTerminalHostAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { buildTerminalMetadataFromHostHandle } from '@/terminal/runtime/terminalMetadata';

import { createDaemonControlApp } from '../controlServer';
import { readOrCreateDeviceLocalSecretStorage } from '../deviceLocalSecretStorage';
import { readProcessIdentityByPid } from '../processIdentity';
import { listSessionMarkers } from '../sessionRegistry';
import { createOnHappySessionWebhook } from '../sessions/onHappySessionWebhook';
import { probeSessionRunnerServiceability } from '../sessions/isSessionRunnerActive';
import type { TrackedSession } from '../types';
import { persistAcceptedSpawnMarker } from '../spawn/persistAcceptedSpawnMarker';
import { probeAlreadyRunningExistingSessionServiceability } from './pendingQueueNudge';
import { publishReportedTerminalControlServiceability } from './publishReportedTerminalControlServiceability';
import { createSessionStartupReadinessHandler } from './sessionStartupReadiness';

afterEach(() => { vi.unstubAllEnvs(); reloadConfiguration(); });

describe('session startup acknowledgement', () => {
    it('awaits canonical custody but acknowledges while the runner RPC follow-up is pending', async () => {
        const home = await mkdtemp(join(tmpdir(), 'happier-startup-readiness-'));
        const sessionId = 'session-startup-readiness';
        let probeStarted = false;
        const httpRequests: string[] = [];
        let releaseProbe: (() => void) | undefined;
        const http = createServer((request, response) => {
            httpRequests.push(request.url ?? '');
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ session: createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadata: '{}' }) }));
        });
        // Hold only the real Socket.IO transport response. All readiness and
        // serviceability owners, metadata parsing, and marker IO remain real.
        const sockets = new Server(http, { path: '/v1/updates/' });
        sockets.on('connection', (socket) => socket.on('rpc-call', (_request, ack) => {
            releaseProbe = () => ack({ ok: true, result: { ok: true, capability: 'pending_queue_wake_v1', protocolVersion: 1, method: 'session.pendingQueue.wake.v1' } });
            probeStarted = true;
        }));
        await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('missing HTTP endpoint');
        vi.stubEnv('HAPPIER_HOME_DIR', home);
        vi.stubEnv('HAPPIER_SERVER_URL', `http://127.0.0.1:${address.port}`);
        reloadConfiguration();
        let acceptCustody!: (accepted: boolean) => void;
        const identity = await readProcessIdentityByPid(process.pid);
        if (identity?.processStartTimeMs === undefined) throw new Error('missing process generation');
        const tracked: TrackedSession = {
            pid: process.pid,
            processStartTimeMs: identity.processStartTimeMs,
            startedBy: 'daemon',
            happySessionId: `PID-${process.pid}`,
            acceptedSpawnMarkerGate: new Promise<boolean>((resolve) => { acceptCustody = resolve; }),
            agentRuntimeDaemonServiceAuthorityFilePath: join(home, 'runner-authority.json'),
            spawnOptions: { directory: home, spawnNonce: 'readiness-startup-nonce', terminal: { mode: 'herdr' } },
        };
        const deviceLocalSecretStorage = await readOrCreateDeviceLocalSecretStorage({ path: join(home, 'device-local-secret.json') });
        await persistAcceptedSpawnMarker({ trackedSession: tracked, deviceLocalSecretStorage });
        const handle = {
            attachmentId: createTerminalAttachmentId(), kind: 'herdr' as const,
            sessionName: 'default', socketPath: join(home, 'herdr.sock'), terminalId: 'terminal-ready',
            attachMetadata: { attachStrategy: 'terminal_host' as const, topology: 'shared' as const,
                locality: 'same_machine' as const, liveProbe: 'required' as const },
        };
        await writeTerminalHostAttachmentInfo({ happyHomeDir: home, sessionId, handle });
        const terminal = { ...buildTerminalMetadataFromHostHandle(handle), controlServiceabilityV1: undefined };
        let published = false;
        let canonicalCustodyObserved = false;
        let responseCompleted = false;
        let reportStatus: number | null = null;
        let reportBody: string | null = null;
        let probeResult: Awaited<ReturnType<typeof probeSessionRunnerServiceability>> | null = null;
        const errors: unknown[] = [];
        const app = createDaemonControlApp({
            getChildren: () => [tracked], machineId: 'machine-readiness',
            spawnSession: async () => { throw new Error('unexpected spawn'); },
            stopSession: async () => ({ status: 'not_found' }), requestShutdown: () => {},
            controlToken: 'readiness-token',
            onHappySessionWebhook: createSessionStartupReadinessHandler({
                onHappySessionWebhook: createOnHappySessionWebhook({
                    pidToTrackedSession: new Map([[tracked.pid, tracked]]),
                    pidToAwaiter: new Map([[tracked.pid, () => {}]]),
                    readCredentialsFn: async () => null,
                    deviceLocalSecretStorage,
                }),
                reconcileCanonicalReadiness: async () => {
                    const markers = await listSessionMarkers();
                    expect(markers).toContainEqual(expect.objectContaining({ pid: tracked.pid, happySessionId: sessionId }));
                    canonicalCustodyObserved = true;
                },
                reconcileFollowUp: async () => await publishReportedTerminalControlServiceability({
                    tracked,
                    readTerminalAttachmentInfo: async (id) => await readTerminalHostAttachmentInfo({ happyHomeDir: home, sessionId: id }),
                    probeSessionRunnerServiceability: async (id) => probeResult = await probeSessionRunnerServiceability({
                        sessionId: id, trackedSessions: [tracked],
                        probeCapability: async () => await probeAlreadyRunningExistingSessionServiceability({ sessionId: id, credentials: { token: 'test-token', encryption: null } }),
                    }),
                    publishSessionRunnerControlServiceability: async (_id, probe) => {
                        published = probe.state === 'runner_present' && probe.control.state === 'servable';
                        return published;
                    },
                }),
                onFollowUpError: (error) => { errors.push(error); },
            }),
        });
        try {
            await app.ready();
            const report = app.inject({ method: 'POST', url: '/session-started',
                headers: { 'x-happier-daemon-token': 'readiness-token' },
                payload: { sessionId, metadata: createTestMetadata({ hostPid: process.pid, startedBy: 'daemon', happyHomeDir: home, terminal }) },
            }).then((response) => {
                responseCompleted = true;
                reportStatus = response.statusCode;
                reportBody = response.body;
                return response;
            });
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(responseCompleted).toBe(false);
            expect(canonicalCustodyObserved).toBe(false);
            acceptCustody(true);
            await vi.waitFor(() => expect(canonicalCustodyObserved, `canonical custody reached: ${JSON.stringify({ reportStatus, reportBody, failure: tracked.spawnStartupReadinessFailure })}`).toBe(true));
            await vi.waitFor(() => expect(probeStarted, `runner RPC probe reached: ${JSON.stringify({ probeResult, httpRequests, reportStatus, reportBody })}`).toBe(true));
            expect(published).toBe(false);
            // No production timeout is needed: the HTTP acknowledgement must
            // settle even though the runner cannot answer until it receives it.
            await vi.waitFor(() => expect(responseCompleted).toBe(true));
            expect((await report).statusCode).toBe(200);
            releaseProbe?.();
            await vi.waitFor(() => expect(published).toBe(true));
            expect(errors).toEqual([]);
        } finally {
            acceptCustody(true);
            releaseProbe?.();
            await app.close();
            await new Promise<void>((resolve) => sockets.close(() => resolve()));
            await rm(home, { recursive: true, force: true });
        }
    });
});
