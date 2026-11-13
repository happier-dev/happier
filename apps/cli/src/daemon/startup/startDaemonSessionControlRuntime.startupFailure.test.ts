import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { V2SessionByIdResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { afterEach, expect, it, vi } from 'vitest';

import { configuration, reloadConfiguration } from '@/configuration';
import type { StoredCredentials } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { logger } from '@/ui/logger';
import { createDaemonSessionMutationCustody } from '../connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import type { TrackedSession } from '../types';
import { startDaemonSessionControlRuntime } from './startDaemonSessionControlRuntime';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

const launches = vi.hoisted(() => vi.fn(() => { throw new Error('Unexpected OS process launch'); }));
// The listener and OS subprocess launch are external boundaries. Never launch a
// real Agent if the composed respawn preflight regresses.
vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    const blockedLaunches = { spawn: launches, fork: launches, exec: launches, execFile: launches,
        spawnSync: launches, execSync: launches, execFileSync: launches };
    return { ...actual, ...blockedLaunches, default: { ...actual, ...blockedLaunches } };
});
vi.mock('@/daemon/controlServer', () => ({
    startDaemonControlServer: vi.fn(async () => ({ port: 44322, stop: async () => {} })),
}));

const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
afterEach(() => {
    envScope.restore();
    reloadConfiguration();
    vi.restoreAllMocks();
    launches.mockClear();
});

it.each(['custodian', 'foreign-requester'] as const)('checks the retained startup failure under %s Account custody before respawn', async (account) => {
    const home = await mkdtemp(join(tmpdir(), 'happier-startup-failure-'));
    envScope.patch({ HAPPIER_HOME_DIR: home });
    reloadConfiguration();
    const sessionId = 'session-startup-dependency-' + account;
    const pid = 2147482911;
    const tracked: TrackedSession = {
        trackingKey: legacyPidSessionTrackingKey(pid), pid, startedBy: 'daemon', happySessionId: sessionId, processStartTimeMs: 1000,
        spawnOptions: { directory: home, existingSessionId: sessionId },
        happySessionMetadataFromLocalWebhook: createTestMetadata({ hostPid: pid, flavor: 'claude', happyHomeDir: home }),
        ...(account === 'foreign-requester' ? { requesterWorkAttributionV1: {
            accountId: 'foreign-account', serverId: configuration.activeServerId,
            machineId: 'machine-startup-failure', installationId: 'foreign-installation',
        } } : {}),
    };
    const trackedSessions = new Map([[legacyPidSessionTrackingKey(pid), tracked]]);
    const sessionResponse = V2SessionByIdResponseSchema.parse({ session: {
        id: sessionId, seq: 1, createdAt: 1000, updatedAt: 1100, active: false, activeAt: 1000,
        metadata: '', metadataVersion: 0, agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
        latestTurnStatus: 'failed', lastRuntimeIssue: {
            v: 1, scope: 'primary_session', status: 'failed', source: 'dependency_failure',
            code: 'profile_missing', occurredAt: 1100, sanitizedPreview: 'Prompt context could not be prepared.',
        },
    } });
    const homeReads = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
        if (String(url).endsWith('/v2/sessions/' + sessionId)) return { status: 200, data: sessionResponse };
        throw new Error('Unexpected Home read: ' + String(url));
    });
    const diagnostics = vi.spyOn(logger, 'debug');
    const warnings = vi.spyOn(logger, 'warn');
    const credentials = { token: 'fixture-custodian', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } } satisfies StoredCredentials;
    const mutationCustody = createDaemonSessionMutationCustody({ credentials });
    const runtime = await startDaemonSessionControlRuntime({
        machineId: 'machine-startup-failure', serverId: configuration.activeServerId,
        serverBaseUrl: configuration.apiServerUrl, externalActionAccountId: 'custodian-account',
        credentials, daemonSessionMutationCustody: mutationCustody,
        connectedServicesMaterializationBaseDir: join(home, 'connected-services'),
        api: {} as never,
        getConnectedServiceRefreshCoordinator: () => null, getConnectedServiceQuotasCoordinator: () => null,
        trackedSessionsByKey: trackedSessions, spawnAwaiterByKey: new Map(), spawnResultResolverByKey: new Map(),
        spawnWebhookTimeoutByKey: new Map(), getApiMachineForSessions: () => null,
        spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(),
        connectedServicesRestartRequestedSessions: new Set(),
        startupTerminalRecovery: { disconnectedTerminalHostCandidates: [], unresolvedTerminalHostSessionIds: [] },
        beforeShutdown: async () => {}, onHappySessionWebhook: async () => {}, requestShutdown: () => {},
        processEnv: { HAPPIER_DAEMON_SESSION_RESPAWN_BASE_DELAY_MS: '50', HAPPIER_DAEMON_SESSION_RESPAWN_MAX_DELAY_MS: '50',
            HAPPIER_DAEMON_SESSION_RESPAWN_JITTER_MS: '0', HAPPIER_DAEMON_SESSION_RESPAWN_MAX_ATTEMPTS: '1' },
    });
    try {
        launches.mockClear();
        await runtime.onChildExited(pid, { reason: 'process-exited', code: 1, signal: null });
        expect(trackedSessions.has(legacyPidSessionTrackingKey(pid))).toBe(false);
        if (account === 'custodian') {
            await vi.waitFor(() => expect(warnings.mock.calls.some(([message]) => (
                message === `[DAEMON RUN] Respawn suppressed for session ${sessionId} (startup dependency: profile_missing)`
            ))).toBe(true));
            expect(homeReads.mock.calls.some(([url, options]) => (
                String(url).endsWith('/v2/sessions/' + sessionId)
                && options?.headers?.Authorization === 'Bearer fixture-custodian'
            ))).toBe(true);
        } else {
            await vi.waitFor(() => expect(warnings.mock.calls.some(([message]) => (
                String(message).includes(`Session ${sessionId} crashed; respawn suppressed (max_restarts_exceeded`)
            ))).toBe(true));
            expect(diagnostics.mock.calls.some(([message, error]) => (
                message === `[DAEMON RUN] Failed to evaluate respawn preflight for session ${sessionId}`
                && error instanceof Error && error.message === 'requester_session_not_current'
            ))).toBe(true);
            expect(homeReads.mock.calls.some(([url]) => String(url).includes('/sessions/'))).toBe(false);
        }
        expect(launches).not.toHaveBeenCalled();
    } finally {
        await runtime.stopControlServer();
        await mutationCustody.close();
        await rm(home, { recursive: true, force: true });
    }
});
