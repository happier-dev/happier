import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from 'socket.io';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { configuration, reloadConfiguration } from '@/configuration';
import { reportSessionToDaemonIfRunning } from '@/agent/runtime/startupSideEffects';
import { readSessionPreparationFailureDiagnostic } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { AGENT_RUNTIME_DAEMON_SERVICES_PATH, AgentRuntimeDaemonServiceResponseV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createTerminalAttachmentId, readTerminalHostAttachmentInfo, writeTerminalHostAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { buildTerminalMetadataFromHostHandle } from '@/terminal/runtime/terminalMetadata';

import { createDaemonControlApp } from '../controlServer';
import { readOrCreateDeviceLocalSecretStorage } from '../deviceLocalSecretStorage';
import { readProcessIdentityByPid } from '../processIdentity';
import { hashProcessCommand, listSessionMarkers, promoteSessionMarkerPid, readSessionMarkerForPid, writeSessionMarker } from '../sessionRegistry';
import { createAgentRuntimeDaemonServiceAuthorityPath, readAgentRuntimeDaemonServiceAuthorityForVerifiedMarker } from '../agentRuntime/sessionBridgeAuthorization';
import { refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority } from '../agentRuntime/refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority';
import { promoteForegroundDaemonServiceAuthority } from '../agentRuntime/promoteForegroundDaemonServiceAuthority';
import { reconcileAgentRuntimeRestartDisposition } from '../sessions/reconcileAgentRuntimeRestartDisposition';
import { createOnHappySessionWebhook } from '../sessions/onHappySessionWebhook';
import { probeSessionRunnerServiceability } from '../sessions/isSessionRunnerActive';
import type { TrackedSession } from '../types';
import { persistAcceptedSpawnMarker } from '../spawn/persistAcceptedSpawnMarker';
import { waitForSessionWebhook } from '../spawn/waitForSessionWebhook';
import { probeAlreadyRunningExistingSessionServiceability } from './pendingQueueNudge';
import { publishReportedTerminalControlServiceability } from './publishReportedTerminalControlServiceability';
import { createSessionStartupReadinessHandler } from './sessionStartupReadiness';

afterEach(() => { vi.unstubAllEnvs(); reloadConfiguration(); });

describe('session startup acknowledgement', () => {
    it('retains the native connection refusal through the real loopback readiness report without endpoint or credential content', async () => {
        const listener = createServer();
        await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
        const address = listener.address();
        if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
        await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
        const refusal = await reportSessionToDaemonIfRunning({
            sessionId: 'refused-readiness-control', metadata: createTestMetadata({ startedBy: 'daemon' }), requireDaemonAck: true,
        }, {
            retryTimeoutMs: 0,
            notifyDaemonSessionStartedFn: (id, snapshot, options) => notifyDaemonSessionStarted(id, snapshot, {
                ...options, target: { pid: process.pid, httpPort: address.port, controlToken: 'private-control-token' },
            }),
        }).catch((error: unknown) => error);
        expect(refusal).toMatchObject({ code: 'native_agent_privileged_effect_outcome_unknown' });
        const diagnostic = readSessionPreparationFailureDiagnostic(refusal);
        expect(diagnostic).toMatchObject({
            failureCause: { phase: 'client_start', failureReason: 'unknown', code: 'ECONNREFUSED' },
        });
        expect(JSON.stringify(diagnostic)).not.toMatch(/private-control-token|127\.0\.0\.1|refused-readiness-control/);
    });

    it.each(['service ingress', 'restart reattachment', 'foreground promotion', 'committed Team Session'] as const)(
        'settles fresh wrapper creation only after the captured child marker and runner authority are published: %s', async (phase) => {
        const home = await mkdtemp(join(tmpdir(), 'happier-fresh-wrapper-readiness-'));
        vi.stubEnv('HAPPIER_HOME_DIR', home);
        reloadConfiguration();
        const wrapperPid = 649131;
        const runnerPid = 649132;
        const sessionId = 'session-fresh-wrapper-readiness';
        const command = '/immutable/runtime/versions/1.2.3/bin/happier fixture';
        // Only the native process table is substituted; all report, readiness,
        // marker, source-custody and private-authority owners below are real.
        const readIdentity = async (pid: number) => ({ pid,
            processStartTimeMs: pid === wrapperPid ? 12_345 : 23_456,
            command: pid === wrapperPid ? '/runtime/scope-exit' : command });
        const authorityPath = await createAgentRuntimeDaemonServiceAuthorityPath({ happyHomeDir: home, publicReleaseRing: configuration.publicReleaseRing });
        const binding = createAgentSessionRunnerFactoryBinding({ v: 1, pluginId: 'fixture.runner', pluginVersion: '1.2.3',
            agentId: 'fixture', localAgentId: 'fixture',
            sourceCustody: { kind: 'bundled_first_party', packagedRuntime: { kind: 'cli_version_root', versionRootId: '1.2.3' } },
            locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
            normalizedModulePath: 'runtime.mjs', loadMode: 'immutable-js' });
        const initialSessionId = phase === 'committed Team Session' ? sessionId : `PID-${wrapperPid}`;
        const tracked: TrackedSession = { pid: wrapperPid, startedBy: 'daemon', happySessionId: initialSessionId,
            processStartTimeMs: 12_345, processCommandHash: hashProcessCommand('/runtime/scope-exit'),
            runnerAgentInvocationContext: Object.freeze({ cwd: home, environment: Object.freeze({}), providerBindingActive: false }),
            agentRuntimeDaemonServiceAuthorityFilePath: authorityPath, acceptedSpawnMarkerGate: Promise.resolve(true),
            runnerAgentBootstrapIdentity: { agentId: 'fixture', backendId: 'fixture' },
            spawnOptions: { directory: home, backendTarget: { kind: 'backend', backendId: 'fixture' }, spawnNonce: 'fresh-wrapper',
                ...(phase === 'committed Team Session' ? { existingSessionId: sessionId, primaryTeamId: 'team',
                    teamCredentialBindings: [{ v: 1, slot: { kind: 'provider_model' }, teamId: 'team', resourceId: 'resource',
                        expectedResourceRevision: 2, deliveryMode: 'brokered' }] } : {}) } };
        await writeSessionMarker({ pid: wrapperPid, happySessionId: initialSessionId, startedBy: 'daemon', cwd: home,
            processStartTimeMs: 12_345,
            respawn: { version: 1, directory: home, backendTarget: { kind: 'builtInAgent', agentId: 'fixture' }, spawnNonce: 'fresh-wrapper' } });
        const sessions = new Map([[wrapperPid, tracked]]);
        const awaiters = new Map<number, (session: TrackedSession) => void>();
        const resolvers = new Map<number, (result: SpawnSessionResult) => void>();
        const timeouts = new Map<number, NodeJS.Timeout>();
        const startup = waitForSessionWebhook({ pid: wrapperPid, pidToTrackedSession: sessions, pidToAwaiter: awaiters,
            pidToSpawnResultResolver: resolvers, pidToSpawnWebhookTimeout: timeouts, timeoutErrorMessage: 'Fixture startup failed' });
        const handler = createSessionStartupReadinessHandler({
            onHappySessionWebhook: createOnHappySessionWebhook({ pidToTrackedSession: sessions, pidToAwaiter: awaiters,
                getParentPidFn: async () => wrapperPid, readProcessIdentityByPidFn: readIdentity,
                promoteSessionMarkerFn: (from, to) => promoteSessionMarkerPid(from, to, { readProcessIdentityByPidFn: readIdentity }),
                readCredentialsFn: async () => null }),
            reconcileCanonicalReadiness: async (candidate) => {
                await refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority({ happyHomeDir: home,
                    publicReleaseRing: configuration.publicReleaseRing, httpPort: 3210, sessionId, tracked: candidate,
                    // A Plugin contribution fixture uses the canonical binding producer.
                    resolveCurrentRetainedAgent: async () => binding, readProcessIdentityByPidFn: readIdentity });
            },
            reconcileFollowUp: async () => {}, onFollowUpError: (error) => { throw error; },
        });
        const app = createDaemonControlApp({ getChildren: () => [...sessions.values()], machineId: 'machine-fresh-wrapper',
            spawnSession: async () => { throw new Error('unexpected second spawn'); }, stopSession: async () => ({ status: 'not_found' }),
            requestShutdown: () => {}, controlToken: 'fresh-wrapper-token', onHappySessionWebhook: handler });
        try {
            const metadata = createTestMetadata({ hostPid: runnerPid, startedBy: 'daemon', happyHomeDir: home, path: home });
            if (phase === 'committed Team Session') {
                await app.listen({ host: '127.0.0.1', port: 0 });
                const address = app.server.address();
                if (!address || typeof address === 'string') throw new Error('Missing control listener');
                await reportSessionToDaemonIfRunning({ sessionId, metadata, requireDaemonAck: true }, {
                    notifyDaemonSessionStartedFn: (id, snapshot, options) => notifyDaemonSessionStarted(id, snapshot, {
                        ...options, target: { pid: process.pid, httpPort: address.port, controlToken: 'fresh-wrapper-token' },
                    }),
                });
                // A wrong control credential must fail at the real ingress,
                // even though the matching requester Session was admitted.
                const refusal = await reportSessionToDaemonIfRunning({ sessionId, metadata, requireDaemonAck: true }, {
                    retryTimeoutMs: 0,
                    notifyDaemonSessionStartedFn: (id, snapshot, options) => notifyDaemonSessionStarted(id, snapshot, {
                        ...options, target: { pid: process.pid, httpPort: address.port, controlToken: 'wrong-token' },
                    }),
                }).catch((error: unknown) => error);
                expect(refusal).toMatchObject({ code: 'native_agent_privileged_effect_outcome_unknown' });
                expect(readSessionPreparationFailureDiagnostic(refusal)).toMatchObject({
                    failureCause: { phase: 'client_start', failureReason: 'permission_denied', httpStatus: 401 },
                });
                expect(JSON.stringify(readSessionPreparationFailureDiagnostic(refusal))).not.toContain('wrong-token');
            } else {
                const response = await app.inject({ method: 'POST', url: '/session-started',
                    headers: { 'x-happier-daemon-token': 'fresh-wrapper-token' },
                    payload: { sessionId, metadata } });
                expect(response.statusCode, response.body).toBe(200);
            }
            await expect(startup).resolves.toMatchObject({ type: 'success', sessionId });
            const marker = await readSessionMarkerForPid(runnerPid);
            expect(marker).toMatchObject({ pid: runnerPid, happySessionId: sessionId, processStartTimeMs: 23_456,
                runnerAgentSourceCustodyV1: binding.sourceCustody });
            const authority = await readAgentRuntimeDaemonServiceAuthorityForVerifiedMarker({ happyHomeDir: home,
                publicReleaseRing: configuration.publicReleaseRing, path: authorityPath, sessionId,
                runner: { pid: runnerPid, processStartTimeMs: 23_456, processCommandHash: hashProcessCommand(command) } });
            expect(authority).toMatchObject({ sessionId, runner: { pid: runnerPid, processStartTimeMs: 23_456 }, retainedAgent: binding });
            expect(sessions.get(wrapperPid)).toBe(tracked);
            expect(tracked.processStartTimeMs).toBe(12_345);
            if (!authority) throw new Error('missing published runner authority');
            if (phase === 'restart reattachment') {
                tracked.reattachedFromDiskMarker = true;
                delete tracked.processStartTimeMs;
                delete tracked.processCommandHash;
                // An attached exact runner needs no new plugin-registry admission.
                await expect(reconcileAgentRuntimeRestartDisposition({ trackedSessions: [tracked] })).resolves.toEqual([]);
                expect(tracked.agentRuntimeRunnerRestartDisposition).toBeUndefined();
            } else if (phase === 'foreground promotion') {
                tracked.startedBy = 'terminal';
                await expect(promoteForegroundDaemonServiceAuthority({ happyHomeDir: home,
                    publicReleaseRing: configuration.publicReleaseRing, trackedSessions: sessions,
                    canonicalSessionId: sessionId, foregroundPid: runnerPid, authorityFilePath: authorityPath,
                    retainedAgent: binding, runner: authority.runner, capabilityDigest: tracked.agentRuntimeDaemonServiceCapabilityHash!,
                    invocationContext: tracked.runnerAgentInvocationContext! })).resolves.toBe(true);
                expect(tracked.processStartTimeMs).toBe(12_345);
                expect(tracked.processCommandHash).toBe(hashProcessCommand('/runtime/scope-exit'));
            } else {
                const requestService = () => app.inject({ method: 'POST', url: AGENT_RUNTIME_DAEMON_SERVICES_PATH,
                    headers: { 'x-happier-daemon-token': authority.capability },
                    payload: { v: 1, context: { token: authority.capability, sessionId },
                        operation: { kind: 'turn.admission.authorize', requestId: 'fresh-wrapper-first-turn',
                            witness: { turnId: 'turn-1', inputId: 'input-1', userMessageSeq: 1, userMessageSeqs: [1] } } } });
                // The real readiness producer's private document must pass service ingress.
                // No dispatcher is supplied: 501 proves authorization reached that boundary.
                const serviceResponse = await requestService();
                expect(serviceResponse.statusCode, serviceResponse.body).toBe(501);
                expect(AgentRuntimeDaemonServiceResponseV1Schema.parse(serviceResponse.json())).toMatchObject({
                    ok: false, error: { code: 'agent_runtime_daemon_service_unavailable' } });
                const runnerIdentity = tracked.runnerProcessIdentity;
                delete tracked.runnerProcessIdentity;
                expect((await requestService()).statusCode).toBe(403);
                tracked.runnerProcessIdentity = runnerIdentity;
                expect((await requestService()).statusCode).toBe(501);
            }
            expect(awaiters.size).toBe(0);
            expect(resolvers.size).toBe(0);
            expect(timeouts.size).toBe(0);
            if (phase === 'committed Team Session') {
                tracked.sessionCreationOutcome = { disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] } };
                const response = await app.inject({ method: 'POST', url: '/session-started',
                    headers: { 'x-happier-daemon-token': 'fresh-wrapper-token' },
                    payload: { sessionId, metadata, sessionCreationOutcome: {
                        disposition: 'rejoined', organizationPlacement: { folderId: null, tagIds: [] },
                    } } });
                expect(response.statusCode).toBe(503);
                expect(response.json()).toEqual({ status: 'error', errorCode: 'session_startup_reconciliation_failed' });
                expect(tracked.spawnStartupReadinessFailure).toMatchObject({ errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED });
            }
        } finally {
            startup.settleFailure({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED, errorMessage: 'Fixture cleanup' });
            await app.close();
            await rm(home, { recursive: true, force: true });
        }
    });

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
