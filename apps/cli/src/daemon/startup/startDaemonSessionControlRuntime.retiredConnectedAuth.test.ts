import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';

import { configuration, reloadConfiguration } from '@/configuration';
import type { ApiMachineClient } from '@/api/apiMachine';
import type { StoredCredentials } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { logger } from '@/ui/logger';
import { AgentRuntimeDaemonServiceRequestV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { createDaemonSessionMutationCustody } from '../connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import { startDaemonControlServer } from '../controlServer';
import type { TrackedSession } from '../types';
import { commitConnectedServiceHotApplyRuntimeTarget, startDaemonSessionControlRuntime } from './startDaemonSessionControlRuntime';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

// Replace only the loopback HTTP listener; startup and generation owners stay real.
vi.mock('@/daemon/controlServer', () => ({
    startDaemonControlServer: vi.fn(async () => ({ port: 44321, stop: async () => {} })),
}));

const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
afterEach(() => {
    envScope.restore();
    reloadConfiguration();
    vi.restoreAllMocks();
});

it.each(['settlement', 'replacement', 'unbind'] as const)('commits group hot apply only for its own %s recipient', async (change) => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const bindings = { v: 2 as const, bindingsByServiceId: {
        'happier.agent.codex/openai-codex': { source: 'connected' as const, selection: 'group' as const, groupId: 'pool', profileId: 'member' },
    } };
    const targetInput = { pid: 501, sessionId: 'group-applying', agentId: 'codex', connectedServicesBindingsRaw: bindings };
    registry.registerTarget(targetInput);
    const recipient = registry.getByPid(501)!;
    const applying = registry.withdrawSessionGroupApplicationBindings(recipient)!;
    if (change === 'replacement') {
        registry.unregisterPid(501);
        registry.registerTarget(targetInput);
    } else if (change === 'unbind') {
        registry.updateTarget({ pid: 501, sessionId: 'unbound' });
    }
    const beforeCommit = registry.getByPid(501);
    const commit = commitConnectedServiceHotApplyRuntimeTarget({
        tracked: { trackingKey: legacyPidSessionTrackingKey(501), pid: 501, happySessionId: 'group-applying', startedBy: 'daemon' },
        groupApplicationTarget: applying, agentId: 'codex', registry,
        materializationIdentity: { v: 1, id: 'csm_group_apply', createdAt: 111 },
        acceptedConnectedServicesBindingsRaw: bindings, acceptedConnectedServiceSelectionsEnv: {},
    });
    if (change === 'settlement') {
        await commit;
        expect(registry.resolveExactSessionGroupApplicationTarget(recipient)).toBe(registry.getByPid(501));
        expect(registry.getByPid(501)?.connectedServicesBindingsRaw).toEqual(bindings);
    } else {
        await expect(commit).rejects.toThrow('credential_revision_superseded');
        expect(registry.resolveExactSessionGroupApplicationTarget(recipient)).toBeNull();
        expect(registry.getByPid(501)).toBe(beforeCommit);
    }
});

it.each(['retained', 'removed'] as const)('skips connected credential reconciliation after runner exit leaves %s tracking custody', async (tracking) => {
    const home = await mkdtemp(join(tmpdir(), 'happier-retired-connected-auth-'));
    envScope.patch({ HAPPIER_HOME_DIR: home });
    reloadConfiguration();
    const registry = new ConnectedServiceRuntimeRegistry();
    const retiredPid = 2147482901;
    const activePid = 2147482902;
    const retiredSessionId = 'session-retired-connected-auth';
    const activeSessionId = 'session-active-connected-auth';
    const metadata = createTestMetadata({ hostPid: retiredPid, startedBy: 'daemon', happyHomeDir: home });
    const retired: TrackedSession = {
        trackingKey: legacyPidSessionTrackingKey(retiredPid), pid: retiredPid, startedBy: 'daemon', happySessionId: retiredSessionId,
        happySessionMetadataFromLocalWebhook: metadata,
        // The exit owner marks this before disposing the Session purpose lease,
        // while durable exit settlement may still retain the tracked entry.
        reportMarkerCustody: { pending: Promise.resolve(), retiring: true },
    };
    const active: TrackedSession = {
        trackingKey: legacyPidSessionTrackingKey(activePid), pid: activePid, startedBy: 'daemon', happySessionId: activeSessionId,
        happySessionMetadataFromLocalWebhook: { ...metadata, hostPid: activePid },
    };
    const trackedSessions = new Map([[legacyPidSessionTrackingKey(retiredPid), retired], [legacyPidSessionTrackingKey(activePid), active]]);
    const credentials = { token: 'fixture-daemon', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } } satisfies StoredCredentials;
    const mutationCustody = createDaemonSessionMutationCustody({ credentials });
    // The machine transport is a network boundary. Its terminal receipt lets
    // real exit staging finish instead of retaining an unconfirmed publisher.
    const machine = {
        captureMachineSessionTerminal: async (sessionId: string) => ({ v: 1, status: 'already_inactive', sessionId }),
        enqueueDaemonTerminalExactTurnEnd: async () => undefined,
    } as unknown as ApiMachineClient;
    let reportingExit = false;
    const runtime = await startDaemonSessionControlRuntime({
        machineId: 'machine-retired-connected-auth', serverId: configuration.activeServerId,
        serverBaseUrl: configuration.apiServerUrl,
        credentials, daemonSessionMutationCustody: mutationCustody,
        api: {} as never,
        connectedServiceRuntimeRegistry: registry,
        connectedServicesMaterializationBaseDir: join(home, 'connected-services'),
        getConnectedServiceRefreshCoordinator: () => null, getConnectedServiceQuotasCoordinator: () => null,
        trackedSessionsByKey: trackedSessions, spawnAwaiterByKey: new Map(), spawnResultResolverByKey: new Map(),
        spawnWebhookTimeoutByKey: new Map(), getApiMachineForSessions: () => reportingExit ? machine : null,
        spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(),
        connectedServicesRestartRequestedSessions: new Set(),
        startupTerminalRecovery: { disconnectedTerminalHostCandidates: [], unresolvedTerminalHostSessionIds: [] },
        beforeShutdown: async () => {}, onHappySessionWebhook: async () => {}, requestShutdown: () => {}, processEnv: {},
    });
    try {
        // Home HTTP is the true external boundary. An active target reaches it;
        // a retired target must never rematerialize using a disposed purpose lease.
        const accountReads = vi.spyOn(axios, 'get').mockRejectedValue(new Error('fixture Home unavailable'));
        const diagnostics = vi.spyOn(logger, 'debug');
        await expect(runtime.connectedServiceAuthGroupPreTurnSwitchCoordinator.applyCredentialUpdate({
            sessionId: activeSessionId, serviceId: 'happier.agent.codex/openai-codex', profileId: 'unrelated',
            reason: 'account_changed', executionAuthority: 'runtime_recovery',
        })).resolves.toEqual({ status: 'unchanged' });
        expect(accountReads).not.toHaveBeenCalled();
        active.spawnOptions = { directory: home, connectedServices: { v: 2, bindingsByServiceId: {
            'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'selected' },
        } } };
        await expect(runtime.connectedServiceAuthGroupPreTurnSwitchCoordinator.applyCredentialUpdate({
            sessionId: activeSessionId, serviceId: 'happier.agent.codex/openai-codex', profileId: 'other-member',
            reason: 'account_changed', executionAuthority: 'runtime_recovery',
        })).resolves.toEqual({ status: 'unchanged' });
        expect(accountReads).not.toHaveBeenCalled();
        delete active.spawnOptions;
        const register = (pid: number, sessionId: string) => registry.registerTarget({
            pid, sessionId, agentId: 'claude', materializationKey: 'csm_' + sessionId,
            connectedServicesBindingsRaw: {
                v: 2, bindingsByServiceId: {
                    'happier.agent.claude/claude-subscription': {
                        source: 'connected', selection: 'profile', profileId: 'subscription',
                    },
                },
            },
        });
        register(retiredPid, retiredSessionId);
        if (tracking === 'removed') trackedSessions.delete(legacyPidSessionTrackingKey(retiredPid));
        const control = vi.mocked(startDaemonControlServer).mock.calls.at(-1)?.[0];
        const mcpClosed = await control!.agentRuntimeDaemonServices!.dispatch(AgentRuntimeDaemonServiceRequestV1Schema.parse({
            v: 1,
            context: { token: 'a'.repeat(43), sessionId: activeSessionId },
            operation: { kind: 'mcp.request_auth.close', requestId: 'close-mcp', materializationId: 'retired-mcp' },
        }), {
            sessionId: activeSessionId, trackedSession: active,
            retainedAgent: { pluginId: 'happier.agent.claude' },
        } as Parameters<NonNullable<NonNullable<typeof control>['agentRuntimeDaemonServices']>['dispatch']>[1]);
        expect(mcpClosed).toEqual({ ok: true, result: { kind: 'mcp.request_auth.closed' } });
        await control!.onHappySessionWebhook(retiredSessionId, metadata);
        // Enqueue the active target after the asynchronous follow-up. Its terminal
        // diagnostic proves the same reconciliation queue drained the earlier work.
        await new Promise<void>((resolve) => setImmediate(resolve));
        register(activePid, activeSessionId);
        await vi.waitFor(() => expect(diagnostics.mock.calls.some(([message, detail]) => (
            message === '[DAEMON RUN] Failed to reconcile connected-service group generation after runtime registration'
            && typeof detail === 'object' && detail !== null && Reflect.get(detail, 'pid') === activePid
        ))).toBe(true));
        expect(accountReads).toHaveBeenCalledTimes(1);
        accountReads.mockClear();
        const unrelatedChange = await runtime.reconcileConnectedServicesProjection({
            source: 'changes', executionAuthority: 'passive_projection', signal: new AbortController().signal,
            connectedServiceRefs: [{ pluginId: 'happier.channel.email', localId: 'email-imap-smtp' }],
            connectedServicesV2: [], connectedServiceCredentialRevisionsV1: [],
        }).catch(error => error);
        expect(accountReads, 'an email-only Account change must not reconcile a coding-agent Session').not.toHaveBeenCalled();
        expect(unrelatedChange).toBeUndefined();
        const matchingChange = await runtime.reconcileConnectedServicesProjection({
            source: 'changes', executionAuthority: 'passive_projection', signal: new AbortController().signal,
            connectedServiceRefs: [{ pluginId: 'happier.agent.claude', localId: 'claude-subscription' }],
            connectedServicesV2: [], connectedServiceCredentialRevisionsV1: [],
        }).catch(error => error);
        expect(accountReads.mock.calls.some(([url]) => new URL(String(url)).pathname === `/v2/sessions/${activeSessionId}`),
            'the affected service still performs its fresh Session admission').toBe(true);
        expect(matchingChange).toBeInstanceOf(Error);
        expect(diagnostics.mock.calls.some(([message, detail]) => (
            message === '[DAEMON RUN] Failed to reconcile session startup follow-up'
            && typeof detail === 'object' && detail !== null && Reflect.get(detail, 'sessionId') === retiredSessionId
        ))).toBe(false);
        // Final exit must finish Session cleanup after retiring its connected
        // target, without consulting the removed switch-attempt counter.
        reportingExit = true;
        active.stopRequestedAtMs = Date.now();
        await expect(runtime.onChildExited(activePid, {
            reason: 'process-exited', code: 0, signal: null,
        })).resolves.toBeUndefined();
        expect(trackedSessions.has(legacyPidSessionTrackingKey(activePid))).toBe(false);
        expect(registry.getByPid(activePid)).toBeNull();
    } finally {
        await runtime.stopControlServer();
        await mutationCustody.close();
        await rm(home, { recursive: true, force: true });
    }
});
