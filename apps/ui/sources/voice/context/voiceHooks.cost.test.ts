import { afterEach, expect, it, vi } from 'vitest';
import { storage } from '@/sync/domains/state/storage';
import * as voiceSettings from '@/sync/domains/settings/voiceSettings';
import { createSessionFixture } from '@/dev/testkit';
import { registerVoiceAdapters, resetVoiceAdapterRegistryForTests } from '@/voice/session/voiceAdapterRegistry';
import { setVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { createLocalConversationVoiceAdapter } from '@/voice/adapters/localConversation/localConversationAdapter';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import type { VoiceAdapterController, VoiceHostAuthoredContextScope } from '@/voice/session/types';
import * as formatters from './contextFormatters';
import { voiceHooks } from './voiceHooks';

const original = storage.getState();
afterEach(() => {
    vi.restoreAllMocks();
    storage.setState(original);
    resetVoiceAdapterRegistryForTests();
    setVoiceSessionSnapshot({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
    useVoiceTargetStore.getState().setPrimaryActionSessionAddress(null);
});

it.each(['off', 'local_conversation'])('does no context work for message/ready/request arrivals without a sink (%s), then delivers to a live sink', (providerId) => {
    const address = { serverId: 'voice-cost-home', sessionId: 'voice-cost-session' };
    const session = createSessionFixture({ id: address.sessionId, serverId: address.serverId });
    const voice = voiceSettings.voiceSettingsParse({ providerId });
    storage.setState({ settings: { ...original.settings, voice }, sessions: { [session.id]: session } });
    registerVoiceAdapters([createLocalConversationVoiceAdapter()]);
    const parse = vi.spyOn(voiceSettings, 'voiceSettingsParse');
    const scan = vi.spyOn(voiceSessionBindingStore.getState(), 'readPersistedBindings');
    const ready = vi.spyOn(formatters, 'formatReadyEvent');
    const text = vi.spyOn(formatters, 'formatNewMessages');
    let hookScans = 0;
    // Retained-binding publication also serves non-Voice surfaces. Count only
    // the event hooks' additional work after that independent publication.
    for (let arrival = 0; arrival < 32; arrival++) {
        storage.setState({ sessions: { ...storage.getState().sessions } });
        const scansBeforeHooks = scan.mock.calls.length;
        voiceHooks.onMessages(address, []);
        voiceHooks.onReady(address, []);
        voiceHooks.onAgentRequest(address, `request-${arrival}`, 'permission', 'Read', {});
        hookScans += scan.mock.calls.length - scansBeforeHooks;
    }
    expect({ parses: parse.mock.calls.length, scans: hookScans,
        readyFormats: ready.mock.calls.length, textFormats: text.mock.calls.length })
        .toEqual({ parses: 0, scans: 0, readyFormats: 0, textFormats: 0 });

    const delivered: string[] = [];
    let channelReads = 0;
    let contextScope: VoiceHostAuthoredContextScope = 'current_ui_only';
    const snapshot = { adapterId: 'cost.transport', sessionId: 'control', status: 'connected' as const, mode: 'listening' as const, canStop: true };
    // Synthetic provider transport; policy, settings, binding and formatting stay real.
    const adapter: VoiceAdapterController = { id: snapshot.adapterId, engineKind: 'realtime',
        start: async () => {}, stop: async () => {}, toggle: async () => {}, interrupt: async () => {},
        setMuted: async () => {}, sendContextUpdate: () => {}, getSnapshot: () => snapshot,
        subscribe: () => () => {}, resolveContextChannel: () => { channelReads++;
            return { hostAuthoredContext: contextScope, sendContextualUpdate: text => { delivered.push(text); },
                sendTextMessage: text => { delivered.push(text); } }; } };
    registerVoiceAdapters([adapter]);
    setVoiceSessionSnapshot(snapshot);
    useVoiceTargetStore.getState().setPrimaryActionSessionAddress(address);
    voiceHooks.onMessages(address, []);
    voiceHooks.onReady(address, []);
    voiceHooks.onAgentRequest(address, 'withheld-request', 'permission', 'Read', {});
    expect(delivered).toEqual([]);
    expect(parse).not.toHaveBeenCalled();
    expect(channelReads).toBe(3);
    contextScope = 'session_context';
    channelReads = 0;
    voiceHooks.onMessages(address, []);
    expect(channelReads).toBe(1);
    expect(delivered.length).toBeGreaterThan(0);
    const messageUpdates = delivered.length;
    voiceHooks.onReady(address, []);
    expect(channelReads).toBe(2);
    expect(delivered.length).toBeGreaterThan(messageUpdates);
    const readyUpdates = delivered.length;
    voiceHooks.onAgentRequest(address, 'active-request', 'permission', 'Read', {});
    expect(channelReads).toBe(3);
    expect(delivered.length).toBeGreaterThan(readyUpdates);
    expect(ready).toHaveBeenCalledTimes(1);
});
