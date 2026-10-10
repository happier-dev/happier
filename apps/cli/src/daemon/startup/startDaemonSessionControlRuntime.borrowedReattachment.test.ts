import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { projectSessionOwnerCompatibilityViewV1 } from '@happier-dev/protocol';

import { configuration, reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { readSessionMarkerForPid, writeSessionMarker } from '../sessionRegistry';
import { buildTrackedSessionFromMarker } from '../sessions/trackedSessionFromMarker';
import {
    readTerminalHostAttachmentInfo,
    removeTerminalHostAttachmentInfo,
    writeTerminalHostAttachmentInfo,
} from '@/terminal/attachment/terminalAttachmentInfo';
import { startDaemonSessionControlRuntime } from './startDaemonSessionControlRuntime';
import { createSessionHooksService } from '@/plugins/runtime/hooks/session/service';
import { createHerdrTerminalHostAdapter } from '@/integrations/herdr/adapter';
import { withHerdrApi } from '@/integrations/herdr/herdrApi.testkit';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { publishReportedTerminalControlServiceability } from './publishReportedTerminalControlServiceability';
import { startDaemonControlServer } from '../controlServer';

const boundary = vi.hoisted(() => ({
    metadata: {} as Record<string, unknown>,
    version: 1,
    sessionId: 'session-reattached-borrowed',
}));
const hookRemoval = vi.hoisted(() => ({ target: '', completion: null as Promise<void> | null }));
// Join the real asynchronous filesystem removal, not the retirement decision.
vi.mock('node:fs/promises', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:fs/promises')>();
    return { ...original, rm: (...args: Parameters<typeof original.rm>) => {
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
            metadata: JSON.stringify(boundary.metadata), metadataVersion: boundary.version }),
        encryptionMode: 'plain',
    })),
    patchSessionMetadata: vi.fn(async ({ expectedVersion, ciphertext }: { expectedVersion: number; ciphertext: string }) => {
        expect(expectedVersion).toBe(boundary.version);
        boundary.metadata = JSON.parse(ciphertext) as Record<string, unknown>;
        boundary.version += 1;
        return { success: true, version: boundary.version };
    }),
    patchSessionMetadataEnvelopeTuple: vi.fn(async ({ patch }: Parameters<typeof import('@/session/transport/http/sessionsHttp').patchSessionMetadataEnvelopeTuple>[0]) => {
        if (patch.mode !== 'owner_migration' || patch.target.ownerMetadata.t !== 'plain') {
            throw new Error('Expected the canonical plain-owner tuple migration');
        }
        expect(patch.source.metadata.version).toBe(boundary.version);
        boundary.metadata = projectSessionOwnerCompatibilityViewV1({
            sharedMetadata: JSON.parse(patch.target.sharedMetadata.ciphertext),
            ownerMetadata: patch.target.ownerMetadata.v,
        });
        boundary.version += 1;
        return { success: true, metadataLayoutVersion: 1, sharedMetadata: { version: boundary.version }, agentState: { version: 1 } };
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
    reloadConfiguration();
    vi.restoreAllMocks();
});

describe('startup borrowed-terminal reattachment', () => {
    it.each(['alive', 'unknown'] as const)('retains owned provider hook artifacts after controller exit with %s host evidence', async (hostEvidence) => {
        const fixtureHome = await mkdtemp(join(tmpdir(), 'happier-03-retained-hooks-'));
        envScope.patch({ HAPPIER_HOME_DIR: fixtureHome });
        reloadConfiguration();
        const sessionId = boundary.sessionId;
        const pid = 2_147_482_912;
        const hooks = createSessionHooksService({ happyHomeDir: fixtureHome, hasCapability: capability => capability === 'sessionHooks' });
        const endpoint = await hooks.startServer({
            providerId: 'claude', sessionId, lifecycle: { kind: 'session', sessionId },
            sessionHookSecret: 'retained-provider-secret', permissionHookSecret: 'retained-permission-secret',
        });
        const oldPort = endpoint.port;
        const secretFile = endpoint.sessionHookSecretFile!;
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
                await writeSessionMarker({ pid, happySessionId: sessionId, startedBy: 'terminal', metadata });
                const marker = await readSessionMarkerForPid(pid);
                expect(marker).not.toBeNull();
                const trackedSessions = new Map([[pid, buildTrackedSessionFromMarker({ marker: marker!,
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
                    pidToTrackedSession: trackedSessions, pidToAwaiter: new Map(), pidToSpawnResultResolver: new Map(),
                    pidToSpawnWebhookTimeout: new Map(), getApiMachineForSessions: () => null,
                    spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(),
                    connectedServicesRestartRequestedPids: new Set(),
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
                    expect(trackedSessions.has(pid)).toBe(false);
                    await hookRemoval.completion;
                    await expect(readFile(secretFile, 'utf8')).resolves.toBe('retained-provider-secret');
                    const replacement = await hooks.startServer({ providerId: 'claude', sessionId,
                        lifecycle: { kind: 'session', sessionId }, sessionHookSecret: 'proposed-new-secret' });
                    try {
                        expect(replacement.port).toBe(oldPort);
                        expect(replacement.sessionHookSecretFile).toBe(secretFile);
                        const response = await fetch(`http://127.0.0.1:${replacement.port}/hook/session-start`, {
                            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-happier-hook-secret': 'retained-provider-secret' },
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
        await writeSessionMarker({ pid, happySessionId: sessionId, startedBy: 'terminal', metadata });
        const marker = await readSessionMarkerForPid(pid);
        expect(marker).not.toBeNull();
        const trackedSessions = new Map([[pid, buildTrackedSessionFromMarker({
            marker: marker!, startedByFallback: 'reattached', reattachedFromDiskMarker: true,
        })]]);
        // The canonical reported-attachment producer captures borrowed custody
        // while the exact descriptor still exists. Disk markers alone do not.
        await publishReportedTerminalControlServiceability({
            tracked: trackedSessions.get(pid)!,
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
            pidToTrackedSession: trackedSessions, pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(), pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
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
            // Exercise exit retirement, not no-turn Home finalization (this
            // fixture has no Machine terminal-authority transport).
            await runtime.onChildExited(pid, { reason: 'process-exited', code: 1, signal: null });
            if (replacement) expect(boundary.metadata).toEqual(metadataBeforeExit);
            else expect(boundary.metadata).toMatchObject({ terminal: { controlServiceabilityV1: {
                attachmentId: attachment.attachmentId, retired: true, state: 'unknown', reason: 'attachment_retired',
            } } });
            expect(await readSessionMarkerForPid(pid)).toBeNull();
            expect(await readTerminalHostAttachmentInfo({ happyHomeDir: fixtureHome, sessionId })).toEqual(replacement);
            expect(trackedSessions.has(pid)).toBe(false);
            expect(dispose).not.toHaveBeenCalled();
        } finally {
            await runtime.stopControlServer();
            await rm(fixtureHome, { recursive: true, force: true });
        }
    });
});
