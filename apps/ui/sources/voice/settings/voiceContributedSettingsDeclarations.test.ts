import { describe, expect, it, vi } from 'vitest';
import { VoiceProviderContributionSchema } from '@happier-dev/protocol/plugins/contributions/voice';
import { getSettingsDeclarationCatalogV1 } from '@happier-dev/protocol/actions/settings/settingsDeclarationCatalog';

import { createVoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import { getVoiceContributedSettingsDeclarations } from './voiceContributedSettingsDeclarations';
// Compile the real default declaration graph during collection, before test execution.
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

describe('contributed Voice settings declaration admission', () => {
    it('exposes one Dictation language owner while retaining conversation engine language', async () => {
        const registry = createDefaultVoiceProviderRegistry();
        const pages = getVoiceContributedSettingsDeclarations(registry);
        const field = 'provider.happier.voice.google/gemini-stt.language';
        const dictationFields = Object.assign({}, ...pages.filter(page => page.pageId === 'voiceDictation').map(page => page.settings));
        const conversationFields = Object.assign({}, ...pages.filter(page => page.pageId === 'voiceConversations').map(page => page.settings));
        expect(dictationFields[field]).toBeUndefined();
        expect(conversationFields[field]?.storage).toBeDefined();
        const catalog = getSettingsDeclarationCatalogV1(registry);
        expect(catalog.filter(row => row.anchor === 'voiceDictation.language')).toHaveLength(1);
        expect(catalog.some(row => row.anchor === 'voiceDictation.sttLanguage')).toBe(false);
    });
    it('exposes typed selection for API-key-only providers and declarative Connected Account pickers', async () => {
        const pages = getVoiceContributedSettingsDeclarations(createDefaultVoiceProviderRegistry());
        const fields = Object.assign({}, ...pages.map(page => page.settings));
        for (const key of ['provider.happier.voice.google/gemini-stt.credential',
            'provider.happier.voice.openai/realtime-openai.credential',
            'provider.happier.agent.codex/realtime-codex.globalConnectedServices']) {
            expect(fields[key]?.operation, key).toMatchObject({ kind: 'invoke', requiresHumanInteraction: false });
            const operation = fields[key]?.operation;
            expect(operation?.kind === 'invoke' ? operation.uiConfirmation : null, key)
                .toBe(key.endsWith('.globalConnectedServices') ? undefined : 'direct');
            expect(fields[key], key).toMatchObject({ sensitive: true });
            expect(fields[key]?.storage, key).toBeUndefined();
        }
    });

    it.each([false, true])('admits a provider presentation once per projection while preserving field validation (invalid presentation: %s)', (invalidPresentation) => {
        const pluginId = 'fixture.voice';
        const providerId = `${pluginId}/speech`;
        const fieldIds = ['speed', 'pitch', 'volume'];
        const declaration = VoiceProviderContributionSchema.parse({
            id: 'speech', title: 'Fixture voice', kind: 'conversation', roles: ['realtime_conversation'], platforms: ['web'],
            capabilities: { turn: { cancelResponse: false, bargeIn: false },  },
            client: { artifactId: 'voice', exportName: 'activate' },
            settings: {
                schemaVersion: 1,
                fields: fieldIds.map(id => ({ id, title: id, schema: { type: 'number', minimum: 0, maximum: 10 },
                    default: 1, presentation: { control: 'number' } })),
                presentation: {
                    kind: 'voice.provider-settings.v1', modes: ['byo'], credential: { kind: 'none', catalog: null }, links: {},
                    fields: fieldIds.map(path => ({ kind: 'number', path, requiresOptIn: true })),
                },
            },
        });
        const source = createVoiceProviderRegistry({
            bundledContributions: [{ pluginId, providerId, declaration }],
            bundledPresentations: [{ providerId, settingsSectionId: providerId }],
        }).get(providerId);
        const descriptor = source?.providerSettings;
        const presentation = descriptor?.presentation;
        if (!source || !descriptor || !presentation) throw new Error('Missing fixture provider settings');
        let presentationAdmissions = 0;
        const measuredPresentation = {
            ...presentation,
            // Observe the real schema reading this input, without replacing its parser.
            get modes() { presentationAdmissions++; return presentation.modes; },
            links: invalidPresentation ? { privacy: 'http://invalid.example' } : presentation.links,
        };
        const measuredEntry = { ...source, providerSettings: { ...descriptor, presentation: measuredPresentation } };
        const registry = createVoiceProviderRegistry({ builtIn: [measuredEntry] });
        presentationAdmissions = 0;

        for (let projection = 1; projection <= 2; projection++) {
            const [page] = getVoiceContributedSettingsDeclarations(registry);
            expect(page?.pageId).toBe('voiceConversations');
            const fields = page?.settings;
            expect(Object.keys(fields ?? {})).toHaveLength(fieldIds.length);
            for (const id of fieldIds) {
                const binding = fields?.[`provider.${providerId}.${id}`]?.storage;
                if (!binding || !('kind' in binding) || binding.kind !== 'owner') throw new Error('Missing provider field owner');
                expect(binding.parse(5)).toEqual({ success: true, value: 5 });
                expect(binding.parse(11)).toEqual({ success: false });
                expect(binding.parse({ value: 5 })).toEqual({ success: false });
                expect(typeof binding.prepare).toBe(invalidPresentation ? 'undefined' : 'function');
            }
            expect(presentationAdmissions).toBe(projection);
        }
    });
});
