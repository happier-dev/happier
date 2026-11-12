import { afterEach, describe, expect, it } from 'vitest';

import type { SpeechProviderRuntime } from '@happier-dev/plugin-sdk/voice/speech';

import type { ResolvedVoiceProviderContribution } from '@/plugins/projection/registry/types';
import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { activateContributionModule } from '../activation/activateContributionModule';
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
                presentation: { control: 'text' },
            },
            {
                id: 'format',
                title: 'Format',
                schema: { type: 'string', enum: ['mp3', 'wav'] },
                default: 'mp3',
                presentation: { control: 'select', options: [{ value: 'mp3', title: 'MP3' }, { value: 'wav', title: 'WAV' }] },
            },
        ],
    },
};

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

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const dispose of disposers.splice(0).reverse()) await dispose();
});

async function speechFixture(definitions: readonly VoiceProviderDefinition[] = [speechDefinition]) {
    const manifest = createPluginManifestV2Fixture({
        id: 'acme.speech', activation: { events: [{ kind: 'startup' }] },
        contributes: { voiceProviders: definitions },
    });
    const ingestion = ingestCanonicalPluginManifest(manifest, { sourceProvenance: 'registryCustodied' });
    if (!ingestion.ok) throw new Error(ingestion.diagnostics.map(({ message }) => message).join('\n'));
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{
        manifest,
        files: { 'daemon.mjs': `let speech;
            export function configure(value) { speech = value; }
            export function activate(api) { api.voiceProviders.register('main', speech); }` },
        instantiateCommittedModule(module) {
            if (typeof module.configure !== 'function') throw new Error('Speech SDK fixture configuration missing');
            module.configure(runtime);
            return module;
        },
    }] });
    disposers.push(() => fixture.dispose());
    const lifecycle = fixture.registry.resolveVoiceProviderRuntimeLifecycle?.({ pluginId: 'acme.speech', localId: 'main' });
    if (!lifecycle) throw new Error('Admitted speech occurrence missing');
    const moduleNamespace = fixture.modulesByPluginId.get('acme.speech');
    if (!moduleNamespace) throw new Error('Admitted speech module missing');
    const activation = await activateContributionModule({
        pluginId: 'acme.speech', occurrenceId: lifecycle.occurrenceId,
        manifest: ingestion.manifest, moduleNamespace,
        isOccurrenceCurrent: lifecycle.isCurrent,
    });
    disposers.push(() => activation.dispose());
    expect(activation.status).toBe('active');
    return {
        fixture, lifecycle,
        targetRegistrations: activation.registrations.map((registration) => ({
            pluginId: 'acme.speech', occurrenceId: lifecycle.occurrenceId, registration,
        })),
    };
}

describe('target Voice speech registry', () => {
    it('joins one exact unified registration to the normalized speech declaration', async () => {
        let operationCurrent = true;
        let boundCurrentness = (): boolean => {
            throw new Error('HTTP currentness was not bound');
        };
        const { fixture, lifecycle, targetRegistrations } = await speechFixture();
        const registeredSpeech = targetRegistrations.find((entry) => entry.registration.family === 'voiceProviders' && entry.registration.localId === 'main');
        if (!registeredSpeech || registeredSpeech.registration.family !== 'voiceProviders') throw new Error('Speech SDK registration missing');
        const registry = createTargetVoiceSpeechRegistry({
            voiceProviders: fixture.registry.contributes.voiceProviders ?? [],
            targetRegistrations,
            readPluginOccurrenceId: (pluginId) => fixture.registry.readPluginOccurrenceId?.(pluginId) ?? null,
            resolveOccurrenceLifecycle: () => lifecycle,
            createHttp: (input) => {
                boundCurrentness = input.isCurrent;
                return http;
            },
        });

        const resolved = registry.read({ pluginId: 'acme.speech', localId: 'main' });
        expect(resolved).toMatchObject({
            occurrenceId: lifecycle.occurrenceId,
            qualifiedId: 'acme.speech/main',
            contribution: speechDefinition,
        });
        expect(resolved?.runtime).toBe(registeredSpeech.registration.value);
        expect(resolved?.isCurrent()).toBe(true);
        expect(resolved?.retirementSignal).toBe(lifecycle.retirementSignal);
        expect(resolved?.createHttp(
            new AbortController().signal,
            () => operationCurrent,
        )).toBe(http);
        expect(boundCurrentness()).toBe(true);

        operationCurrent = false;
        expect(boundCurrentness()).toBe(false);
        operationCurrent = true;

        await fixture.dispose();
        expect(resolved?.isCurrent()).toBe(false);
        expect(boundCurrentness()).toBe(false);
    });

    it('does not resolve another generation, local id, or a conversation declaration', async () => {
        const conversation: ConversationDefinition = {
            id: 'conversation', title: 'Conversation', kind: 'conversation',
            roles: ['realtime_conversation'], platforms: ['web'],
            capabilities: {
                turn: { cancelResponse: true, bargeIn: true },

            },
            client: { artifactId: 'voice-ui', exportName: 'activate' },
        };
        const { fixture, lifecycle, targetRegistrations } = await speechFixture([speechDefinition, conversation]);
        const speechRegistration = targetRegistrations.find((entry) => entry.registration.family === 'voiceProviders');
        if (!speechRegistration || speechRegistration.registration.family !== 'voiceProviders') throw new Error('Speech SDK registration missing');
        const registry = createTargetVoiceSpeechRegistry({
            voiceProviders: fixture.registry.contributes.voiceProviders ?? [],
            targetRegistrations: [{
                ...speechRegistration, occurrenceId: `${lifecycle.occurrenceId}:stale`,
            }, {
                pluginId: 'acme.speech', occurrenceId: lifecycle.occurrenceId,
                registration: {
                    ...speechRegistration.registration, localId: 'conversation',
                },
            }],
            readPluginOccurrenceId: (pluginId) => fixture.registry.readPluginOccurrenceId?.(pluginId) ?? null,
            resolveOccurrenceLifecycle: () => lifecycle,
            createHttp: () => http,
        });
        expect(registry.read({ pluginId: 'acme.speech', localId: 'main' })).toBeNull();
        expect(registry.read({ pluginId: 'acme.speech', localId: 'other' })).toBeNull();
        expect(registry.read({ pluginId: 'acme.speech', localId: 'conversation' })).toBeNull();
    });

});
