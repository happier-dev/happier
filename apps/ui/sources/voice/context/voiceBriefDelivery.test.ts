import { afterEach, describe, expect, it } from 'vitest';
import { voiceHooks } from './voiceHooks';
import { buildVoiceBrief, type VoiceBriefSource } from './buildVoiceBrief';
import { registerVoiceAdapters, resetVoiceAdapterRegistryForTests } from '@/voice/session/voiceAdapterRegistry';
import { setVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';
import type { VoiceAdapterController, VoiceHostAuthoredContextScope } from '@/voice/session/types';

const attention: VoiceBriefSource['workflowAttention'] = { serverId: null, available: false, phase: 'idle', runIds: [], refreshFailed: false,
    knownAt: null, hasMore: false, loadingMore: false, loadMoreFailed: false, retry: async () => {}, loadMore: async () => {} };
const inbox: VoiceBriefSource = { source: { isDataReady: true, personalSessionListCoverageComplete: true },
    sessionPresentation: { sessionsNeedingAttention: [], readySessions: [], markAllReadTargets: [] }, workGroups: [], automationAttentionItems: [],
    workflowAttention: attention, automationAttention: attention, isLoading: false, showCaughtUp: true };
const brief = buildVoiceBrief({ inbox, settings: {} });

afterEach(() => { resetVoiceAdapterRegistryForTests(); setVoiceSessionSnapshot({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false }); });

describe('explicit Voice Brief delivery', () => {
    it('uses the real context owner and refuses an Agent-owned context or a stale control', () => {
        const delivered: string[] = [];
        const text: string[] = [];
        let scope: VoiceHostAuthoredContextScope = 'current_ui_only';
        const snapshot = { adapterId: 'test.transport', sessionId: 'control', status: 'connected' as const, mode: 'listening' as const, canStop: true };
        // Only the provider's transport is synthetic; channel selection, privacy projection
        // and host context-scope admission are the real owners beneath it.
        const adapter: VoiceAdapterController = { id: snapshot.adapterId, engineKind: 'realtime', start: async () => {}, stop: async () => {},
            toggle: async () => {}, interrupt: async () => {}, setMuted: async () => {}, sendContextUpdate: () => {},
            getSnapshot: () => snapshot, subscribe: () => () => {}, resolveContextChannel: () => ({ hostAuthoredContext: scope,
                sendContextualUpdate: (value) => { delivered.push(value); }, sendTextMessage: (value) => { text.push(value); } }) };
        registerVoiceAdapters([adapter]);
        setVoiceSessionSnapshot(snapshot);
        expect(voiceHooks.onBriefRequested('control', inbox)).toBe(false);
        scope = 'session_context';
        expect(voiceHooks.onBriefRequested('wrong-control', inbox)).toBe(false);
        expect(voiceHooks.onBriefRequested('control', inbox)).toBe(true);
        expect(delivered).toHaveLength(1);
        expect(delivered[0]).toContain(brief.context);
        expect(text).toHaveLength(1);
    });
});
