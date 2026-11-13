import { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackedSessionForSingleSessionProcess, type SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

const os = vi.hoisted(() => ({ wrapperPid: 48101, runnerPid: 48102,
    wrapperStart: 1000, runnerStart: 2000, reused: false }));
// Only process creation and observations are substituted. Startup, marker IO,
// HTTP registration, authority publication and spawn settlement stay real.
vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, spawn: () => {
        const child = new actual.ChildProcess();
        child.pid = os.wrapperPid;
        return child;
    } };
});
vi.mock('../processIdentity', async importOriginal => ({
    ...await importOriginal<typeof import('../processIdentity')>(),
    readProcessIdentityByPid: async (pid: number) => ({
        pid, processStartTimeMs: pid === os.wrapperPid ? os.wrapperStart : os.runnerStart + (os.reused ? 1 : 0),
        command: pid === os.wrapperPid ? '/fixture/scope-exec -- node /fixture/runtime/versions/1.2.3/bin/happier'
            : '/fixture/runtime/versions/1.2.3/bin/happier claude --started-by daemon',
    }),
}));
vi.mock('../processRunState', () => ({ readProcessRunState: async () => 'running' }));

import { configuration, reloadConfiguration } from '@/configuration';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { createDaemonControlApp } from '../controlServer';
import { readOrCreateDeviceLocalSecretStorage } from '../deviceLocalSecretStorage';
import { readProcessIdentityByPid } from '../processIdentity';
import { hashProcessCommand, listSessionMarkers } from '../sessionRegistry';
import { createOnHappySessionWebhook } from '../sessions/onHappySessionWebhook';
import { createSpawnLifecycleCallbacks } from '../spawn/createSpawnLifecycleCallbacks';
import { persistAcceptedSpawnMarker } from '../spawn/persistAcceptedSpawnMarker';
import { spawnRegularProcessAndWaitForWebhook } from '../spawn/spawnRegularProcessAndWaitForWebhook';
import type { TrackedSession } from '../types';
import { createAgentRuntimeDaemonServiceAuthorityPath, readAgentRuntimeDaemonServiceAuthority } from '../agentRuntime/sessionBridgeAuthorization';
import { refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority } from '../agentRuntime/refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority';
import { createSessionStartupReadinessHandler } from './sessionStartupReadiness';

afterEach(() => { vi.unstubAllEnvs(); reloadConfiguration(); os.reused = false; });

describe('wrapped daemon Session startup', () => {
    it.each(['duplicate report', 'accepted marker', 'pre-created Team'] as const)('publishes runner authority and retains the wrapper witness after %s', async refreshKind => {
        const home = await mkdtemp(join(tmpdir(), 'happier-wrapped-startup-'));
        vi.stubEnv('HAPPIER_HOME_DIR', home);
        reloadConfiguration();
        const tracked = new Map<SessionTrackingKey, TrackedSession>();
        const awaiters = new Map<SessionTrackingKey, (session: TrackedSession) => void>();
        const deviceLocalSecretStorage = await readOrCreateDeviceLocalSecretStorage({ path: join(home, 'device-local-key.json') });
        const authorityPath = await createAgentRuntimeDaemonServiceAuthorityPath({ happyHomeDir: home, publicReleaseRing: 'stable' });
        const retained = createAgentSessionRunnerFactoryBinding({ v: 1, pluginId: 'happier.agent.claude',
            pluginVersion: '1.0.0', agentId: 'claude', localAgentId: 'claude',
            sourceCustody: { kind: 'bundled_first_party', packagedRuntime: { kind: 'cli_version_root', versionRootId: '1.2.3' } },
            locator: { module: './agent.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
            normalizedModulePath: 'agent.mjs', loadMode: 'immutable-js' });
        let registered!: (session: TrackedSession) => void;
        const registration = new Promise<TrackedSession>(resolve => { registered = resolve; });
        const callbacks = createSpawnLifecycleCallbacks({
            catalogAgentId: 'claude', connectedServicesBindingsRaw: null, materializationKey: 'wrapped-startup',
            hasConnectedServiceAuth: () => false, getSpawnResourceCleanupOnExit: () => null,
            onSpawnResourceCleanupArmed() {}, spawnResourceCleanupByKey: new Map(),
            getSessionAttachCleanup: () => null, setSessionAttachCleanup() {}, sessionAttachCleanupByKey: new Map(),
            onTrackedSessionRegistered: () => {
                const session = trackedSessionForSingleSessionProcess(tracked, os.wrapperPid)!;
                session.agentRuntimeDaemonServiceAuthorityFilePath = authorityPath;
                session.runnerAgentBootstrapIdentity = { agentId: 'claude', backendId: 'claude' };
                registered(session);
            },
            persistAcceptedSpawnMarker: async session => await persistAcceptedSpawnMarker({ trackedSession: session, deviceLocalSecretStorage }),
        });
        const spawnOptions = { directory: home, spawnNonce: 'wrapped-startup',
            ...(refreshKind === 'pre-created Team' ? { existingSessionId: 'canonical-wrapped-session',
                teamCredentialBindings: [{ v: 1 as const, slot: { kind: 'provider_model' as const },
                    teamId: 'team-fixture', resourceId: 'resource-fixture', expectedResourceRevision: 1,
                    deliveryMode: 'brokered' as const }] } : {}) };
        const pending = spawnRegularProcessAndWaitForWebhook({
            directory: home, args: ['claude'], options: spawnOptions,
            trackedSpawnOptions: spawnOptions,
            normalizedExistingSessionId: spawnOptions.existingSessionId ?? '', effectiveResume: '', directoryCreated: false,
            extraEnvForChildWithMessage: {}, processEnv: {},
            runnerLaunchOptions: { runtimeDecision: { runtime: 'node', argvPrefix: ['/fixture/runtime/versions/1.2.3/bin/happier'] } },
            trackedSessionsByKey: tracked, spawnAwaiterByKey: awaiters,
            spawnResultResolverByKey: new Map(), spawnWebhookTimeoutByKey: new Map(),
            resolveCanonicalTrackedSessionId: trackingKey => tracked.get(trackingKey)?.happySessionId ?? '',
            onChildExited() {}, spawnLifecycleCallbacks: callbacks, cleanupSpawnResources() {}, logDebug() {}, warn() {},
        });
        const session = await registration;
        await session.acceptedSpawnMarkerGate;
        const refresh = async () => await refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority({
            happyHomeDir: home, publicReleaseRing: 'stable', httpPort: 4321, sessionId: 'canonical-wrapped-session',
            tracked: session, resolveCurrentRetainedAgent: async () => retained,
        });
        const followUpErrors: unknown[] = [];
        const readinessErrors: unknown[] = [];
        let releaseFollowUp!: () => void;
        const followUp = new Promise<void>(resolve => { releaseFollowUp = resolve; });
        const readiness = createSessionStartupReadinessHandler({
            onHappySessionWebhook: createOnHappySessionWebhook({ trackedSessionsByKey: tracked, spawnAwaiterByKey: awaiters,
                deviceLocalSecretStorage, getParentPidFn: async () => os.wrapperPid, readCredentialsFn: async () => null }),
            reconcileCanonicalReadiness: async () => { await refresh(); },
            reconcileFollowUp: async () => { await followUp; }, onFollowUpError: error => followUpErrors.push(error),
        });
        const app = createDaemonControlApp({ getChildren: () => [...tracked.values()], machineId: 'machine-fixture',
            spawnSession: async () => { throw new Error('unexpected second spawn'); },
            stopSession: async () => ({ status: 'not_found' }), requestShutdown() {}, controlToken: 'fixture-token',
            onHappySessionWebhook: async (...args) => {
                try { await readiness(...args); }
                catch (error) { readinessErrors.push(error); throw error; }
            },
        });
        try {
            await app.ready();
            const report = () => app.inject({ method: 'POST', url: '/session-started',
                headers: { 'x-happier-daemon-token': 'fixture-token' }, payload: {
                    sessionId: 'canonical-wrapped-session',
                    metadata: createTestMetadata({ hostPid: os.runnerPid, startedBy: 'daemon', happyHomeDir: configuration.happyHomeDir }),
                } });
            const response = await report();
            expect(response.statusCode, `${response.body}: ${readinessErrors.map(String).join('; ')}`).toBe(200);
            await expect(pending).resolves.toMatchObject({ type: 'success', sessionId: 'canonical-wrapped-session' });
            expect(session.runnerProcessIdentity).toMatchObject({ pid: os.runnerPid, processStartTimeMs: os.runnerStart });
            expect(session.processStartTimeMs).toBe(os.wrapperStart);
            await expect(readAgentRuntimeDaemonServiceAuthority({ happyHomeDir: home, publicReleaseRing: 'stable',
                path: authorityPath, sessionId: 'canonical-wrapped-session', runner: {
                    pid: os.runnerPid, processStartTimeMs: os.runnerStart,
                    processCommandHash: hashProcessCommand((await readProcessIdentityByPid(os.runnerPid))!.command),
                    snapshotIdentity: 'version:1.2.3',
                }, retainedAgent: retained })).resolves.toMatchObject({
                    sessionId: 'canonical-wrapped-session', runner: { pid: os.runnerPid, processStartTimeMs: os.runnerStart },
                });
            expect((await listSessionMarkers()).find(marker => marker.pid === os.runnerPid)).toMatchObject({
                happySessionId: 'canonical-wrapped-session', processStartTimeMs: os.runnerStart,
            });
            os.reused = true;
            await expect(refresh()).rejects.toThrow('process identity changed');
            os.reused = false;
            if (refreshKind === 'duplicate report') {
                expect((await report()).statusCode).toBe(200);
            } else {
                await persistAcceptedSpawnMarker({ trackedSession: session, deviceLocalSecretStorage });
            }
            // Runner marker refresh must preserve the launcher's stop/exit witness.
            expect(session.processStartTimeMs).toBe(os.wrapperStart);
            expect(session.processCommandHash).toBe(hashProcessCommand((await readProcessIdentityByPid(os.wrapperPid))!.command));
            expect(followUpErrors).toEqual([]);
        } finally {
            releaseFollowUp();
            const current = tracked.get(session.trackingKey);
            if (current?.childProcess instanceof ChildProcess) current.childProcess.emit('exit', 0, null);
            await pending;
            await app.close();
            await rm(home, { recursive: true, force: true });
        }
    });
});
