import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Console } from 'node:console';
import { PassThrough } from 'node:stream';
import axios from 'axios';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionCreationCorrespondenceV1Schema, createPlainSessionOwnerMetadataEnvelopeV1, deriveSessionCreationTagV1 } from '@happier-dev/protocol';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol/spawnSession';
import type { SpawnSessionResult } from '@/session/shared/spawnSessionContract';

import { configuration, reloadConfiguration } from '@/configuration';
import { createAccountEncryptionCurrentnessFixture, createCurrentSessionProjectionRecordFixture, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { SessionOrganizationSnapshotResponseSchema } from '@happier-dev/protocol/sessions/organization/snapshot';
import { SessionLookupByTagsRequestV2Schema, SessionLookupByTagsResponseV2Schema } from '@happier-dev/protocol/sessions/control/contract';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { readProcessIdentityByPid } from '@/daemon/processIdentity';
import { createOnHappySessionWebhook } from '@/daemon/sessions/onHappySessionWebhook';
import { refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority } from '@/daemon/agentRuntime/refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority';
import { waitForSessionWebhook } from '@/daemon/spawn/waitForSessionWebhook';
import type { TrackedSession } from '@/daemon/types';
import { createSpawnedSession } from './createSpawnedSession';
import { buildSessionSpawnInitialInputAdmissionForLocalIdV1 } from './sessionInputAdmissionIdentity';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { buildSessionMetadataEnvelopeCreateFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { assertStartupFailureThroughCli } from './createSpawnedSession.startupFailure.testkit';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import { SessionTurnMutationV1Schema } from '@happier-dev/protocol/sessions/turns/sessionTurnMutationV1';
import { reportSessionRunnerFailure } from '@/cli/resolveSessionRunnerFailureExitCode';
import { readSessionRunnerFailureCause } from '@/session/shared/spawnSessionContract';
import { logger } from '@/ui/logger';
import { SessionTeamCredentialLaunchUnavailableError } from './sessionTeamCredentialLaunchError';

afterEach(() => { vi.unstubAllEnvs(); reloadConfiguration(); });

describe('durable creation after daemon startup refusal', () => {
    it.each([
        ['agent_startup_failed', 'returned'], ['agent_startup_failed', 'nonce'],
        ['agent_cli_not_runnable', 'returned'],
        ['broker_unavailable', 'returned'],
    ] as const)('retains the typed startup cause after the webhook (%s, %s)', async (code, settlementKind) => {
        const failureCause = code === 'broker_unavailable'
            ? { code, phase: 'authentication', failureReason: 'unknown' } as const
            : { code: code === 'agent_cli_not_runnable' ? 'EACCES' : code, phase: 'client_start',
            failureReason: code === 'agent_cli_not_runnable' ? 'permission_denied' : 'unclassified_provider_error' } as const;
        const error = code === 'broker_unavailable' ? new SessionTeamCredentialLaunchUnavailableError(code)
            : new PluginError({ code, message: 'PRIVATE_NATIVE_STARTUP_BODY',
            details: { failureCause, path: '/PRIVATE_NATIVE_HOME', token: 'PRIVATE_NATIVE_TOKEN' } });
        await assertStartupFailureThroughCli({ preparationCode: code, settlementKind,
            expectedFailureCause: failureCause, publishFailure: async persist => {
                // Match the real construction catch: classify the native error,
                // then publish through the turn lifecycle's persistence boundary.
                const lifecycle = createSessionTurnLifecycle({ session: { sessionId: 'c1234567890123456789012345',
                    enqueueSessionTurnMutation: async mutation => { await persist(SessionTurnMutationV1Schema.parse(mutation)); },
                } });
                try {
                    await lifecycle.failTurn({ issue: classifyPrimarySessionRuntimeIssue({
                        cause: 'session_error', error, provider: 'codex',
                    }), allocateWhenIdle: true });
                } finally { lifecycle.dispose(); }
                // Use the real console formatter, including its leading/trailing
                // newlines, rather than inventing a daemon stderr record.
                const stderr = new PassThrough();
                let output = '';
                stderr.on('data', chunk => { output += String(chunk); });
                const writer = new Console({ stdout: stderr, stderr });
                const consoleError = vi.spyOn(console, 'error').mockImplementation(writer.error.bind(writer));
                const file = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
                const fatal = vi.spyOn(logger, 'fatal').mockImplementation(() => {});
                try { expect(reportSessionRunnerFailure(error)).toBe(1); }
                finally { consoleError.mockRestore(); file.mockRestore(); fatal.mockRestore(); stderr.end(); }
                expect(readSessionRunnerFailureCause(output)).toEqual(failureCause);
                expect(output).not.toMatch(/PRIVATE_/);
            } });
    });
    it.each([
        [null, 'returned'], [null, 'nonce'],
        ['agent_cli_not_runnable', 'returned'], ['agent_cli_not_runnable', 'nonce'],
        ['plugin_mcp_preparation_unavailable', 'returned'], ['plugin_mcp_preparation_unavailable', 'nonce'],
        ['provider_endpoint_unavailable', 'returned'], ['provider_endpoint_unavailable', 'nonce'],
        ['connected_service_credential_reconnect_required', 'returned'], ['connected_service_credential_reconnect_required', 'nonce'],
        ['provider_compatibility_unverified', 'returned'], ['provider_compatibility_unverified', 'nonce'],
        ['plugin_services_managed_provider_authority_unavailable', 'returned'],
        ['agent_startup_transport_failed', 'returned'],
        ['opened', 'returned'],
    ] as const)('preserves the exact native startup outcome (%s, %s) independently of committed progress', async (preparationCode, settlementKind) => {
        await assertStartupFailureThroughCli({ preparationCode, settlementKind });
    });
    it.each([
        ['matched', 'returned'], ['conflicting', 'returned'], ['absent', 'returned'], ['matched', 'nonce'],
        ['archived', 'returned'], ['archived', 'nonce'],
        ['missing-archive-field', 'returned'],
    ] as const)('settles the %s creation candidate after %s refusal without another launch', async (candidate, settlementKind) => {
        const home = await mkdtemp(join(tmpdir(), 'happier-created-startup-failure-'));
        const sessionId = 'c1234567890123456789012345';
        const machineId = 'machine-startup-failure';
        const sessionCreationTag = deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey: 'startup-failure' });
        const correspondence = SessionCreationCorrespondenceV1Schema.parse({ v: 1, sessionCreationTag, recipe: {
            execution: { machineId, directory: { kind: 'path', path: home } },
            organization: { folderId: null, tagIds: [] },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
            modelSelection: null, profileId: null, requestedPermissionMode: null, agentModeId: null,
            configuration: null, connectedServices: null, capabilitySelection: null, transcriptStorage: null,
            terminal: null, agentSessionStartupInstructionsMarkerV1: null, checkout: null,
        } });
        const row = createCurrentSessionProjectionRecordFixture({
            ...createSessionNotificationContextFixture(sessionId), encryptionMode: 'plain', share: null,
            archivedAt: candidate === 'archived' ? 1 : candidate === 'missing-archive-field' ? undefined : null,
            metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }),
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, workspace: { path: home, host: 'fixture-host' },
                system: { sessionCreationCorrespondenceV1: candidate === 'conflicting'
                    ? SessionCreationCorrespondenceV1Schema.parse({ ...correspondence,
                        recipe: { ...correspondence.recipe, execution: { ...correspondence.recipe.execution,
                            directory: { kind: 'path', path: join(home, 'other') } } } })
                    : correspondence } }),
        });
        // Layout-one owner projections explicitly identify the owner recipient
        // and retain its Agent-state version pair. Validate the HTTP fixture
        // before launch so a malformed row cannot masquerade as settlement RED.
        const existingLookup = SessionLookupByTagsResponseV2Schema.parse({ sessions: [row] });
        let created = false;
        const unknownRequests: string[] = [];
        const http = createServer(async (request, response) => {
            response.setHeader('Content-Type', 'application/json');
            if (request.headers.authorization !== 'Bearer fixture-token') {
                response.statusCode = 401;
                response.end('{}');
                return;
            }
            if (request.url === '/v1/account/profile') response.end(JSON.stringify({ id: 'fixture-account' }));
            else if (request.url === '/v1/account/encryption/currentness') response.end(JSON.stringify(createAccountEncryptionCurrentnessFixture()));
            else if (request.url?.split('?')[0] === `/v2/sessions/${sessionId}`) response.end(JSON.stringify({ session: row }));
            else if (request.url === '/v2/sessions/lookup-by-tags') {
                const chunks: Buffer[] = [];
                for await (const chunk of request) chunks.push(Buffer.from(chunk));
                const lookup = SessionLookupByTagsRequestV2Schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                response.end(JSON.stringify(created && lookup.tags.includes(sessionCreationTag) ? existingLookup : { sessions: [] }));
            }
            else if (request.url?.startsWith('/v2/session-organization?')) response.end(JSON.stringify(SessionOrganizationSnapshotResponseSchema.parse({
                snapshot: { schemaVersion: 1, version: 0, pins: [], folders: [], folderAssignments: [], tags: [],
                    tagAssignments: [], orderEntries: [], labels: [] },
            })));
            else { unknownRequests.push(request.url ?? ''); response.statusCode = 404; response.end('{}'); }
        });
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Missing HTTP endpoint');
        vi.stubEnv('HAPPIER_HOME_DIR', home);
        vi.stubEnv('HAPPIER_SERVER_URL', `http://127.0.0.1:${address.port}`);
        reloadConfiguration();
        const identity = await readProcessIdentityByPid(process.pid);
        if (identity?.processStartTimeMs === undefined) throw new Error('Missing process generation');
        const tracked: TrackedSession = { startedBy: 'daemon', pid: process.pid, happySessionId: `PID-${process.pid}`,
            spawnOptions: { directory: home }, processStartTimeMs: identity.processStartTimeMs };
        const sessions = new Map([[tracked.pid, tracked]]);
        const awaiters = new Map<number, (session: TrackedSession) => void>();
        let startupResponseStatus: number | undefined;
        let launches = 0;
        const startupFailure = { result: null as Extract<SpawnSessionResult, { type: 'error' }> | null };
        const app = createDaemonControlApp({ getChildren: () => [...sessions.values()], machineId,
            spawnSession: async () => { throw new Error('Unexpected control launch'); },
            stopSession: async () => ({ status: 'not_found' }), requestShutdown() {}, controlToken: 'fixture-token',
            onHappySessionWebhook: createOnHappySessionWebhook({ pidToTrackedSession: sessions, pidToAwaiter: awaiters,
                readCredentialsFn: async () => null,
                onTrackedSessionReady: async session => {
                    session.agentRuntimeDaemonServiceAuthorityFilePath = join(home, 'authority.json');
                    await refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority({ happyHomeDir: home,
                        publicReleaseRing: 'stable', httpPort: 4321, sessionId, tracked: session,
                        // A replaced process cannot acquire authority; no Agent is resolved.
                        readProcessIdentityByPidFn: async pid => ({ ...identity, pid, processStartTimeMs: identity.processStartTimeMs! + 1 }),
                        resolveCurrentRetainedAgent: async () => { throw new Error('Replaced process resolved an Agent'); },
                    });
                },
            }),
        });
        try {
            await app.ready();
            const settlement = createSpawnedSession({ credentials: { token: 'fixture-token', encryption: null },
                directory: home, machineId, sessionCreationTag, sessionCreationCorrespondence: correspondence,
                agentTarget: correspondence.recipe.agentTarget,
                ...(candidate === 'archived' ? { initialInput: { text: 'Must remain unsent after startup refusal' },
                    buildInitialInputHandoff: (localId: string) => buildSessionSpawnInitialInputAdmissionForLocalIdV1({
                        actionCaller: { kind: 'host' }, callerSurface: 'cli', localId,
                    }) } : {}),
                directTransport: {
                    spawn: async request => {
                        launches += 1;
                        const pending = waitForSessionWebhook({ pid: tracked.pid, pidToTrackedSession: sessions,
                            pidToAwaiter: awaiters, pidToSpawnResultResolver: new Map(), pidToSpawnWebhookTimeout: new Map(),
                            timeoutErrorMessage: 'Fixture report did not complete' });
                        created = candidate !== 'absent';
                        const report = await app.inject({ method: 'POST', url: '/session-started',
                            headers: { 'x-happier-daemon-token': 'fixture-token' },
                            payload: { sessionId, metadata: createTestMetadata({ hostPid: tracked.pid, path: home,
                                startedBy: 'daemon', happyHomeDir: configuration.happyHomeDir }) } });
                        startupResponseStatus = report.statusCode;
                        const result = await pending;
                        if (result.type === 'error') startupFailure.result = result;
                        if (settlementKind === 'returned') return result;
                        if (result.type !== 'error') throw new Error('Readiness refusal did not settle the daemon waiter');
                        return { success: true, status: 'pending', sessionIdStatus: 'pending', spawnNonce: request.spawnNonce };
                    },
                    resolveSpawnSessionByNonce: async () => {
                        if (settlementKind !== 'nonce' || !startupFailure.result?.errorCode) {
                            throw new Error('Definite readiness refusal is not nonce polling');
                        }
                        return { status: 'error', errorCode: startupFailure.result.errorCode, errorMessage: startupFailure.result.errorMessage };
                    },
                },
            });
            if (candidate === 'matched' || candidate === 'missing-archive-field') {
                const result = await settlement;
                expect(result).toMatchObject({ disposition: 'rejoined', sessionId, initialInput: { status: 'notRequested' } });
                // Run the producer's result through the exact Action result consumer.
                const { session: _summary, ...creationResult } = result;
                expect(SessionSpawnNewResultV1Schema.safeParse({ type: 'success', ...creationResult,
                    executionTarget: { serverId: 'fixture-home', machineId } }).success).toBe(true);
            } else {
                await expect(settlement).rejects.toMatchObject({ code: candidate === 'conflicting' ? 'creation_conflict' : SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED });
                if (candidate === 'archived') {
                    if (!startupFailure.result) throw new Error('Missing authoritative startup refusal');
                    expect(await settlement.catch((error: unknown) => error)).toMatchObject({ message: startupFailure.result.errorMessage });
                }
            }
            expect(startupResponseStatus).toBe(503);
            expect(created).toBe(candidate !== 'absent');
            expect(launches).toBe(1);
            expect(unknownRequests).toEqual([]);
        } finally {
            await app.close();
            await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
            await rm(home, { recursive: true, force: true });
        }
    });
});
