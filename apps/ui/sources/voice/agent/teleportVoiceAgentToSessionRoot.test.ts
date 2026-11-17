import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SessionResumeRequestV1Schema } from '@happier-dev/protocol/sessions/control/sessionResumeRequestV1';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/control/contract';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createHydratedPlainMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import {
  createRetainedVoiceAgentRpcBoundary,
  createStandaloneVoicePolicyHarness,
  prepareStandaloneVoicePolicyHarness,
} from '@/dev/testkit/harness/standaloneVoicePolicyHarness';

await prepareStandaloneVoicePolicyHarness();
const { storage } = await import('@/sync/domains/state/storage');
const { readLocalConversationVoiceSettings, writeVoiceProviderSettingsConfig } = await import('@/sync/domains/settings/voiceSettings');
const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
const { writeVoiceConversationScopeMetadata } = await import('@/voice/persistence/voiceConversationScopeMetadata');
const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
const { readVoiceConversationBindingMetadata } = await import('@/voice/binding/voiceConversationBindingMetadata');
const { readVoiceSessionOwnerMetadataFromState } = await import('@/voice/shared/readVoiceSessionOwnerMetadata');
const { VOICE_AGENT_GLOBAL_SESSION_ID } = await import('./voiceAgentGlobalSessionId');
const { teleportVoiceAgentToSessionRoot } = await import('./teleportVoiceAgentToSessionRoot');
const { flushActivityUpdates } = await import('@/sync/engine/socket/socket');

describe('teleportVoiceAgentToSessionRoot', () => {
  let harness: Awaited<ReturnType<typeof createStandaloneVoicePolicyHarness>>;
  let active: Awaited<ReturnType<typeof harness.activateLocalAgent>>;
  let daemon: Awaited<ReturnType<typeof createRetainedVoiceAgentRpcBoundary>>;
  let bindingAtStop: ReturnType<typeof readVoiceConversationBindingMetadata>;
  let unsubscribeActivity: (() => void) | undefined;

  function setTeleportPolicy(policy: Readonly<{ teleportEnabled?: boolean; stayInVoiceHome?: boolean }>) {
    const voice = storage.getState().settings.voice;
    const config = readLocalConversationVoiceSettings(voice);
    storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice: writeVoiceProviderSettingsConfig(voice, 'local_conversation', {
      ...config, conversationMode: 'agent', agent: { ...config.agent, teleportEnabled: true, stayInVoiceHome: false, ...policy },
    }) }, storage.getState().settings));
  }

  beforeEach(async () => {
    bindingAtStop = null;
    const machineRow = createPlainMachineRowFixture({ id: 'machine-1', accountId: 'account-a' });
    // A live daemon independently publishes activity; durable HTTP rows alone
    // do not prove either the old Voice Home or the requested root is online.
    unsubscribeActivity = storage.subscribe(current => {
      const serverId = current.profileScope?.serverId;
      if (!serverId) return;
      const updates = new Map(['global-carrier', 's1'].flatMap(id => {
        const session = current.sessions[id];
        const row = current.sessionListRowsByServerId[serverId]?.[id];
        if (session?.active !== true || (session.presence === 'online' && (!row || row.presence === 'online'))) return [];
        const activeAt = Math.max(Date.now(), (session.activeAt ?? 0) + 1, (row?.activeAt ?? 0) + 1);
        return [[id, { type: 'activity' as const, id, active: true, activeAt, thinking: false }] as const];
      }));
      if (updates.size) flushActivityUpdates({ updates, applySessions: current.applySessions, sourceServerId: serverId });
    });
    daemon = await createRetainedVoiceAgentRpcBoundary({ onRpc: method => {
      if (method !== SESSION_RPC_METHODS.EXECUTION_RUN_STOP) return;
      // Observe the persisted binding at the actual daemon stop boundary.
      // Stopping first, or merely forwarding the target, cannot satisfy this.
      bindingAtStop = readVoiceConversationBindingMetadata('carrier-1',
        readVoiceSessionOwnerMetadataFromState(storage.getState(), 'carrier-1'),
        { sourceServerId: active.binding.conversationSessionAddress.serverId });
    }, handleOtherRpc: async (method, input) => {
      if (method === RPC_METHODS.SPAWN_HAPPY_SESSION || method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE) {
        const request = SessionResumeRequestV1Schema.parse(input);
        expect(request.sessionId).toBe('carrier-1');
        return { type: 'success', sessionId: request.sessionId };
      }
      throw new Error(`Unexpected Voice teleport RPC: ${method}`);
    } });
    harness = await createStandaloneVoicePolicyHarness({ mode: 'off', dispatch: daemon.dispatch,
      handleRequest: async (path, init) => {
        const pathname = new URL(path, 'https://voice.test').pathname;
        if (pathname === '/v1/machines') return Response.json([machineRow]);
        if (pathname === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
          id => id === machineRow.id ? machineRow : null);
        if (pathname === '/v1/machines/machine-1') return Response.json({ machine: machineRow });
        return null;
      },
      initializeSessionId: 'global-carrier',
      existingSession: { id: 'global-carrier', active: true,
        metadata: writeVoiceConversationScopeMetadata({ path: '/voice', host: 'voice.test', machineId: 'machine-1',
          flavor: 'claude', ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }),
          permissionMode: 'read-only' as const, connectedServices: { v: 2, bindingsByServiceId: {} },
          agentRuntimeCapabilitiesV1: { localControl: { supported: true } },
        }, { kind: 'voice_home' }) },
      sessions: [
        createSessionFixture({ id: 's1', active: true,
          metadata: { path: '/repo', host: 'voice.test', machineId: 'machine-1', flavor: 'claude' } }),
        createSessionFixture({ id: 'carrier-1', active: true,
          metadata: writeVoiceConversationScopeMetadata({ path: '/repo', host: 'voice.test', machineId: 'machine-1',
            flavor: 'claude', ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }),
            permissionMode: 'read-only' as const, connectedServices: { v: 2, bindingsByServiceId: {} },
          }, { kind: 'session_root', sessionRootId: 's1' }) }),
      ],
    });
    active = await harness.activateLocalAgent();
    const machine = createHydratedPlainMachineFixture({ id: 'machine-1', accountId: 'account-a',
      machine: { activeAt: Date.now(), access: machineRow.access } });
    await publishMachineInventoryForTest({ serverId: active.binding.conversationSessionAddress.serverId,
      accountId: 'account-a' }, [machine]);
    setTeleportPolicy({});
    daemon.requests.length = 0;
  });

  afterEach(async () => {
    unsubscribeActivity?.();
    await active?.dispose();
    await harness?.dispose();
  });

  it('rebinds the global voice agent to the requested session root before stopping the global run', async () => {
    await expect(teleportVoiceAgentToSessionRoot({ sessionId: 's1' })).resolves.toEqual({ ok: true });
    const target = { serverId: active.binding.conversationSessionAddress.serverId, sessionId: 's1' };
    expect(voiceSessionBindingStore.getState().getByControlSessionId(VOICE_AGENT_GLOBAL_SESSION_ID))
      .toMatchObject({ conversationSessionId: 'carrier-1', targetSessionAddress: target });
    expect(bindingAtStop).toMatchObject({ controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'carrier-1', targetSessionAddress: target });
    expect(daemon.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP))
      .toEqual([{ method: SESSION_RPC_METHODS.EXECUTION_RUN_STOP, input: { runId: 'local-agent-run' } }]);
    expect(daemon.readRetainedRun()).toBeNull();
  });

  it('fails closed when teleport is disabled', async () => {
    setTeleportPolicy({ teleportEnabled: false });
    await expect(teleportVoiceAgentToSessionRoot({ sessionId: 's1' }))
      .resolves.toEqual({ ok: false, code: 'VOICE_TELEPORT_DISABLED' });
    expect(daemon.requests).toEqual([]);
    expect(voiceSessionBindingStore.getState().getByControlSessionId(VOICE_AGENT_GLOBAL_SESSION_ID)?.targetSessionAddress).toBeNull();
    expect(daemon.readRetainedRun()?.status).toBe('running');
  });

  it('fails closed when stayInVoiceHome is enabled', async () => {
    setTeleportPolicy({ stayInVoiceHome: true });
    await expect(teleportVoiceAgentToSessionRoot({ sessionId: 's1' }))
      .resolves.toEqual({ ok: false, code: 'VOICE_TELEPORT_BLOCKED_BY_HOME' });
    expect(daemon.requests).toEqual([]);
    expect(voiceSessionBindingStore.getState().getByControlSessionId(VOICE_AGENT_GLOBAL_SESSION_ID)?.targetSessionAddress).toBeNull();
    expect(daemon.readRetainedRun()?.status).toBe('running');
  });
});
