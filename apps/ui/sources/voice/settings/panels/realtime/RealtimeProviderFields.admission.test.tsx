import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createVoiceSettingsAccountTestHarness } from '../voiceSettingsAccountTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { readVoiceProviderSettingsConfig } from '@/sync/domains/settings/voiceSettings';
import { storage } from '@/sync/domains/state/storage';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { Slider } from '@/components/ui/forms/Slider';
import { Switch } from '@/components/ui/forms/Switch';
import { Modal } from '@/modal';
import { VoiceGreetingItem } from '../VoiceGreetingItem';
import { applyVoiceWelcomeSelection, resolveVoiceWelcomeSelection } from '@/voice/settings/welcome';
import { useVoiceSettingsMutable } from '@/voice/settings/useVoiceSettingsMutable';
import { useBundledConversationProviderSettings } from './useBundledConversationProviderSettings';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { RealtimeProviderFields } from './RealtimeProviderFields';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
installDisconnectedServerSocketBoundary();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const originalState = storage.getState();
afterEach(() => { standardCleanup(); storage.setState(originalState, true); });

const provider = createDefaultVoiceProviderRegistry().list().find(entry => 'declaration' in entry && entry.declaration?.id === 'realtime-openai');
if (!provider?.providerSettings) throw new Error('OpenAI declared Voice settings missing');
const providerId = provider.providerId;
const descriptor = provider.providerSettings;
const elevenlabs = createDefaultVoiceProviderRegistry().list().find(entry => 'declaration' in entry && entry.declaration?.id === 'realtime-elevenlabs');
if (!elevenlabs?.providerSettings) throw new Error('ElevenLabs declared Voice settings missing');
const xai = createDefaultVoiceProviderRegistry().list().find(entry => 'declaration' in entry && entry.declaration?.id === 'realtime-grok');
if (!xai?.providerSettings) throw new Error('xAI declared Voice settings missing');

/** The existing settings consumer and writer remain real below the Home HTTP boundary. */
function VoiceFields({ paths = ['voice'] }: { paths?: readonly string[] }) {
    const [voice, setVoice] = useVoiceSettingsMutable();
    const settings = useBundledConversationProviderSettings(voice);
    if (!settings.owner || !settings.config || !settings.descriptor) throw new Error('Voice settings unavailable');
    if (!voice.providerId) throw new Error('Voice provider missing');
    return <RealtimeProviderFields providerId={voice.providerId} owner={settings.owner} config={settings.config}
        descriptor={{ ...settings.descriptor, fields: settings.descriptor.fields.filter(field => paths.includes(field.path)) }}
        credentialStatus="ready" catalog={{ phase: 'ready', rows: [{ id: 'alloy', name: 'Alloy' }, { id: 'sage', name: 'Sage' }] }}
        welcomeSelection={resolveVoiceWelcomeSelection(voice.welcome)} assistantLanguage={voice.assistantLanguage}
        onWelcomeSelection={selection => setVoice(applyVoiceWelcomeSelection(voice,
            selection === 'immediate' ? 'immediate' : selection === 'on_first_turn' ? 'on_first_turn' : 'off'))}
        onRequestCatalog={() => {}} />;
}

describe('declared Voice field Action admission', () => {
    it('applies one declared provider field against the current Account settings', async () => {
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({
            voice: { providerId, providers: { [providerId]: { schemaVersion: descriptor.schemaVersion,
                config: { ...descriptor.defaultConfig, voice: 'alloy' } } } },
        }));
        try {
            const screen = await renderScreen(<VoiceFields />);
            const picker = screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'voice-realtime-field-voice');
            if (!picker) throw new Error('Voice field missing');
            act(() => account.replaceVoice({ ...account.settings.voice, assistantLanguage: 'fr' }));
            await act(async () => picker.props.onSelect('sage'));
            await vi.waitFor(() => expect(readVoiceProviderSettingsConfig(account.persistedSettings.voice, providerId)?.voice).toBe('sage'));
            expect(account.persistedSettings.voice.assistantLanguage).toBe('fr');
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('does not bypass disabled settings.set when selecting a provider voice', async () => {
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({
            voice: { providerId, providers: { [providerId]: { schemaVersion: descriptor.schemaVersion,
                config: { ...descriptor.defaultConfig, voice: 'alloy' } } } },
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
        }));
        try {
            const screen = await renderScreen(<VoiceFields />);
            const picker = screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'voice-realtime-field-voice');
            if (!picker) throw new Error('Voice field missing');
            await act(async () => picker.props.onSelect('sage'));
            expect(readVoiceProviderSettingsConfig(account.settings.voice, providerId)?.voice).toBe('alloy');
            expect(account.writes).toEqual([]);
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('saves compound custom models and inline instructions without replacing neighboring provider values', async () => {
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({ voice: { providerId,
            providers: { [providerId]: { schemaVersion: descriptor.schemaVersion, config: descriptor.defaultConfig } } } }));
        try {
            const screen = await renderScreen(<VoiceFields paths={['model', 'instructions']} />);
            const model = screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'voice-realtime-field-model');
            if (!model) throw new Error('Model field missing');
            await act(async () => model.props.onSelect('__custom__'));
            const custom = screen.findAllByType(FieldValueItem).find(node => node.props.testID === 'voice-realtime-field-model.custom');
            if (!custom) throw new Error('Custom model input missing');
            const current = readVoiceProviderSettingsConfig(account.settings.voice, providerId);
            act(() => account.replaceVoice({ ...account.settings.voice, providers: { ...account.settings.voice.providers,
                [providerId]: { schemaVersion: descriptor.schemaVersion, config: { ...current, voice: 'sage' } } } }));
            await act(async () => { custom.props.onCommit('gpt-realtime-custom'); });
            await vi.waitFor(() => expect(readVoiceProviderSettingsConfig(account.persistedSettings.voice, providerId)?.model)
                .toEqual({ kind: 'pinned', id: 'gpt-realtime-custom' }));
            const instructions = screen.findAllByType(FieldValueItem).find(node => node.props.testID === 'voice-realtime-field-instructions');
            if (!instructions) throw new Error('Instructions field missing');
            await act(async () => { instructions.props.onCommit('Be concise'); });
            await vi.waitFor(() => expect(readVoiceProviderSettingsConfig(account.persistedSettings.voice, providerId))
                .toMatchObject({ instructions: 'Be concise', voice: 'sage', model: { id: 'gpt-realtime-custom' } }));
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('admits a declared nested range, rejects off-step input, and restores its nullable service default', async () => {
        const id = elevenlabs.providerId;
        const settings = elevenlabs.providerSettings!;
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({ voice: { providerId: id,
            providers: { [id]: { schemaVersion: settings.schemaVersion, config: settings.defaultConfig } } } }));
        try {
            const screen = await renderScreen(<VoiceFields paths={['tts.voiceSettings.speed']} />);
            const slider = screen.findAllByType(Slider)[0];
            if (!slider) throw new Error('Speed field missing');
            await act(async () => { slider.props.onValueChange(1.1); });
            await vi.waitFor(() => expect(readVoiceProviderSettingsConfig(account.persistedSettings.voice, id))
                .toMatchObject({ tts: { voiceSettings: { speed: 1.1 } } }));
            const writes = account.writes.length;
            await act(async () => { slider.props.onValueChange(1.15); });
            expect(account.writes).toHaveLength(writes);
            const reset = screen.findByTestId('voice-realtime-field-tts-voiceSettings-speed.default');
            if (!reset) throw new Error('Service default control missing');
            await act(async () => { reset.props.onPress(); });
            await vi.waitFor(() => expect(readVoiceProviderSettingsConfig(account.persistedSettings.voice, id))
                .toMatchObject({ tts: { voiceSettings: { speed: null } } }));
        } finally { standardCleanup(); await account.dispose(); }
    });
    it.each([false, true])('retains shared Greeting Action admission (disabled=%s)', async disabled => {
        const id = elevenlabs.providerId;
        const settings = elevenlabs.providerSettings!;
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({ voice: { providerId: id,
            providers: { [id]: { schemaVersion: settings.schemaVersion, config: settings.defaultConfig } } },
            ...(disabled ? { actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } } } : {}),
        }));
        try {
            const screen = await renderScreen(<VoiceFields paths={['welcome']} />);
            const greeting = screen.findAllByType(VoiceGreetingItem)[0];
            if (!greeting) throw new Error('Greeting missing');
            await act(async () => greeting.props.onChange('on_first_turn'));
            if (disabled) {
                expect(resolveVoiceWelcomeSelection(account.settings.voice.welcome)).toBe('off');
                expect(account.writes).toEqual([]);
            } else await vi.waitFor(() => expect(resolveVoiceWelcomeSelection(account.persistedSettings.voice.welcome)).toBe('on_first_turn'));
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('encodes declared keyterm arrays and structured custom voices through their existing bindings', async () => {
        const id = xai.providerId;
        const settings = xai.providerSettings!;
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({ voice: { providerId: id,
            providers: { [id]: { schemaVersion: settings.schemaVersion, config: settings.defaultConfig } } } }));
        try {
            const screen = await renderScreen(<VoiceFields paths={['transcription.keyterms', 'voice']} />);
            const terms = screen.findAllByType(FieldValueItem).find(node => node.props.testID === 'voice-realtime-field-transcription-keyterms');
            if (!terms) throw new Error('Keyterms missing');
            await act(async () => { terms.props.onCommit('Happier, daemon ,happier'); });
            await vi.waitFor(() => expect(readVoiceProviderSettingsConfig(account.persistedSettings.voice, id))
                .toMatchObject({ transcription: { keyterms: ['happier', 'daemon'] } }));
            const picker = screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'voice-realtime-field-voice');
            if (!picker) throw new Error('Voice picker missing');
            await act(async () => picker.props.onSelect('__custom__'));
            const custom = screen.findAllByType(FieldValueItem).find(node => node.props.testID === 'voice-realtime-field-voice.custom');
            if (!custom) throw new Error('Custom voice missing');
            await act(async () => { custom.props.onCommit('my-cloned-voice'); });
            await vi.waitFor(() => expect(readVoiceProviderSettingsConfig(account.persistedSettings.voice, id))
                .toMatchObject({ voice: { kind: 'custom', id: 'my-cloned-voice' }, transcription: { keyterms: ['happier', 'daemon'] } }));
        } finally { standardCleanup(); await account.dispose(); }
    });
    it.each(['approved', 'rejected', 'unavailable'] as const)('settles real provider consent without a duplicate UI writer (%s)', async consent => {
        const id = xai.providerId;
        const settings = xai.providerSettings!;
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({ voice: { providerId: id,
            providers: { [id]: { schemaVersion: settings.schemaVersion, config: settings.defaultConfig } } } }));
        vi.mocked(Modal.alert).mockClear();
        vi.mocked(Modal.confirm).mockClear();
        if (consent === 'unavailable') vi.mocked(Modal.confirm).mockRejectedValueOnce(new Error('modal unavailable'));
        else vi.mocked(Modal.confirm).mockResolvedValueOnce(consent === 'approved');
        try {
            const screen = await renderScreen(<VoiceFields paths={['resumptionEnabled']} />);
            const toggle = screen.findAllByType(Switch)[0];
            if (!toggle) throw new Error('Privacy control missing');
            let eventResult: unknown;
            await act(async () => { eventResult = toggle.props.onValueChange(true); });
            expect(eventResult).toBeUndefined();
            await vi.waitFor(() => expect(Modal.confirm).toHaveBeenCalledTimes(1));
            if (consent === 'approved') await vi.waitFor(() => expect(readVoiceProviderSettingsConfig(account.persistedSettings.voice, id)?.resumptionEnabled).toBe(true));
            else {
                await vi.waitFor(() => expect(Modal.alert).toHaveBeenCalled());
                expect(readVoiceProviderSettingsConfig(account.persistedSettings.voice, id)?.resumptionEnabled).toBe(false);
                expect(account.writes).toEqual([]);
            }
        } finally { standardCleanup(); await account.dispose(); }
    });
});
