import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, renderScreen } from '@/dev/testkit';
import { installLocalSttProviderCommonModuleMocks } from '../localStt/providers/localSttProviderTestHelpers';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installLocalSttProviderCommonModuleMocks();

type CatalogRows = readonly Readonly<{
  id: string;
  name: string;
  metadata: Readonly<Record<string, unknown>>;
}>[];

const fetchCatalog = vi.fn(async (_entry: unknown, catalog: string): Promise<CatalogRows> => catalog === 'models'
  ? [{ id: 'gemini-test', name: 'Gemini Test', metadata: {} }]
  : [{ id: 'en-US-Test-A', name: 'English Test', metadata: {} }]);
const executionMachine = {
  machineId: 'machine-a' as string | null,
  machineLabel: 'Machine A' as string | null,
};
const credentialPresentation = {
  exists: true,
  credentialIdentity: 'account-secret-a' as string | null,
};

vi.mock('@/voice/credentials/bundledSpeechClient', () => ({
  bundledSpeechDaemonClient: {
    fetchCatalog,
    synthesize: vi.fn(),
  },
}));

vi.mock('@/voice/credentials/CredentialItem', () => ({
  VoiceCredentialItem: (props: {
    onStatusChanged?: (status: {
      exists: boolean;
      source: 'account' | null;
      credentialIdentity: string | null;
    }) => void;
  }) => {
    React.useEffect(() => {
      props.onStatusChanged?.({
        exists: credentialPresentation.exists,
        source: credentialPresentation.exists ? 'account' : null,
        credentialIdentity: credentialPresentation.credentialIdentity,
      });
    }, [props.onStatusChanged]);
    return React.createElement('VoiceCredentialItem', props);
  },
}));

vi.mock('@/voice/credentials/useExecutionMachinePresentation', () => ({
  useVoiceExecutionMachinePresentation: () => ({ ...executionMachine }),
}));

vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: object) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
  DropdownMenu: (props: object) => React.createElement('DropdownMenu', props),
}));

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

describe('BundledSpeechSettings', () => {
  beforeEach(() => {
    executionMachine.machineId = 'machine-a';
    executionMachine.machineLabel = 'Machine A';
    credentialPresentation.exists = true;
    credentialPresentation.credentialIdentity = 'account-secret-a';
    fetchCatalog.mockReset();
    fetchCatalog.mockImplementation(async (_entry: unknown, catalog: string): Promise<CatalogRows> => catalog === 'models'
      ? [{ id: 'gemini-test', name: 'Gemini Test', metadata: {} }]
      : [{ id: 'en-US-Test-A', name: 'English Test', metadata: {} }]);
  });

  it('renders package-owned STT fields and writes the provider envelope', async () => {
    const { createBundledLocalSttProviderSpec } = await import('./BundledSpeechSettings');
    const spec = createBundledLocalSttProviderSpec(createDefaultVoiceProviderRegistry().get('google_gemini')!);
    expect(spec).not.toBeNull();
    const setStt = vi.fn();
    const rendered = await renderScreen(React.createElement(spec!.Settings, {
      cfgStt: {
        provider: 'google_gemini',
        providers: { google_gemini: { schemaVersion: 2, config: { model: 'gemini-2.5-flash', language: null } } },
      },
      setStt,
      popoverBoundaryRef: null,
    }));
    await act(async () => undefined);
    const model = rendered.tree.root.findAllByType('DropdownMenu' as never)
      .find((row) => row.props.searchPlaceholder === 'settingsVoice.local.googleGeminiStt.model.searchPlaceholder');
    expect(model).toBeTruthy();
    expect(rendered.tree.root.findByProps({
      testID: 'voice-speech-provider-data:google_gemini',
    }).props.subtitle).toBe('settingsVoice.realtimeProviders.google.privacyDisclosure');
    await act(async () => model!.props.onSelect('gemini-test'));
    expect(setStt).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'google_gemini',
      providers: {
        google_gemini: {
          schemaVersion: 2,
          config: expect.objectContaining({ model: 'gemini-test' }),
        },
      },
    }));
  });

  it('renders package-owned TTS fields and writes voice selection without a vendor panel', async () => {
    const { createBundledLocalTtsProviderSpec } = await import('./BundledSpeechSettings');
    const spec = createBundledLocalTtsProviderSpec(createDefaultVoiceProviderRegistry().get('google_cloud')!);
    expect(spec).not.toBeNull();
    const setTts = vi.fn();
    const rendered = await renderScreen(React.createElement(spec!.Settings, {
      cfgTts: {
        provider: 'google_cloud',
        providers: { google_cloud: { schemaVersion: 2, config: { voiceName: null, languageCode: null, format: 'mp3', speakingRate: null, pitch: null } } },
      },
      setTts,
      networkTimeoutMs: 15_000,
      popoverBoundaryRef: null,
    } as never));
    await act(async () => undefined);
    const voice = rendered.tree.root.findAllByType('DropdownMenu' as never)
      .find((row) => row.props.searchPlaceholder === 'settingsVoice.local.googleCloudTts.voice.searchPlaceholder');
    expect(voice).toBeTruthy();
    await act(async () => voice!.props.onSelect('en-US-Test-A'));
    expect(setTts).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'google_cloud',
      providers: {
        google_cloud: {
          schemaVersion: 2,
          config: expect.objectContaining({ voiceName: 'en-US-Test-A' }),
        },
      },
    }));
  });

  it('marks selected-machine Google STT credentials for plain-account disclosure', async () => {
    const { createBundledLocalSttProviderSpec } = await import('./BundledSpeechSettings');
    const spec = createBundledLocalSttProviderSpec(createDefaultVoiceProviderRegistry().get('google_gemini')!);
    const rendered = await renderScreen(React.createElement(spec!.Settings, {
      cfgStt: {
        provider: 'google_gemini',
        providers: {
          google_gemini: {
            schemaVersion: 2,
            config: { model: 'gemini-2.5-flash', language: null },
          },
        },
      },
      setStt: vi.fn(),
      popoverBoundaryRef: null,
    }));
    const credential = rendered.tree.root.findByType('VoiceCredentialItem' as never);
    expect(credential.props).toMatchObject({
      providerId: 'google_gemini',
      credentialSlotId: 'api_key',
      disclosePlainStorage: true,
    });
    expect(credential.props).toHaveProperty('machineId');
    expect(credential.props).not.toHaveProperty('operations');
  });

  it('refreshes the Google catalog for credential and execution-machine changes without publishing stale results', async () => {
    const firstRequest = createDeferred<CatalogRows>();
    const credentialRequest = createDeferred<CatalogRows>();
    const machineRequest = createDeferred<CatalogRows>();
    const accountRequest = createDeferred<CatalogRows>();
    fetchCatalog
      .mockImplementationOnce(async () => await firstRequest.promise)
      .mockImplementationOnce(async () => await credentialRequest.promise)
      .mockImplementationOnce(async () => await accountRequest.promise)
      .mockImplementationOnce(async () => await machineRequest.promise);
    const { createBundledLocalSttProviderSpec } = await import('./BundledSpeechSettings');
    const spec = createBundledLocalSttProviderSpec(createDefaultVoiceProviderRegistry().get('google_gemini')!);
    const renderSettings = () => React.createElement(spec!.Settings, {
      cfgStt: {
        provider: 'google_gemini',
        providers: {
          google_gemini: {
            schemaVersion: 2,
            config: { model: 'gemini-2.5-flash', language: null },
          },
        },
      },
      setStt: vi.fn(),
      popoverBoundaryRef: null,
    });
    const rendered = await renderScreen(renderSettings());
    await vi.waitFor(() => expect(fetchCatalog).toHaveBeenCalledTimes(1));

    const credential = rendered.tree.root.findByType('VoiceCredentialItem' as never);
    act(() => credential.props.onChanged());
    await vi.waitFor(() => expect(fetchCatalog).toHaveBeenCalledTimes(2));
    await act(async () => credentialRequest.resolve([
      { id: 'credential-model', name: 'Credential model', metadata: {} },
    ]));

    credentialPresentation.credentialIdentity = 'account-secret-b';
    await rendered.update(renderSettings());
    await vi.waitFor(() => expect(fetchCatalog).toHaveBeenCalledTimes(3));
    await act(async () => accountRequest.resolve([
      { id: 'account-model', name: 'Account model', metadata: {} },
    ]));

    executionMachine.machineId = 'machine-b';
    executionMachine.machineLabel = 'Machine B';
    await rendered.update(renderSettings());
    await vi.waitFor(() => expect(fetchCatalog).toHaveBeenCalledTimes(4));
    await act(async () => machineRequest.resolve([
      { id: 'machine-model', name: 'Machine model', metadata: {} },
    ]));
    await act(async () => firstRequest.resolve([
      { id: 'stale-model', name: 'Stale model', metadata: {} },
    ]));

    const model = rendered.tree.root.findAllByType('DropdownMenu' as never)
      .find((row) => row.props.searchPlaceholder === 'settingsVoice.local.googleGeminiStt.model.searchPlaceholder');
    expect(model?.props.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'machine-model' }),
    ]));
    expect(model?.props.items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'stale-model' }),
      expect.objectContaining({ id: 'credential-model' }),
      expect.objectContaining({ id: 'account-model' }),
    ]));
  });
});
