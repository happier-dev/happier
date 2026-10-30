import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

import { renderScreen, standardCleanup, waitForTestEvent } from '@/dev/testkit';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { Modal } from '@/modal';

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
import { createVoiceSettingsAccountTestHarness } from './voiceSettingsAccountTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { readPersistentVoiceTranscriptEpoch } from '@/voice/persistence/voiceTranscriptMemory';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import {
  readLocalConversationVoiceSettings,
  voiceSettingsDefaults,
  writeLocalConversationVoiceSettings,
  type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';

const initialStorage = storage.getState();
let account: Awaited<ReturnType<typeof createVoiceSettingsAccountTestHarness>>;
beforeEach(async () => {
  vi.mocked(Modal.confirm).mockReset().mockResolvedValue(true);
  account = await createVoiceSettingsAccountTestHarness(settingsParse({
    experiments: true, featureToggles: { 'voice.agent': true, 'execution.runs': true },
  }));
});
afterEach(async () => {
  standardCleanup();
  vi.useRealTimers();
  await account?.dispose();
  storage.setState(initialStorage, true);
});

type Agent = ReturnType<typeof readLocalConversationVoiceSettings>['agent'];

function voiceWithAgent(patch: Partial<Agent>): VoiceSettings {
  const cfg = readLocalConversationVoiceSettings(voiceSettingsDefaults);
  return writeLocalConversationVoiceSettings(voiceSettingsDefaults, { ...cfg, agent: { ...cfg.agent, ...patch } });
}

async function render(voice: VoiceSettings, setVoice = vi.fn()) {
  const { VoiceAgentMemorySection } = await import('./VoiceAgentMemorySection');
  vi.useFakeTimers();
  const screen = await renderScreen(React.createElement(VoiceAgentMemorySection, { voice, setVoice }));
  await act(async () => { await vi.runOnlyPendingTimersAsync(); });
  vi.useRealTimers();
  return screen;
}

describe('VoiceAgentMemorySection', () => {
  it('does not commit for unrelated Account preference changes while retaining resume-policy updates', async () => {
    const { VoiceAgentMemorySection } = await import('./VoiceAgentMemorySection');
    const voice = voiceWithAgent({ agentId: 'claude', agentSource: 'agent', transcript: { persistenceMode: 'persistent' } });
    let commits = 0;
    vi.useFakeTimers();
    const screen = await renderScreen(<React.Profiler id="voice-memory" onRender={() => { commits += 1; }}>
      <VoiceAgentMemorySection voice={voice} setVoice={() => {}} />
    </React.Profiler>);
    // Finish the real native control's deferred mount before measuring preference updates.
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    vi.useRealTimers();
    const initial = commits;
    for (let index = 0; index < 20; index += 1) {
      await act(async () => { storage.setState(state => ({ settings: {
        ...state.settings, analyticsOptOut: !state.settings.analyticsOptOut,
      } })); });
    }
    expect(commits - initial).toBe(0);
    const target = buildBackendTargetKeyV2({ kind: 'agent', identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.claude });
    await act(async () => { storage.setState(state => ({ settings: {
      ...state.settings, backendEnabledByTargetKey: { ...state.settings.backendEnabledByTargetKey, [target]: false },
    } })); });
    const restore = screen.findAll(node => node.props?.testIDPrefix === 'settings.voice.memory.restore')[0];
    expect(restore?.props.options.find((option: { id: string }) => option.id === 'provider_resume')?.unavailableReason).toBeTruthy();
  });
  it('quietly leaves memory unchanged when the user declines an explicit Action Ask', async () => {
    const voice = voiceWithAgent({ transcript: { persistenceMode: 'persistent' } });
    account.replaceVoice(voice);
    account.replaceSettings(settingsParse({ ...account.settings, actionsSettingsV1: {
      v: 1, actions: { 'settings.invoke': { approvalRequiredSurfaces: ['ui'] } },
    } }));
    const screen = await render(voice);
    let pending!: Promise<void>;
    await act(async () => { pending = screen.findAllByTestId('settings.voice.memory.forget')[0]!.props.onPress(); });
    await waitForTestEvent(account.subscribe, () => account.artifacts.list(), artifacts => artifacts.length === 1);
    expect(account.artifacts.list()).toHaveLength(1);
    await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[0]!.id, 'reject');
    await act(async () => { await pending; });
    expect(Modal.confirm).not.toHaveBeenCalled();
    expect(await readPersistentVoiceTranscriptEpoch()).toBe(0);
  });
  it.each([true, false])('keeps the admitted Forget confirmation (confirmed: %s)', async confirmed => {
    const voice = voiceWithAgent({ transcript: { persistenceMode: 'persistent' } });
    account.replaceVoice(voice);
    vi.mocked(Modal.confirm).mockResolvedValueOnce(confirmed);
    const screen = await render(voice);
    await act(async () => { await screen.findAllByTestId('settings.voice.memory.forget')[0]!.props.onPress(); });
    expect(Modal.confirm).toHaveBeenCalledOnce();
    expect(await readPersistentVoiceTranscriptEpoch()).toBe(confirmed ? 1 : 0);
    expect(account.writes).toHaveLength(0);
  });
  it('refuses Forget through Action policy before confirmation or transcript invalidation', async () => {
    const voice = voiceWithAgent({ transcript: { persistenceMode: 'persistent' } });
    account.replaceVoice(voice);
    account.replaceSettings(settingsParse({ ...account.settings, actionsSettingsV1: {
      v: 1, actions: { 'settings.invoke': { disabledSurfaces: ['ui'] } },
    } }));
    const { VoiceAgentMemorySection } = await import('./VoiceAgentMemorySection');
    const screen = await renderScreen(React.createElement(VoiceAgentMemorySection, { voice, setVoice: () => {} }));
    const before = account.writes.length;
    await act(async () => { await screen.findAllByTestId('settings.voice.memory.forget')[0]!.props.onPress(); });
    expect(Modal.confirm).not.toHaveBeenCalled();
    expect(await readPersistentVoiceTranscriptEpoch()).toBe(0);
    expect(account.writes).toHaveLength(before);
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    expect(await createDefaultActionExecutor().execute('settings.set', { anchor: 'voicePrivacy.recentMessagesCount', value: 9 }, {
      surface: 'ui', authority: 'present_user', serverId: account.scope.serverId, expectedAccountId: account.scope.accountId,
    })).toMatchObject({ ok: true });
    expect(account.persistedSettings.voice.privacy.recentMessagesCount).toBe(9);
  });
  it('shows how memory is restored even when nothing is remembered, locked until Remember is on', async () => {
    const screen = await render(voiceWithAgent({}));

    const restore = screen.findAll((node) => node.props?.testIDPrefix === 'settings.voice.memory.restore')[0];
    expect(restore?.props.disabled).toBe(true);
    expect(screen.findByTestId('settings.voice.local.replay.recentMessagesCount.field')?.props.editable).toBe(false);
    expect(screen.findByTestId('settings.voice.memory.forget')).toBeTruthy();
  });

  it('turning Remember on persists the transcript without touching how it is restored', async () => {
    const setVoice = vi.fn();
    const voice = voiceWithAgent({ replay: { strategy: 'summary_plus_recent', recentMessagesCount: 12 } });
    const screen = await render(voice, setVoice);

    screen.findByTestId('settings.voice.memory.remember')?.props.onValueChange(true);
    const agent = readLocalConversationVoiceSettings(setVoice.mock.lastCall![0]).agent;
    expect(agent.transcript.persistenceMode).toBe('persistent');
    expect(agent.replay).toEqual({ strategy: 'summary_plus_recent', recentMessagesCount: 12 });
  });

  it('chooses resuming the agent as one atomic restore choice', async () => {
    const setVoice = vi.fn();
    const voice = voiceWithAgent({ transcript: { persistenceMode: 'persistent' } });
    const screen = await render(voice, setVoice);

    screen.pressByTestId('settings.voice.memory.restore:provider_resume');
    const agent = readLocalConversationVoiceSettings(setVoice.mock.lastCall![0]).agent;
    expect(agent.resumabilityMode).toBe('provider_resume');
    expect(screen.findByTestId('settings.voice.memory.fallbackToReplay')).toBeTruthy();
  });

  it('says why resuming is unavailable when the Voice agent is off for this server', async () => {
    account.replaceSettings(settingsParse({ ...account.settings,
      featureToggles: { ...account.settings.featureToggles, 'voice.agent': false },
    }));
      const screen = await render(voiceWithAgent({ transcript: { persistenceMode: 'persistent' } }));
      const restore = screen.findAll((node) => node.props?.testIDPrefix === 'settings.voice.memory.restore')[0];
      const resume = restore?.props.options.find((option: { id: string }) => option.id === 'provider_resume');
      expect(typeof resume?.unavailableReason).toBe('string');
  });
});
