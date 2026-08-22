import { describe, expect, it } from 'vitest';

import type { SpeechProviderRuntime } from '@happier-dev/plugin-sdk/voice/speech';

import type { ResolvedVoiceProviderContribution } from '@/plugins/projection/registry/types';
import { createTargetVoiceSpeechRegistry } from './targetVoiceSpeech';

type VoiceProviderDefinition = ResolvedVoiceProviderContribution['definition'];
type SpeechDefinition = Extract<VoiceProviderDefinition, { kind: 'speech' }>;
type ConversationDefinition = Extract<VoiceProviderDefinition, { kind: 'conversation' }>;

const speechDefinition: SpeechDefinition = {
    id: 'main',
    title: 'Acme Speech',
    kind: 'speech',
    roles: ['dictation_stt', 'conversation_tts'],
    platforms: ['web'],
    catalogs: [{ kind: 'models', settingFieldId: 'model', allowCustom: true }],
    settings: {
        schemaVersion: 2,
        fields: [
            {
                id: 'model',
                title: 'Model',
                schema: { type: 'string', minLength: 1, maxLength: 256 },
                default: 'model-a',
                presentation: { control: 'select' },
            },
            {
                id: 'voiceName',
                title: 'Voice',
                schema: { type: 'string', minLength: 1, maxLength: 256 },
                default: 'voice-a',
            },
        ],
    },
};

function contribution(
    definition: ResolvedVoiceProviderContribution['definition'] = speechDefinition,
): ResolvedVoiceProviderContribution {
    return Object.freeze({
        provenance: 'external',
        source: Object.freeze({ kind: 'path' }),
        pluginId: 'acme.speech',
        identity: Object.freeze({ pluginId: 'acme.speech', localId: definition.id }),
        manifestPath: '/plugins/acme.speech/plugin.json',
        definition,
    });
}

const runtime: SpeechProviderRuntime = Object.freeze({
    kind: 'speech',
    catalog: Object.freeze({ async list() { return Object.freeze([]); } }),
    async transcribe(request) { return Object.freeze({ requestId: request.requestId, text: 'hello' }); },
    async synthesize(request) {
        return Object.freeze({ requestId: request.requestId, bytes: new Uint8Array([1]), mimeType: 'audio/mpeg' });
    },
});
const http = Object.freeze({ request: async () => ({
    status: 200, finalUrl: 'https://speech.test', headers: {}, body: new Uint8Array(),
}) });

describe('target Voice speech registry', () => {
    it('joins one exact unified registration to the normalized speech declaration', () => {
        let current = true;
        let operationCurrent = true;
        let boundCurrentness = (): boolean => {
            throw new Error('HTTP currentness was not bound');
        };
        const retirement = new AbortController();
        const entry = Object.freeze({
            pluginId: 'acme.speech',
            generation: '7',
            registration: Object.freeze({ family: 'voiceProviders' as const, localId: 'main', value: runtime }),
        });
        const targetRegistrations = [entry];
        const registry = createTargetVoiceSpeechRegistry({
            generation: 7,
            voiceProviders: [contribution()],
            targetRegistrations,
            resolveGenerationLifecycle: () => ({
                isCurrent: () => current,
                retirementSignal: retirement.signal,
            }),
            createHttp: (input) => {
                boundCurrentness = input.isCurrent;
                return http;
            },
        });

        const resolved = registry.read({ pluginId: 'acme.speech', localId: 'main' });
        expect(resolved).toMatchObject({
            generation: '7',
            qualifiedId: 'acme.speech/main',
            runtime,
            contribution: speechDefinition,
        });
        expect(resolved?.isCurrent()).toBe(true);
        expect(resolved?.retirementSignal).toBe(retirement.signal);
        expect(resolved?.createHttp(
            new AbortController().signal,
            () => operationCurrent,
        )).toBe(http);
        expect(boundCurrentness()).toBe(true);

        operationCurrent = false;
        expect(boundCurrentness()).toBe(false);
        operationCurrent = true;

        current = false;
        expect(resolved?.isCurrent()).toBe(false);
        expect(boundCurrentness()).toBe(false);
    });

    it('does not resolve another generation, local id, or a conversation declaration', () => {
        const conversation: ConversationDefinition = {
            id: 'conversation', title: 'Conversation', kind: 'conversation',
            roles: ['realtime_conversation'], platforms: ['web'],
            capabilities: {
                turn: { cancelResponse: true, bargeIn: true },
                tools: { effectCalls: 'none' },
            },
            client: { artifactId: 'voice-ui', modulePath: './voice.js', exportName: 'activate' },
        };
        const registry = createTargetVoiceSpeechRegistry({
            generation: 8,
            voiceProviders: [contribution(), contribution(conversation)],
            targetRegistrations: [{
                pluginId: 'acme.speech', generation: '7',
                registration: { family: 'voiceProviders', localId: 'main', value: runtime },
            }, {
                pluginId: 'acme.speech', generation: '8',
                registration: {
                    family: 'voiceProviders', localId: 'conversation',
                    value: runtime,
                },
            }],
            resolveGenerationLifecycle: () => ({
                isCurrent: () => true,
                retirementSignal: new AbortController().signal,
            }),
            createHttp: () => http,
        });
        expect(registry.read({ pluginId: 'acme.speech', localId: 'main' })).toBeNull();
        expect(registry.read({ pluginId: 'acme.speech', localId: 'other' })).toBeNull();
        expect(registry.read({ pluginId: 'acme.speech', localId: 'conversation' })).toBeNull();
    });

});
