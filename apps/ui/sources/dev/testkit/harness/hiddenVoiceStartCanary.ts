import { expect, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { restoreServerAccountForTest } from './serverAccountConnectionHarness';

/** Consumes the real composed Home/daemon fixture. It creates no Session,
 * transcript, Run, catalog or native response on the fixture's behalf. */
export async function createHiddenVoiceStartCanary(params: Readonly<{
    serverUrl: string;
    serverIdentityId: string;
    accountId: string;
    credentials: AuthCredentials;
    machineId: string;
    agentIdentity: PluginContributionIdentityV1;
    request: NonNullable<Parameters<typeof restoreServerAccountForTest>[0]['request']>;
}>) {
    const connection = await restoreServerAccountForTest({
        serverUrl: params.serverUrl, serverIdentityId: params.serverIdentityId,
        accountId: params.accountId, credentials: params.credentials, request: params.request,
    });
    try {
        const { storage } = await import('@/sync/domains/state/storage');
        const { sync } = await import('@/sync/sync');
        const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
        const { readLocalConversationVoiceSettings, writeVoiceProviderSettingsConfig } = await import('@/sync/domains/settings/voiceSettings');
        const { initializeVoiceAgentHandle } = await import('@/voice/agent/initializeVoiceAgentHandle');
        const { DaemonVoiceAgentClient } = await import('@/voice/agent/daemonVoiceAgentClient');
        const { VOICE_AGENT_GLOBAL_SESSION_ID } = await import('@/voice/agent/voiceAgentGlobalSessionId');
        const { sessionExecutionRunGet } = await import('@/sync/ops/sessionExecutionRuns');
        const { isVoiceConversationSystemSessionMetadata } = await import('@/voice/persistence/voiceConversationSystemSessionLookup');
        const { readVoiceSessionOwnerMetadataFromState } = await import('@/voice/shared/readVoiceSessionOwnerMetadata');
        const { readPersistedVoiceConversationRuntimePublication } = await import('@/voice/binding/voiceConversationBindingPersistence');
        await sync.refreshMachines();
        await sync.refreshSessions({ awaitSessionListHydration: true });
        await vi.waitFor(() => expect(storage.getState().isDataReady).toBe(true));
        const before = storage.getState();
        expect(Object.values(before.sessions).filter(session => isVoiceConversationSystemSessionMetadata(
            readVoiceSessionOwnerMetadataFromState(before, session.id),
        ))).toEqual([]);
        const local = readLocalConversationVoiceSettings(before.settings.voice);
        const target = { kind: 'agent' as const, identity: params.agentIdentity };
        const voice = writeVoiceProviderSettingsConfig({ ...before.settings.voice,
            providerId: 'local_conversation', welcome: { ...before.settings.voice.welcome, enabled: false },
            executionMachine: { mode: 'fixed', machineId: params.machineId },
        }, 'local_conversation', { ...local, conversationMode: 'agent',
            agent: { ...local.agent, agentSource: 'agent',
                agentId: `${params.agentIdentity.pluginId}/agents/${params.agentIdentity.localId}`,
                agentIdentity: params.agentIdentity, agentTargetKey: buildBackendTargetKeyV2(target),
                prewarmOnConnect: false, resumabilityMode: 'provider_resume',
                providerResume: { ...local.agent.providerResume, fallbackToReplay: false },
                transcript: { ...local.agent.transcript, persistenceMode: 'persistent' },
            },
        });
        // These are the person's authored preferences. Account restoration,
        // selection, hidden birth and input admission remain production-owned.
        storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({
            experiments: true, featureToggles: { ...before.settings.featureToggles,
                voice: true, 'voice.agent': true, 'execution.runs': true }, voice,
        }, before.settings));
        const initialize = () => initializeVoiceAgentHandle({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            getDaemonVoiceAgentClient: scope => new DaemonVoiceAgentClient(scope),
            setDeferredTargetSessionContext: () => {},
        });
        let handle = await initialize();
        const carrierSessionId = handle.rpcSessionId;
        const firstRunId = handle.voiceAgentId;
        const readRun = () => sessionExecutionRunGet(handle.rpcSessionId,
            { runId: handle.voiceAgentId, includeStructured: false }, { scope: handle.accountLifetime.scope });
        const send = (userText: string) => handle.client.sendTurn({ sessionId: handle.rpcSessionId,
            voiceAgentId: handle.voiceAgentId, userText });
        const readNativeResumeSupport = () => readPersistedVoiceConversationRuntimePublication({
            managedSessionId: VOICE_AGENT_GLOBAL_SESSION_ID, conversationSessionId: carrierSessionId,
        })?.facets?.transcriptSource?.supported === true;
        return {
            carrierSessionId, firstRunId, readRun, send, readNativeResumeSupport,
            async resume() {
                if (!readNativeResumeSupport()) throw Object.assign(new Error('The native fixture has no transcript-source contribution'), {
                    code: 'VOICE_CANARY_NATIVE_TRANSCRIPT_SOURCE_FIXTURE_UNAVAILABLE',
                });
                const prior = await readRun();
                if (!('run' in prior) || !prior.run.resumeHandle) throw new Error('Voice native resume handle was not published');
                await handle.client.stop({ sessionId: handle.rpcSessionId, voiceAgentId: handle.voiceAgentId });
                handle = await initialize();
                expect(handle.rpcSessionId).toBe(carrierSessionId);
                const after = await readRun();
                expect(after).toHaveProperty('run.resumeHandle', prior.run.resumeHandle);
                return { before: prior, after, runId: handle.voiceAgentId };
            },
            async dispose() {
                try { await handle.client.stop({ sessionId: handle.rpcSessionId, voiceAgentId: handle.voiceAgentId }); }
                finally { await connection.dispose(); }
            },
        };
    } catch (error) {
        await connection.dispose();
        throw error;
    }
}
