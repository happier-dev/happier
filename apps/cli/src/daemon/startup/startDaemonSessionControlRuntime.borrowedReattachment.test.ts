import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { projectSessionOwnerCompatibilityViewV1, SessionMetadataTuplePatchSuccessV1Schema } from '@happier-dev/protocol';

import { configuration, reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createDeferred } from '@/testkit/async/deferred';
import { readSessionMarker, writeSessionMarker } from '../sessionRegistry';
import { buildTrackedSessionFromMarker } from '../sessions/trackedSessionFromMarker';
import {
    readTerminalHostAttachmentInfo,
    removeTerminalHostAttachmentInfo,
    writeTerminalHostAttachmentInfo,
    writeTerminalAttachmentInfo,
} from '@/terminal/attachment/terminalAttachmentInfo';
import { startDaemonSessionControlRuntime } from './startDaemonSessionControlRuntime';
import { createSessionHooksService } from '@/plugins/runtime/hooks/session/service';
import { createHerdrTerminalHostAdapter } from '@/integrations/herdr/adapter';
import { withHerdrApi } from '@/integrations/herdr/herdrApi.testkit';
import { createSessionRecordFixture, type SessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { publishReportedTerminalControlServiceability } from './publishReportedTerminalControlServiceability';
import { startDaemonControlServer } from '../controlServer';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import type { TrackedSession } from '../types';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';
import { createSessionHolderSocketPath } from '@/subprocess/supervision/sessionHolder';

const boundary = vi.hoisted(() => ({
    metadata: {} as Record<string, unknown>,
    version: 1,
    sessionId: 'session-reattached-borrowed',
    tuple: null as Pick<SessionRecordFixture, 'metadataLayoutVersion' | 'metadata' | 'ownerMetadata' | 'agentState' | 'agentStateVersion'> | null,
}));
const hookRemoval = vi.hoisted(() => ({ target: '', completion: null as Promise<void> | null }));
const terminalRemoval = vi.hoisted(() => ({ target: '', beforeUnlink: null as (() => Promise<void>) | null }));
// Join the real asynchronous filesystem removal, not the retirement decision.
vi.mock('node:fs/promises', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:fs/promises')>();
    return { ...original, unlink: async (...args: Parameters<typeof original.unlink>) => {
        if (args[0] === terminalRemoval.target) await terminalRemoval.beforeUnlink?.();
        await original.unlink(...args);
    }, rm: (...args: Parameters<typeof original.rm>) => {
        const completion = original.rm(...args);
        if (args[0] === hookRemoval.target) hookRemoval.completion = completion;
        return completion;
    } };
});

// Home HTTP transport only: the metadata updater/CAS and exact retirement are real.
vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
    fetchSessionByIdCompat: vi.fn(async () => ({
        ...createSessionRecordFixture({ id: boundary.sessionId,
            metadata: JSON.stringify(boundary.metadata), metadataVersion: boundary.version,
            ...boundary.tuple }),
        encryptionMode: 'plain',
    })),
    patchSessionMetadata: vi.fn(async ({ expectedVersion, ciphertext }: { expectedVersion: number; ciphertext: string }) => {
        expect(boundary.tuple).toBeNull();
        expect(expectedVersion).toBe(boundary.version);
        boundary.metadata = JSON.parse(ciphertext) as Record<string, unknown>;
        boundary.version += 1;
        return { success: true, version: boundary.version };
    }),
    patchSessionMetadataEnvelopeTuple: vi.fn(async ({ patch }: Parameters<typeof import('@/session/transport/http/sessionsHttp').patchSessionMetadataEnvelopeTuple>[0]) => {
        if (patch.mode === 'owner_migration') {
            expect(boundary.tuple).toBeNull();
            expect(patch.source.metadata).toEqual({ version: boundary.version, ciphertext: JSON.stringify(boundary.metadata) });
            expect(patch.source.agentState).toEqual({ version: 0, ciphertext: null });
            boundary.tuple = {
                metadataLayoutVersion: 1, metadata: patch.target.sharedMetadata.ciphertext,
                ownerMetadata: patch.target.ownerMetadata, agentState: patch.target.agentState.ciphertext,
                agentStateVersion: 1,
            };
        } else if (patch.mode === 'owner') {
            expect(boundary.tuple).not.toBeNull();
            expect(patch.sharedMetadata.expectedVersion).toBe(boundary.version);
            expect(patch.expectedOwnerMetadata).toEqual(boundary.tuple!.ownerMetadata);
            expect(patch.agentState.expectedVersion).toBe(boundary.tuple!.agentStateVersion);
            boundary.tuple = {
                metadataLayoutVersion: 1, metadata: patch.sharedMetadata.ciphertext,
                ownerMetadata: patch.ownerMetadata, agentState: patch.agentState.ciphertext,
                agentStateVersion: boundary.tuple!.agentStateVersion + 1,
            };
        } else {
            throw new Error('Expected a canonical owner tuple mutation');
        }
        const ownerMetadata = boundary.tuple.ownerMetadata;
        if (ownerMetadata?.t !== 'plain') throw new Error('Expected plain owner metadata');
        boundary.metadata = projectSessionOwnerCompatibilityViewV1({
            sharedMetadata: JSON.parse(boundary.tuple.metadata),
            ownerMetadata: ownerMetadata.v,
        });
        boundary.version += 1;
        return SessionMetadataTuplePatchSuccessV1Schema.parse({
            success: true, metadataLayoutVersion: 1, sharedMetadata: { version: boundary.version },
            agentState: { version: boundary.tuple.agentStateVersion },
        });
    }),
}));
vi.mock('@/api/client/connectedServiceCredentialApi', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/api/client/connectedServiceCredentialApi')>(),
    fetchAccountEncryptionCurrentness: vi.fn(async () => ({
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    })),
}));
// Loopback HTTP is outside the lifecycle owner; no incoming requests are needed here.
vi.mock('@/daemon/controlServer', () => ({
    startDaemonControlServer: vi.fn(async () => ({ port: 44_321, stop: async () => {} })),
}));

const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
afterEach(() => {
    envScope.restore();
    hookRemoval.target = '';
    hookRemoval.completion = null;
    terminalRemoval.target = '';
    terminalRemoval.beforeUnlink = null;
    boundary.tuple = null;
    reloadConfiguration();
    vi.restoreAllMocks();
});

describe('startup borrowed-terminal reattachment', () => {
    it.each([
        { name: 'empty metadata', metadata: {} },
        { name: 'null metadata', metadata: null },
        { name: 'missing Home Session', metadata: undefined },
    ])('settles held-target relay restoration through target admission without Project files metadata ($name)', async ({ metadata }) => {
        const fixtureHome = await mkdtemp(join(tmpdir(), 'happier-03-held-relay-'));
        envScope.patch({ HAPPIER_HOME_DIR: fixtureHome });
        reloadConfiguration();
        const attachResponse = createDeferred<void>();
        // A Home response arrives after the startup composition has settled.
        vi.mocked(fetchSessionByIdCompat).mockImplementationOnce(async () => {
            await attachResponse.promise;
            return metadata === undefined ? null : { ...createSessionRecordFixture({ id: boundary.sessionId, metadata: JSON.stringify(metadata), metadataVersion: 1 }),
                encryptionMode: 'plain' };
        });
        const pid = 2_147_482_913;
        const tracked: TrackedSession = {
            trackingKey: legacyPidSessionTrackingKey(pid), pid, happySessionId: boundary.sessionId,
            startedBy: 'daemon', reattachedFromDiskMarker: true,
            spawnOptions: { directory: fixtureHome, managedTargetPlacement: { managedId: 'held-target', workspaceRoot: '/workspace' } },
            heldAgentsV1: [{ role: 'primary', socketPath: '/target/primary.sock', holderPid: 100, agentPid: 101,
                relaySocketPath: createSessionHolderSocketPath() }],
        };
        // Observe the real target-open refusal at its console boundary. The default
        // adapter has no admitted provider here; restoration must still reach it.
        const output = vi.spyOn(console, 'log').mockImplementation(() => {});
        const token = `e30.${Buffer.from(JSON.stringify({ sub: 'relay-owner' })).toString('base64url')}.fixture`;
        let runtime: Awaited<ReturnType<typeof startDaemonSessionControlRuntime>> | undefined;
        try {
            runtime = await startDaemonSessionControlRuntime({
                machineId: 'machine-held-relay', serverId: configuration.activeServerId,
                serverBaseUrl: configuration.apiServerUrl, credentials: { token, encryption: null }, api: {} as never,
                daemonSessionMutationCustody: { stageTranscriptMessage: async () => { throw new Error('Unexpected recording attachment'); },
                    stageTranscriptEvent: async () => ({ persisted: true, delivered: false }), stage: async () => {} },
                connectedServicesMaterializationBaseDir: join(fixtureHome, 'connected-services'),
                getConnectedServiceRefreshCoordinator: () => null, getConnectedServiceQuotasCoordinator: () => null,
                trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]), spawnAwaiterByKey: new Map(), spawnResultResolverByKey: new Map(),
                spawnWebhookTimeoutByKey: new Map(), getApiMachineForSessions: () => null,
                spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(),
                connectedServicesRestartRequestedSessions: new Set(),
                startupTerminalRecovery: { disconnectedTerminalHostCandidates: [], unresolvedTerminalHostSessionIds: [] },
                beforeShutdown: async () => {}, onHappySessionWebhook: async () => {}, requestShutdown: () => {}, processEnv: {},
            });
            attachResponse.resolve();
            await vi.waitFor(() => expect(output.mock.calls.flatMap(args => args.flatMap(argument =>
                typeof argument === 'object' && argument !== null && 'code' in argument
                    ? [argument.code] : []))).toContain('admission_unavailable'));
        } finally {
            await runtime?.stopControlServer();
            output.mockRestore();
            attachResponse.resolve();
            await rm(fixtureHome, { recursive: true, force: true });
        }
    });

    it('keeps exact guest Process Stop within physical custody without custodian Home mutation', async () => {
        const fixtureHome = await mkdtemp(join(tmpdir(), 'happier-03-guest-process-stop-'));
        envScope.patch({ HAPPIER_HOME_DIR: fixtureHome });
        reloadConfiguration();
        const pid = 2_147_482_910;
        const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(pid), pid, happySessionId: 'guest-process-stop', startedBy: 'daemon', processStartTimeMs: 100 };
        const stage = vi.fn(async () => {});
        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-guest-process-stop', serverId: configuration.activeServerId,
            serverBaseUrl: configuration.apiServerUrl,
            credentials: { token: 'token-custodian', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
            api: {} as never,
            daemonSessionMutationCustody: { stageTranscriptMessage: async () => { throw new Error('Unexpected recording attachment'); },
                stageTranscriptEvent: async () => ({ persisted: true, delivered: false }), stage },
            connectedServicesMaterializationBaseDir: join(fixtureHome, 'connected-services'),
            getConnectedServiceRefreshCoordinator: () => null, getConnectedServiceQuotasCoordinator: () => null,
            trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]), spawnAwaiterByKey: new Map(), spawnResultResolverByKey: new Map(),
            spawnWebhookTimeoutByKey: new Map(), getApiMachineForSessions: () => null,
            spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(),
            connectedServicesRestartRequestedSessions: new Set(),
            startupTerminalRecovery: { disconnectedTerminalHostCandidates: [], unresolvedTerminalHostSessionIds: [] },
            beforeShutdown: async () => {}, onHappySessionWebhook: async () => {}, requestShutdown: () => {}, processEnv: {},
        });
        try {
            vi.mocked(fetchSessionByIdCompat).mockClear();
            stage.mockClear();
            // The retired native generation cannot be signaled. Even this refusal
            // must not borrow the custodian's token to alter guest Home state.
            await runtime.processActionLifecycle.stopExactSession({ sessionId: tracked.happySessionId!, pid,
                start: { startTimeMs: 100 } });
            expect(fetchSessionByIdCompat).not.toHaveBeenCalled();
            expect(stage).not.toHaveBeenCalled();
        } finally {
            await runtime.stopControlServer();
            await rm(fixtureHome, { recursive: true, force: true });
        }
    });

    it.each(['alive', 'unknown'] as const)('retains owned provider hook artifacts after controller exit with %s host evidence', async (hostEvidence) => {
        const fixtureHome = await mkdtemp(join(tmpdir(), 'happier-03-retained-hooks-'));
        envScope.patch({ HAPPIER_HOME_DIR: fixtureHome });
        reloadConfiguration();
        const sessionId = boundary.sessionId;
        const pid = 2_147_482_912;
        const hooks = createSessionHooksService({ happyHomeDir: fixtureHome, hasCapability: capability => capability === 'sessionHooks' });
        const endpoint = await hooks.startServer({
            providerId: 'claude', sessionId, lifecycle: { kind: 'session', sessionId },
        });
        const oldPort = endpoint.port;
        const secretFile = endpoint.sessionHookSecretFile!;
        // The host owns the secret; the retained one must survive reattachment.
        const retainedSecret = await readFile(secretFile, 'utf8');
        hookRemoval.target = dirname(dirname(dirname(secretFile)));
        await endpoint.dispose();
        try {
            await withHerdrApi(async (api) => {
                api.panes.add('managed');
                if (hostEvidence === 'unknown') api.faults.set('pane.process_info', 'disconnect');
                const attachment = await writeTerminalHostAttachmentInfo({
                    happyHomeDir: fixtureHome, sessionId, lifecycle: 'owned',
                    handle: { kind: 'herdr', sessionName: 'work', socketPath: api.socketPath,
                        paneId: 'managed', terminalId: 'terminal_1',
                        attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' } },
                });
                const terminal = { mode: 'herdr' as const, herdr: { sessionName: 'work', socketPath: api.socketPath,
                    paneId: 'managed', terminalId: 'terminal_1' }, controlServiceabilityV1: {
                    v: 1 as const, attachmentId: attachment.attachmentId, state: 'servable' as const, observedAt: 1,
                } };
                const metadata = { path: '/tmp/project', host: 'test-host', homeDir: '/tmp/home', happyHomeDir: fixtureHome,
                    happyLibDir: '/tmp/lib', happyToolsDir: '/tmp/tools', terminal };
                boundary.metadata = metadata;
                boundary.version = 1;
                await writeSessionMarker({ trackingKey: legacyPidSessionTrackingKey(pid), pid, happySessionId: sessionId, startedBy: 'terminal', metadata });
                const marker = await readSessionMarker(legacyPidSessionTrackingKey(pid));
                expect(marker).not.toBeNull();
                const trackedSessions = new Map([[legacyPidSessionTrackingKey(pid), buildTrackedSessionFromMarker({ marker: marker!,
                    startedByFallback: 'reattached', reattachedFromDiskMarker: true })]]);
                const runtime = await startDaemonSessionControlRuntime({
                    machineId: 'machine-retained-hooks', serverId: configuration.activeServerId,
                    serverBaseUrl: configuration.apiServerUrl,
                    credentials: { token: 'token-daemon', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
                    api: {} as never,
                    daemonSessionMutationCustody: { stageTranscriptMessage: async () => { throw new Error('Unexpected recording attachment'); },
                        stageTranscriptEvent: async () => ({ persisted: true, delivered: false }), stage: async () => {} },
                    connectedServicesMaterializationBaseDir: join(fixtureHome, 'connected-services'),
                    getConnectedServiceRefreshCoordinator: () => null, getConnectedServiceQuotasCoordinator: () => null,
                    trackedSessionsByKey: trackedSessions, spawnAwaiterByKey: new Map(), spawnResultResolverByKey: new Map(),
                    spawnWebhookTimeoutByKey: new Map(), getApiMachineForSessions: () => null,
                    spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(),
                    connectedServicesRestartRequestedSessions: new Set(),
                    loadTerminalHostAdapters: async () => ({ herdr: createHerdrTerminalHostAdapter({
                        binary: '/fixture/herdr', sessionName: 'work', actionTimeoutMs: 1000, startupTimeoutMs: 1000,
                    }) }),
                    startupTerminalRecovery: { disconnectedTerminalHostCandidates: [], unresolvedTerminalHostSessionIds: [] },
                    beforeShutdown: async () => {}, onHappySessionWebhook: async () => {}, requestShutdown: () => {}, processEnv: {},
                });
                try {
                    // Real startup wrapper and feed; only the loopback HTTP listener is replaced.
                    // An unmounted native owner cannot establish authoritative empty custody.
                    const routes = vi.mocked(startDaemonControlServer).mock.calls.at(-1)?.[0].localServicesLauncher;
                    await expect(routes?.getSnapshot({ projection: 'managed_bindings', scope: 'workspace', workspaceRoot: '/unmounted-project' }))
                        .rejects.toMatchObject({ code: 'project_service_bindings_unavailable' });
                    await runtime.onChildExited(pid, { reason: 'process-exited', code: 1, signal: null });
                    expect(trackedSessions.has(legacyPidSessionTrackingKey(pid))).toBe(false);
                    await hookRemoval.completion;
                    await expect(readFile(secretFile, 'utf8')).resolves.toBe(retainedSecret);
                    const replacement = await hooks.startServer({ providerId: 'claude', sessionId,
                        lifecycle: { kind: 'session', sessionId } });
                    try {
                        expect(replacement.port).toBe(oldPort);
                        expect(replacement.sessionHookSecretFile).toBe(secretFile);
                        const response = await fetch(`http://127.0.0.1:${replacement.port}/hook/session-start`, {
                            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-happier-hook-secret': retainedSecret },
                            body: JSON.stringify({ session_id: 'same-native-provider-id' }),
                        });
                        expect(response.status).toBe(200);
                    } finally { await replacement.dispose(); }
                    expect(await readTerminalHostAttachmentInfo({ happyHomeDir: fixtureHome, sessionId })).toEqual(attachment);
                    expect(api.requests.some(request => request.method === 'layout.apply' || request.method === 'pane.close')).toBe(false);
                } finally { await runtime.stopControlServer(); }
            });
        } finally { await rm(fixtureHome, { recursive: true, force: true }); }
    });

    it.each(['released', 'replaced'] as const)('retires only its published borrowed attachment after the descriptor is %s', async (descriptorCase) => {
        const fixtureHome = await mkdtemp(join(tmpdir(), 'happier-03-borrowed-reattach-'));
        envScope.patch({ HAPPIER_HOME_DIR: fixtureHome });
        reloadConfiguration();
        const pid = 2_147_482_911;
        const sessionId = boundary.sessionId;
        const attachment = await writeTerminalHostAttachmentInfo({
            happyHomeDir: fixtureHome, sessionId, lifecycle: 'borrowed',
            handle: { kind: 'tmux', sessionName: 'user-shell', paneId: 'user-pane',
                attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' } },
        });
        const terminal = {
            mode: 'tmux' as const, tmux: { target: 'user-shell:user-pane' },
            controlServiceabilityV1: {
                v: 1 as const, attachmentId: attachment.attachmentId, state: 'servable' as const, observedAt: 1,
            },
        };
        const metadata = {
            path: '/tmp/project', host: 'test-host', homeDir: '/tmp/home', happyHomeDir: fixtureHome,
            happyLibDir: '/tmp/lib', happyToolsDir: '/tmp/tools', terminal,
        };
        boundary.metadata = metadata;
        boundary.version = 1;
        await writeSessionMarker({ trackingKey: legacyPidSessionTrackingKey(pid), pid, happySessionId: sessionId, startedBy: 'terminal', metadata });
        const marker = await readSessionMarker(legacyPidSessionTrackingKey(pid));
        expect(marker).not.toBeNull();
        const trackedSessions = new Map([[legacyPidSessionTrackingKey(pid), buildTrackedSessionFromMarker({
            marker: marker!, startedByFallback: 'reattached', reattachedFromDiskMarker: true,
        })]]);
        // The canonical reported-attachment producer captures borrowed custody
        // while the exact descriptor still exists. Disk markers alone do not.
        await publishReportedTerminalControlServiceability({
            tracked: trackedSessions.get(legacyPidSessionTrackingKey(pid))!,
            readTerminalAttachmentInfo: async (id) => await readTerminalHostAttachmentInfo({ happyHomeDir: fixtureHome, sessionId: id }),
            probeSessionRunnerServiceability: async () => { throw new Error('Published serviceability needs no additional probe'); },
            publishSessionRunnerControlServiceability: async () => { throw new Error('Published serviceability needs no additional write'); },
        });
        const dispose = vi.fn(async () => {});
        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-borrowed-reattachment', serverId: configuration.activeServerId,
            serverBaseUrl: configuration.apiServerUrl,
            credentials: { token: 'token-daemon', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
            api: {} as never,
            daemonSessionMutationCustody: { stageTranscriptMessage: async () => { throw new Error('Unexpected recording attachment in this fixture'); }, stageTranscriptEvent: async () => ({ persisted: true, delivered: false }), stage: async () => {} },
            connectedServicesMaterializationBaseDir: join(fixtureHome, 'connected-services'),
            getConnectedServiceRefreshCoordinator: () => null, getConnectedServiceQuotasCoordinator: () => null,
            trackedSessionsByKey: trackedSessions, spawnAwaiterByKey: new Map(),
            spawnResultResolverByKey: new Map(), spawnWebhookTimeoutByKey: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(),
            connectedServicesRestartRequestedSessions: new Set(),
            loadTerminalHostAdapters: async () => ({ tmux: {
                kind: 'tmux', createOrAttachHost: vi.fn(), injectUserPrompt: vi.fn(), interruptTurn: vi.fn(),
                evaluateLiveness: async () => ({ paneAlive: true, observedAt: 1 }), dispose,
            } }),
            startupTerminalRecovery: { disconnectedTerminalHostCandidates: [], unresolvedTerminalHostSessionIds: [] },
            beforeShutdown: async () => {}, onHappySessionWebhook: async () => {}, requestShutdown: () => {}, processEnv: {},
        });
        try {
            await removeTerminalHostAttachmentInfo({ happyHomeDir: fixtureHome, sessionId, expectedAttachmentId: attachment.attachmentId });
            const replacement = descriptorCase === 'replaced' ? await writeTerminalHostAttachmentInfo({
                happyHomeDir: fixtureHome, sessionId, lifecycle: 'borrowed',
                handle: { ...attachment.handle, attachmentId: undefined, paneId: 'replacement-pane' },
            }) : null;
            if (replacement) boundary.metadata = { ...metadata, terminal: {
                ...terminal, controlServiceabilityV1: { ...terminal.controlServiceabilityV1, attachmentId: replacement.attachmentId, observedAt: 2 },
            } };
            const metadataBeforeExit = boundary.metadata;
            await writeTerminalAttachmentInfo({ happyHomeDir: fixtureHome, sessionId, terminal });
            const removalStarted = createDeferred<void>();
            const allowRemoval = createDeferred<void>();
            terminalRemoval.target = join(fixtureHome, 'terminal', 'sessions', `${encodeURIComponent(sessionId)}.json`);
            terminalRemoval.beforeUnlink = async () => { removalStarted.resolve(); await allowRemoval.promise; };
            // Exercise exit retirement, not no-turn Home finalization (this
            // fixture has no Machine terminal-authority transport).
            let exitSettled = false;
            const exited = runtime.onChildExited(pid, { reason: 'process-exited', code: 1, signal: null });
            void exited.then(() => { exitSettled = true; }, () => { exitSettled = true; });
            let exitSettledWhileRemovalBlocked = false;
            try {
                await removalStarted.promise;
                exitSettledWhileRemovalBlocked = exitSettled;
            } finally {
                allowRemoval.resolve();
                await exited;
            }
            // Join the real filesystem boundary even on RED so fixture
            // teardown cannot obscure an early-return assertion with ENOTEMPTY.
            await expect.poll(async () => (await readdir(dirname(terminalRemoval.target)))
                .some(name => name.startsWith(`${encodeURIComponent(sessionId)}.json`))).toBe(false);
            expect(exitSettledWhileRemovalBlocked).toBe(false);
            if (replacement) expect(boundary.metadata).toEqual(metadataBeforeExit);
            else expect(boundary.metadata).toMatchObject({ terminal: { controlServiceabilityV1: {
                attachmentId: attachment.attachmentId, retired: true, state: 'unknown', reason: 'attachment_retired',
            } } });
            expect(await readSessionMarker(legacyPidSessionTrackingKey(pid))).toBeNull();
            expect(await readTerminalHostAttachmentInfo({ happyHomeDir: fixtureHome, sessionId })).toEqual(replacement);
            expect(trackedSessions.has(legacyPidSessionTrackingKey(pid))).toBe(false);
            expect(dispose).not.toHaveBeenCalled();
        } finally {
            await runtime.stopControlServer();
            await rm(fixtureHome, { recursive: true, force: true });
        }
    });
});
