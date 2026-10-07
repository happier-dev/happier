import { vi } from 'vitest';
import { settingsParse, type Settings } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { PluginApi } from '@happier-dev/plugin-sdk';
import type { VoiceAccountOperationService } from '@happier-dev/plugin-sdk/voice';
import { BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES } from '@/voice/registry/generatedBundledVoiceRuntimeEntries';
import { bindVoiceProviderSettingsActions, bindVoiceProviderSettingsOperations } from '@/voice/registry/externalVoiceProviderActivation';
import { commitExternalVoiceProviderRegistration, removeExternalVoiceProviderRegistration } from '@/voice/registry/externalVoiceProviderRegistrations';
import { normalizeVoiceSettingsLocalDelta, normalizeVoiceSettingsServerDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import { normalizeAccountSettingsForServerStorage } from '@/sync/domains/settings/accountSettingsNormalization';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { FeaturesResponseSchema } from '@happier-dev/protocol';

/** Real Account Settings owner; only the Home HTTP transport is synthetic. */
export async function createVoiceSettingsAccountTestHarness(settings: Settings) {
    await loadSyncSingletonForTests();
    const serialize = (value: Settings) => normalizeAccountSettingsForServerStorage({
        raw: value, mode: 'plain', settingsSecretsKey: null,
        normalizeServerRaw: (raw) => normalizeVoiceSettingsServerDelta(raw),
    }).value;
    let raw = serialize(settings);
    let version = 4;
    const writes: unknown[] = [];
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/features') return Response.json(FeaturesResponseSchema.parse({ features: { voice: { enabled: true } }, capabilities: {} }));
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
        if (path === '/v1/account/encryption/currentness') return Response.json({
            mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0,
        });
        if (path === '/v2/account/settings') {
            if (init?.method === 'POST') {
                const body: { expectedVersion: number; content: { t: string; v: Record<string, unknown> } } = JSON.parse(String(init.body));
                writes.push(body);
                if (body.expectedVersion !== version) return Response.json({ success: false, version, content: { t: 'plain', v: raw } }, { status: 409 });
                if (body.content.t !== 'plain') throw new Error('Plain test Account received encrypted settings');
                raw = body.content.v;
                version += 1;
                return Response.json({ success: true, version });
            }
            return Response.json({ content: { t: 'plain', v: raw }, version });
        }
        if (path === '/v2/sessions' || path === '/v2/sessions/active') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
        return new Response('{}', { status: 404 });
    });
    const connection = await restoreServerAccountForTest({
        serverUrl: 'https://voice-settings.example.test', accountId: 'voice-settings-account', request,
    });
    const { sync } = await import('@/sync/sync');
    // Join the real bootstrap queue before replacing the fixture snapshot.
    const queue = Reflect.get(sync, 'settingsSync') as import('@/utils/sessions/sync').InvalidateSync;
    await queue.awaitQueue();
    const scope = { serverId: connection.home.id, accountId: 'voice-settings-account' };
    storage.setState({ settings: settingsParse(raw), settingsVersion: version, settingsScope: scope });
    const replaceSettings = (next: Settings) => {
        raw = serialize(next);
        storage.setState({ settings: next, settingsVersion: version, settingsScope: scope });
    };
    return {
        writes, request, scope,
        get settings() { return storage.getState().settings; },
        get persistedSettings() { return settingsParse(raw); },
        replaceSettings,
        replaceVoice(next: VoiceSettings) {
            const current = storage.getState().settings;
            replaceSettings(settingsParse({ ...current, ...normalizeVoiceSettingsLocalDelta({ voice: next }, current) }));
        },
        dispose: connection.dispose,
    };
}

/** Activates the shipped leaf and replaces only the provider's account HTTP port. */
export function createElevenLabsSettingsRuntimeTestHarness() {
    const entry = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES.find((candidate) => candidate.declaration.id === 'realtime-elevenlabs');
    if (!entry) throw new Error('ElevenLabs runtime entry missing');
    const runtimes: Parameters<PluginApi['voiceProviders']['register']>[1][] = [];
    entry.activate({ voiceProviders: { register(_id, runtime) { runtimes.push(runtime); } } });
    const runtime = runtimes[0];
    if (runtime?.kind !== 'conversation' || !runtime.settingsOperations || !runtime.settingsActions) throw new Error('ElevenLabs settings runtime missing');
    let nextToolId = 0;
    const response = (body: unknown, status = 200): Awaited<ReturnType<VoiceAccountOperationService['request']>> => Object.freeze({
        status, finalUrl: 'https://api.elevenlabs.io/test', headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify(body)),
    });
    const request = vi.fn(async (input: Parameters<VoiceAccountOperationService['request']>[0]): ReturnType<VoiceAccountOperationService['request']> => {
        if (input.operationId === 'agents') return response({ agents: [], has_more: false, next_cursor: null });
        if (input.operationId === 'voices') return response({ voices: [{ voice_id: 'hpp4J3VqNfWAUOO0d1Us', name: 'Happier voice', category: 'premade' }] });
        if (input.operationId === 'tools') return response({ tools: [], has_more: false, next_cursor: null });
        if (input.operationId === 'create-tool') return response({ id: `tool_${++nextToolId}` });
        if (input.operationId === 'create-agent') return response({ agent_id: 'agent_created' });
        return response({});
    });
    const credentials = () => Object.freeze({ phase: 'settings' as const, mediated: Object.freeze({ request }), raw: null });
    const settingsOperations = bindVoiceProviderSettingsOperations({ operations: runtime.settingsOperations, createCredentials: credentials, isCurrent: () => true });
    const settingsActions = bindVoiceProviderSettingsActions({
        actions: runtime.settingsActions, declaredActions: entry.declaration.settings?.actions ?? [],
        createCredentials: credentials, createInteractions: () => Object.freeze({
            askQuestions: async () => Object.freeze({ requestId: 'test-questions', kind: 'questions' as const, status: 'answered' as const,
                answers: { 'existing-agent-action': { kind: 'singleChoice' as const, answer: { kind: 'choice' as const, choiceId: 'create-new' } } },
            }),
        }),
        getRealtimeClientToolDefinitions: () => [{ name: 'listMachines', description: 'List machines',
            parameters: { type: 'object', additionalProperties: false }, execute: async () => ({ ok: true }) }],
        isCurrent: () => true,
    });
    const token = Object.freeze({});
    const registration = Object.freeze({ token, pluginId: entry.pluginId, localId: entry.declaration.id,
        providerId: `${entry.pluginId}/${entry.declaration.id}`, occurrenceId: 'voice-settings-test-occurrence',
        descriptor: null, adapter: null, settingsOperations, settingsActions });
    return {
        request, response, registration, entry,
        register() { commitExternalVoiceProviderRegistration(registration); },
        async dispose() { removeExternalVoiceProviderRegistration(token); await runtime.dispose?.(); },
    };
}
