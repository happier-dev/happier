import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';

import { configuration, reloadConfiguration } from '@/configuration';
import type { StoredCredentials } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { logger } from '@/ui/logger';
import type { TrackedSession } from '../types';
import { resolveRequesterSessionBootstrapFromCustody } from '../sessionEncryption/requesterSessionCredentials';
import { createStopSession } from '../sessions/stopSession';
import { waitForTrackedRunnerProcessesExit } from '../sessions/waitForTrackedRunnerProcessesExit';
import { startDaemonSessionControlRuntime } from './startDaemonSessionControlRuntime';
import { createDaemonSessionMutationCustody } from '../connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import { legacyPidSessionTrackingKey, type SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

// Only the private listener and Home HTTP are substituted. Root discovery,
// requester custody recovery, census, remainder and Stop stay real.
vi.mock('@/daemon/controlServer', () => ({
    startDaemonControlServer: async () => ({ port: 44322, stop: async () => {} }),
}));

const env = createEnvKeyScope(['HAPPIER_HOME_DIR']);
afterEach(() => { env.restore(); reloadConfiguration(); vi.restoreAllMocks(); });

it('settles a physically exited Stop without recovering unrelated requesters or joining their pending fresh read', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-remainder-custody-'));
    env.patch({ HAPPIER_HOME_DIR: home });
    reloadConfiguration();
    const sessions = new Map<SessionTrackingKey, TrackedSession>();
    const credentials = { token: 'fixture-owner', encryption: null } satisfies StoredCredentials;
    const daemonSessionMutationCustody = createDaemonSessionMutationCustody({ credentials });
    let releaseHome!: () => void;
    const homePending = new Promise<void>(resolve => { releaseHome = resolve; });
    const requests: string[] = [];
    const requesterSessionIds: string[] = [];
    let blockHome = false;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (!blockHome) throw new Error('Fixture Home unavailable during startup');
        requests.push(String(url));
        await homePending;
        throw new Error('Home storage unavailable');
    });
    const runtime = await startDaemonSessionControlRuntime({
        machineId: 'machine', serverId: configuration.activeServerId,
        serverBaseUrl: configuration.apiServerUrl, externalActionAccountId: 'owner', credentials, api: {} as never,
        daemonSessionMutationCustody,
        connectedServicesMaterializationBaseDir: join(home, 'connected-services'),
        getConnectedServiceRefreshCoordinator: () => null, getConnectedServiceQuotasCoordinator: () => null,
        trackedSessionsByKey: sessions, spawnAwaiterByKey: new Map(), spawnResultResolverByKey: new Map(),
        spawnWebhookTimeoutByKey: new Map(), getApiMachineForSessions: () => null,
        spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(),
        connectedServicesRestartRequestedSessions: new Set(),
        startupTerminalRecovery: { disconnectedTerminalHostCandidates: [], unresolvedTerminalHostSessionIds: [] },
        beforeShutdown: async () => {}, onHappySessionWebhook: async () => {}, requestShutdown: () => {},
        resolveRequesterSessionRuntimeContext: async sessionId => {
            requesterSessionIds.push(sessionId);
            // Exercise the same cold legacy-custody owner used by startDaemon.
            // The HTTP boundary fails before a runtime can be constructed.
            const bootstrap = await resolveRequesterSessionBootstrapFromCustody({
                happyHomeDir: home, sessionId, serverId: configuration.activeServerId,
                serverHttpBaseUrl: configuration.apiServerUrl, legacyOwnerCredentials: credentials,
                machineAdmissionBoundary: { machineId: 'machine', daemonToken: credentials.token,
                    isHomeCurrent: () => true,
                    readInstallation: () => ({ installationId: 'installation', privateKey: new Uint8Array(64) }) },
            });
            if (bootstrap) throw new Error('Unavailable Home unexpectedly admitted requester custody');
            return null;
        },
        releaseRequesterSessionRuntimeContext: async context => { await context.dispose(); },
        processEnv: { HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED: '0' },
    });
    // Exact absent generations are retained lifecycle facts, not running fixtures.
    for (let index = 0; index < 64; index++) {
        const pid = 2147482000 + index;
        sessions.set(legacyPidSessionTrackingKey(pid), { trackingKey: legacyPidSessionTrackingKey(pid), pid, happySessionId: `unrelated-${index}`, startedBy: 'daemon', processStartTimeMs: 1000 });
    }
    const pid = 2147482911;
    const sessionId = 'already-exited';
    sessions.set(legacyPidSessionTrackingKey(pid), { trackingKey: legacyPidSessionTrackingKey(pid), pid, happySessionId: sessionId, startedBy: 'daemon', processStartTimeMs: 1000 });
    const provisionalPid = 2147482912;
    sessions.set(legacyPidSessionTrackingKey(provisionalPid), {
        trackingKey: legacyPidSessionTrackingKey(provisionalPid),
        pid: provisionalPid,
        happySessionId: `PID-${provisionalPid}`,
        startedBy: 'daemon',
        processStartTimeMs: 1000,
    });
    await runtime.sessionLiveWorkProducer.read();
    await runtime.flushProviderAccountUsagePersistence(0);
    expect(requesterSessionIds).not.toContain(`PID-${provisionalPid}`);
    requesterSessionIds.length = 0;
    const expectedRequesterRecoveries = sessions.size - 1;
    blockHome = true;
    const read = runtime.processOwnershipRuntime.readOwners({ freshness: 'fresh' });
    const physicallyExited = async ({ trackedPids }: Readonly<{ trackedPids: readonly number[] }>) =>
        await waitForTrackedRunnerProcessesExit({ runners: trackedPids.map(pid => ({ pid })), timeoutMs: 0, pollIntervalMs: 0 });
    const stop = createStopSession({ trackedSessionsByKey: sessions, ownerRemainder: runtime.ownerRemainder,
        areTrackedRunnersExited: physicallyExited, waitForTrackedRunnersExit: physicallyExited });
    let stopping: ReturnType<typeof stop> | undefined;
    try {
        await vi.waitFor(() => expect(requests).toHaveLength(expectedRequesterRecoveries), { timeout: 10000 });
        let receipt: Awaited<ReturnType<typeof stop>> | undefined;
        // Observe the file-log boundary without replacing its implementation.
        const phases = vi.spyOn(logger, 'debug');
        const stopStartedAtMs = Date.now();
        let stopElapsedMs: number | undefined;
        stopping = stop(sessionId).then(result => { receipt = result; stopElapsedMs = Date.now() - stopStartedAtMs; return result; });
        await vi.waitFor(() => expect(receipt).toEqual({ status: 'stopped' }), { timeout: 10000 });
        // Work is bounded by native observation: no requester recovery per owner,
        // even though the independent attribution read remains blocked at Home.
        expect(requests).toHaveLength(expectedRequesterRecoveries);
        expect(requests.every(url => url.endsWith('/v1/account/profile'))).toBe(true);
        console.info('[owner-remainder] Stop while Home is blocked', { elapsedMs: stopElapsedMs,
            pendingRequesterReads: requests.length,
            phases: phases.mock.calls.flatMap(([message, detail]) =>
                message === '[process-ownership] Observation phase settled' || message === '[process-ownership] Root source settled'
                    ? [detail] : []),
        });
    } finally {
        releaseHome();
        await Promise.allSettled([read, ...(stopping ? [stopping] : [])]);
        sessions.clear();
        await runtime.stopControlServer();
        await daemonSessionMutationCustody.close();
        await rm(home, { recursive: true, force: true });
    }
});
