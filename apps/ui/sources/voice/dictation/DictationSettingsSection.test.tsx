import * as React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { createVoiceSettingsAccountTestHarness, withVoiceSettingsCredentialResource } from '@/voice/settings/panels/voiceSettingsAccountTestHarness';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { refreshSavedSecretCatalog } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { storage } from '@/sync/domains/state/storage';
import { DaemonVoiceClientRawCredentialAuthorizationInspectResponseV1Schema,
  DaemonVoiceClientRawCredentialAuthorizationRequestV1Schema } from '@happier-dev/protocol/daemon/voiceCredentials';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createHash } from 'node:crypto';
import { createDeferred, flushHookEffects, registerStandardCleanupTarget, renderScreen, waitForTestEvent } from '@/dev/testkit';
import { createMemFs, createMemNativeDownload } from '@/voice/modelPacks/installerTestFs';

import { VoiceProviderContributionSchema } from '@happier-dev/protocol/plugins/contributions/voice';

import { installVoiceSettingsPanelCommonModuleMocks } from '@/voice/settings/panels/voiceSettingsPanelTestHelpers';
import {
  commitExternalVoiceProviderRegistration,
  removeExternalVoiceProviderRegistration,
} from '@/voice/registry/externalVoiceProviderRegistrations';
import { createVoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const storageBoundary = vi.hoisted(() => ({
  platformOs: 'ios',
}));
let dictationFs = createMemFs();
vi.mock('expo-file-system', () => ({
  get Directory() { return dictationFs.fs.Directory; },
  get File() { return dictationFs.fs.File; },
  Paths: { document: 'file:///docs/' },
}));
const providerFocus = vi.hoisted(() => vi.fn());
const daemonResponse = vi.hoisted(() => vi.fn<(method: string, payload: unknown) => Promise<unknown>>());
vi.mock('socket.io-client', async (importOriginal) =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installSessionActionRpcBoundary(request => daemonResponse(request.method.slice(request.method.indexOf(':') + 1), request.params));

installVoiceSettingsPanelCommonModuleMocks({
  reactNative: async () => {
    const {
      createFocusablePressableMock,
      createReactNativeWebMock,
    } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
      Platform: {
        get OS() {
          return storageBoundary.platformOs;
        },
        select: (values: any) => values[storageBoundary.platformOs] ?? values.default,
      },
      View: (props: any) => React.createElement('View', props, props.children),
      Pressable: createFocusablePressableMock(providerFocus),
      useWindowDimensions: () => ({ width: 1024, height: 768, scale: 1, fontScale: 1 }),
    });
  },
  icons: async () => ({
    Ionicons: (props: any) => React.createElement('Ionicons', props),
  }),
  storage: async () => await vi.importActual('@/sync/domains/state/storage'),
  text: async () => await vi.importActual('@/text'),
  // These cases select/edit inline fields and inspect passive readiness; none
  // invokes a dialog. Keep the real manager/provider graph without a fake host.
  modal: async () => await vi.importActual('@/modal'),
});

vi.mock('expo-clipboard', () => ({
  setStringAsync: vi.fn(),
}));
// Vitest uses web-shaped module resolution. Select the real native entrypoint
// for this iOS render fixture without replacing its installer or readiness logic.
vi.mock('@/voice/dictation/voiceDictationNativeModelReadiness', async () =>
  await vi.importActual('@/voice/dictation/voiceDictationNativeModelReadiness.native'));

import {
  readLocalConversationVoiceSettings,
  readLocalDirectVoiceSettings,
  voiceSettingsDefaults,
  voiceSettingsParse,
  writeLocalConversationVoiceSettings,
  writeLocalDirectVoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import type { VoiceProviderLocalAvailability } from '@/voice/settings/voiceProviderLocalAvailability';

const EXTERNAL_DICTATION_STT_PROVIDER_ID = 'acme.dictation/stt';

function registerExternalDictationSttProvider(): void {
  const declaration = VoiceProviderContributionSchema.parse({
    id: 'stt',
    title: 'Acme Dictation',
    kind: 'speech',
    roles: ['dictation_stt'],
    platforms: ['ios'],
    settings: {
      schemaVersion: 2,
      fields: [{
        id: 'model',
        title: 'Model',
        schema: { type: 'string', minLength: 1, maxLength: 128 },
        default: 'acme-default',
        presentation: { control: 'text' },
      }],
    },
  });
  if (declaration.kind !== 'speech') throw new Error('expected speech declaration');
  const descriptor = createVoiceProviderRegistry({
    bundledContributions: [{
      pluginId: 'acme.dictation',
      providerId: EXTERNAL_DICTATION_STT_PROVIDER_ID,
      declaration,
    }],
    bundledPresentations: [{
      providerId: EXTERNAL_DICTATION_STT_PROVIDER_ID,
      settingsSectionId: 'voice.acme.dictation',
      createSettingsSpec: () => ({
        titleKey: 'Acme Dictation',
        subtitleKey: 'Configurable external speech',
        detailKey: 'Configurable external speech',
        iconName: 'cloud',
        fields: [{
          fieldId: 'model',
          titleKey: 'Model',
          subtitleKey: 'Model',
        }],
        test: null,
      }),
    }],
  }).get(EXTERNAL_DICTATION_STT_PROVIDER_ID);
  if (!descriptor) throw new Error('expected external Voice descriptor');
  const token = {};
  commitExternalVoiceProviderRegistration({
    token,
    pluginId: 'acme.dictation',
    localId: 'stt',
    providerId: EXTERNAL_DICTATION_STT_PROVIDER_ID,
    descriptor,
    adapter: null,
  });
  onTestFinished(() => removeExternalVoiceProviderRegistration(token));
}

const localAvailability = {
  browserSpeech: {
    support: 'available',
    onDevice: 'available',
  },
  daemon: {
    featureEnabled: true,
    route: 'direct',
    modelState: 'ready',
    runtimeState: 'available',
  },
  nativeDevice: {
    requested: true,
    speechRecognition: 'available',
  },
} as const satisfies VoiceProviderLocalAvailability;

function findRenderedItem(tree: ReturnType<typeof create>, testID: string) {
  const item = tree.root
    .findAll((node) => node.props.testID === testID)
    .at(0);
  if (!item) throw new Error(`Missing rendered Item: ${testID}`);
  return item;
}

// Load the real owner graph during collection, not inside a renderer's act/test budget.
await import('./DictationSettingsSection');


/** Dictation's readiness as the card shows it (the card is the one place the page reports it). */
function dictationCardReadiness(tree: { root: { findAll: (predicate: (node: any) => boolean) => any[] } }) {
  const card = tree.root.findAll((node) => node.props?.testID === 'settings.voice.dictation.pipeline' && node.props?.pipeline)[0];
  return card?.props.pipeline.readiness ?? null;
}

function dictationRecoverActions(tree: { root: { findAll: (predicate: (node: any) => boolean) => any[] } }) {
  return tree.root.findAll((node) => typeof node.props?.testID === 'string'
    && node.props.testID.startsWith('settings.voice.dictation.pipeline')
    && node.props.testID.endsWith('.recover')
    && typeof node.props.onPress === 'function');
}

describe('DictationSettingsSection', () => {
  it('keeps a fresh daemon Dictation choice on its current engine while Account speech policy is off', async () => {
    storageBoundary.platformOs = 'web';
    onTestFinished(() => { storageBoundary.platformOs = 'ios'; });
    expect(voiceSettingsDefaults.dictation.stt.localNeural.assetId).toBeNull();
    const { DictationSettingsSection } = await import('./DictationSettingsSection');
    const setVoice = vi.fn();
    const screen = await renderScreen(<DictationSettingsSection
      voice={voiceSettingsDefaults}
      setVoice={setVoice}
      executionMachineId="dictation-machine"
      localAvailability={{ ...localAvailability, daemon: { ...localAvailability.daemon, featureEnabled: false } }}
    />);
    const row = findRenderedItem(screen.tree, 'settings.voice.dictation.engine.local_neural');
    await act(async () => { row.props.onPress?.(); });
    expect(setVoice).not.toHaveBeenCalled();
    expect(row.props.disabled).toBe(true);

    await act(async () => {
      screen.tree.update(<DictationSettingsSection
        voice={voiceSettingsDefaults}
        setVoice={setVoice}
        executionMachineId="dictation-machine"
        localAvailability={{ ...localAvailability, daemon: { ...localAvailability.daemon, modelState: 'missing' } }}
      />);
    });
    const enabledRow = findRenderedItem(screen.tree, 'settings.voice.dictation.engine.local_neural');
    expect(enabledRow.props.disabled).toBe(false);
    await act(async () => { enabledRow.props.onPress?.(); });
    expect(setVoice).toHaveBeenCalledOnce();
    expect(setVoice.mock.calls[0]?.[0].dictation.stt.localNeural.assetId)
      .toBe('sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8');
  });

  it('keeps native-device Dictation setup selectable when daemon speech policy is off', async () => {
    const { DictationSettingsSection } = await import('./DictationSettingsSection');
    const setVoice = vi.fn();
    const screen = await renderScreen(<DictationSettingsSection
      voice={voiceSettingsDefaults}
      setVoice={setVoice}
      executionMachineId={null}
      localAvailability={{ ...localAvailability, daemon: { ...localAvailability.daemon, featureEnabled: false } }}
    />);
    const row = findRenderedItem(screen.tree, 'settings.voice.dictation.engine.local_neural');
    expect(row.props.disabled).toBe(false);
    await act(async () => { row.props.onPress?.(); });
    expect(setVoice).toHaveBeenCalledOnce();
    expect(setVoice.mock.calls[0]?.[0].dictation.stt.localNeural.assetId)
      .toBe('sherpa-onnx-streaming-zipformer-en-2023-06-26');
  });

  it('seeds an external provider default envelope atomically with an explicit Dictation selection', async () => {
    registerExternalDictationSttProvider();
    const { DictationSettingsSection } = await import('./DictationSettingsSection');
    const setVoice = vi.fn();
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<DictationSettingsSection
        voice={voiceSettingsDefaults}
        setVoice={setVoice}
        executionMachineId={null}
        localAvailability={localAvailability}
      />);
      registerStandardCleanupTarget(tree);
    });

    await act(async () => {
      findRenderedItem(tree, `settings.voice.dictation.engine.${encodeURIComponent(EXTERNAL_DICTATION_STT_PROVIDER_ID)}`).props.onPress();
    });

    expect(setVoice).toHaveBeenCalledOnce();
    expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
      dictation: expect.objectContaining({
        sttBinding: 'explicit',
        stt: expect.objectContaining({ provider: EXTERNAL_DICTATION_STT_PROVIDER_ID }),
      }),
      providers: expect.objectContaining({
        [EXTERNAL_DICTATION_STT_PROVIDER_ID]: {
          schemaVersion: 2,
          config: { model: 'acme-default' },
        },
      }),
    }));
  });

  it.each([
    ['an invalid current-version', { schemaVersion: 2, config: { model: 42 } }],
    ['a future-version', { schemaVersion: 3, config: { model: 'future', addedByFutureVersion: true } }],
  ])('does not overwrite %s external provider envelope when selecting Dictation', async (_case, envelope) => {
    registerExternalDictationSttProvider();
    const { DictationSettingsSection } = await import('./DictationSettingsSection');
    const voice = voiceSettingsParse({
      ...voiceSettingsDefaults,
      providers: {
        ...voiceSettingsDefaults.providers,
        [EXTERNAL_DICTATION_STT_PROVIDER_ID]: envelope,
      },
    });
    const setVoice = vi.fn();
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<DictationSettingsSection
        voice={voice}
        setVoice={setVoice}
        executionMachineId={null}
        localAvailability={localAvailability}
      />);
      registerStandardCleanupTarget(tree);
    });

    await act(async () => {
      findRenderedItem(tree, `settings.voice.dictation.engine.${encodeURIComponent(EXTERNAL_DICTATION_STT_PROVIDER_ID)}`).props.onPress();
    });

    expect(setVoice).toHaveBeenCalledOnce();
    expect(setVoice.mock.calls[0]?.[0].providers[EXTERNAL_DICTATION_STT_PROVIDER_ID]).toEqual(envelope);
  });

  it('keeps one Dictation language override when Dictation follows Local Voice', async () => {
    const { DictationSettingsSection } = await import('./DictationSettingsSection');
    const { OverlayPortalHost, OverlayPortalProvider, Popover } = await import('@/components/ui/popover');
    const localDirect = readLocalDirectVoiceSettings(voiceSettingsDefaults);
    const localConversation = readLocalConversationVoiceSettings(voiceSettingsDefaults);
    const voice = writeLocalConversationVoiceSettings(writeLocalDirectVoiceSettings({
      ...voiceSettingsDefaults,
      providerId: 'local_direct',
    }, {
      ...localDirect,
      stt: {
        ...localDirect.stt,
        provider: 'local_neural',
        localNeural: { ...localDirect.stt.localNeural, language: 'en' },
      },
    }), {
      ...localConversation,
      stt: {
        ...localConversation.stt,
        provider: 'happier.voice.openai-compat/stt',
      },
    });
    const dictationVoice = {
      ...voice,
      dictation: {
        ...voice.dictation,
        sttBinding: 'same_as_local' as const,
      },
    };
    const voiceChanged = createDeferred<void>();
    const setVoice = vi.fn<React.ComponentProps<typeof DictationSettingsSection>['setVoice']>(() => { voiceChanged.resolve(); });
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<OverlayPortalProvider><DictationSettingsSection
        voice={dictationVoice}
        setVoice={setVoice}
        executionMachineId={null}
        localAvailability={localAvailability}
      /><OverlayPortalHost /></OverlayPortalProvider>);
      registerStandardCleanupTarget(tree);
    });

    expect(findRenderedItem(tree, 'settings.voice.dictation.engine.same_as_local').props.selected).toBe(true);
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    const recognitionLanguage = tree.root.findAllByType(DropdownMenu).filter(node =>
      Array.isArray(node.props.items) && node.props.items.some((item: { id: string }) => item.id === '__custom__' || item.id === 'automatic'));
    expect(recognitionLanguage).toHaveLength(1);
    const languageTriggers = recognitionLanguage[0]!.findAll((node) => String(node.type) === 'Pressable'
      && node.props.accessibilityState?.expanded === false);
    expect(languageTriggers).toHaveLength(1);
    await act(async () => {
      languageTriggers[0]!.props.onPress();
    });
    await flushHookEffects({ cycles: 1, turns: 6, frames: 1 });
    expect(tree.root.findByType(Popover).props.open).toBe(true);
    // The native menu uses the shared phone sheet, which does not measure an
    // anchor. Selection through its real portal is the observable contract.
    const portalHost = tree.root.findByType(OverlayPortalHost);
    const frenchChoice = portalHost.findAll((node) => String(node.type) === 'Pressable' && node.props.testID === 'dropdown-option-fr-FR'
      && typeof node.props.onPress === 'function')[0];
    if (!frenchChoice) throw new Error('Missing French choice in native portal');
    await act(async () => {
      frenchChoice.props.onPress();
    });
    await flushHookEffects({ cycles: 1, turns: 6, frames: 1 });
    expect(tree.root.findAllByType(Popover)).toHaveLength(0);
    await voiceChanged.promise;
    expect(setVoice).toHaveBeenCalledOnce();
    expect(setVoice.mock.calls[0]![0].dictation.language).toBe('fr-FR');
    expect(setVoice.mock.calls[0]![0].dictation.sttBinding).toBe('same_as_local');
    expect(readLocalDirectVoiceSettings(setVoice.mock.calls[0]![0])).toEqual(readLocalDirectVoiceSettings(dictationVoice));
    expect(readLocalConversationVoiceSettings(setVoice.mock.calls[0]![0]).stt.provider)
      .toBe('happier.voice.openai-compat/stt');
    expect(readLocalConversationVoiceSettings(setVoice.mock.calls[0]![0])).toEqual(readLocalConversationVoiceSettings(dictationVoice));
  });

  it('renders only the explicitly selected provider details and checks readiness passively', async () => {
    const { DictationSettingsSection } = await import('./DictationSettingsSection');
    const voice = {
      ...voiceSettingsDefaults,
      dictation: {
        ...voiceSettingsDefaults.dictation,
        sttBinding: 'explicit' as const,
        stt: {
          ...voiceSettingsDefaults.dictation.stt,
          provider: 'device' as const,
        },
      },
    };
    const setVoice = vi.fn();
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<DictationSettingsSection
        voice={voice}
        setVoice={setVoice}
        executionMachineId={null}
        localAvailability={localAvailability}
      />);
      registerStandardCleanupTarget(tree);
    });

    expect(findRenderedItem(tree, 'settings.voice.dictation.engine.device').props.selected).toBe(true);
    const { getLocalSttProviderSpec } = await import('@/voice/settings/panels/localStt/providers/registry');
    const device = getLocalSttProviderSpec('device');
    const neural = getLocalSttProviderSpec('local_neural');
    if (!device || !neural) throw new Error('expected built-in speech engines');
    if (!neural.Settings) throw new Error('expected neural speech options');
    expect(tree.root.findAllByType(neural.Settings)).toHaveLength(0);
    // Device speech has no options, so no empty options section titled after it renders; unselected
    // neural/endpoint detail is absent.
    expect(tree.root.findAll((node) => node.props.title === device.title && typeof node.props.description === 'string')).toHaveLength(0);
    expect(tree.root.findAll(node => node.props.fieldTestID === 'settings.voice.localNeuralStt.language.custom.field'
      || (typeof node.props.testID === 'string' && node.props.testID.startsWith('voice-speech-setting:')))).toHaveLength(0);
    await act(async () => {
    });
    expect(dictationCardReadiness(tree)?.status).toBe('ready');
    expect(tree.root.findAll((node) => node.props.testID === 'settings.voice.dictation.readiness')).toHaveLength(0);
    expect(setVoice).not.toHaveBeenCalled();
  });

  it('says which unselected engine needs you before it can be chosen, and stays quiet for ready ones', async () => {
    const { DictationSettingsSection } = await import('./DictationSettingsSection');
    const voice = {
      ...voiceSettingsDefaults,
      dictation: {
        ...voiceSettingsDefaults.dictation,
        sttBinding: 'explicit' as const,
        stt: { ...voiceSettingsDefaults.dictation.stt, provider: 'device' as const },
      },
    };
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<DictationSettingsSection
        voice={voice}
        setVoice={vi.fn()}
        executionMachineId={null}
        localAvailability={localAvailability}
      />);
      registerStandardCleanupTarget(tree);
    });
    const needs = (id: string) => tree.root.findAll((node) => typeof node.type === 'string'
      && node.props.testID === `settings.voice.dictation.engine.${encodeURIComponent(id)}.needs`);
    // The OpenAI-compatible endpoint has no address yet; the same readiness owner as the card says so.
    expect(needs('happier.voice.openai-compat/stt')).toHaveLength(1);
    const needsText = needs('happier.voice.openai-compat/stt')[0]!
      .findAll((node) => typeof node.props.children === 'string').map((node) => node.props.children).join(' ');
    const { t } = await import('@/text');
    const { getLocalSttProviderSpec } = await import('@/voice/settings/panels/localStt/providers/registry');
    const endpoint = getLocalSttProviderSpec('happier.voice.openai-compat/stt');
    if (!endpoint) throw new Error('expected OpenAI-compatible speech engine');
    expect(needsText).toContain(t('voice.readiness.settings_missing_required_setting', { service: endpoint.title }));
    expect(needsText).not.toContain('voice.readiness.');
    expect(needs('device')).toHaveLength(0);
  });

  it('checks the exact selected native Local Neural pack when the page opens, once while the passive check is pending', async () => {
    const { DictationSettingsSection } = await import('./DictationSettingsSection');
    const localDirect = readLocalDirectVoiceSettings(voiceSettingsDefaults);
    const localConversation = readLocalConversationVoiceSettings(voiceSettingsDefaults);
    const withDirectPack = writeLocalDirectVoiceSettings({
      ...voiceSettingsDefaults,
      providerId: 'local_direct',
    }, {
      ...localDirect,
      stt: {
        ...localDirect.stt,
        provider: 'local_neural',
        localNeural: {
          ...localDirect.stt.localNeural,
          assetId: 'selected-direct-pack',
          execution: 'device',
        },
      },
    });
    const voice = writeLocalConversationVoiceSettings(withDirectPack, {
      ...localConversation,
      stt: {
        ...localConversation.stt,
        provider: 'local_neural',
        localNeural: {
          ...localConversation.stt.localNeural,
          assetId: 'unselected-conversation-pack',
          execution: 'device',
        },
      },
    });
    dictationFs = createMemFs();
    const bytes = new Uint8Array([1]);
    const manifest = { packId: 'selected-direct-pack', kind: 'stt_sherpa', model: 'zipformer', version: 'v1',
      files: [{ path: 'model.onnx', url: 'https://example.com/model.onnx', sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') }] };
    const fetchImpl: typeof fetch = async input => new URL(String(input)).pathname.endsWith('manifest.json')
      ? Response.json(manifest) : new Response(bytes);
    const { ensureModelPackInstalled } = await import('@/voice/modelPacks/installer.native');
    await ensureModelPackInstalled({ packId: manifest.packId, mode: 'download_if_missing',
      manifestUrl: 'https://example.com/manifest.json', timeoutMs: null, signal: new AbortController().signal },
      { fs: dictationFs.fs, fetch: fetchImpl, download: createMemNativeDownload(dictationFs.fs, fetchImpl) });
    let settleModelReadiness!: () => void;
    const pendingModelReadiness = new Promise<void>(resolve => { settleModelReadiness = resolve; });
    const readMetadata = dictationFs.fs.File.prototype.text;
    const metadataReads: string[] = [];
    const readBoundary = vi.spyOn(dictationFs.fs.File.prototype, 'text').mockImplementation(async function (this: { uri: string }) {
      metadataReads.push(this.uri);
      await pendingModelReadiness;
      return readMetadata.call(this);
    });
    onTestFinished(() => { readBoundary.mockRestore(); });
    const setVoice = vi.fn();
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<DictationSettingsSection
        voice={{
          ...voice,
          dictation: {
            ...voice.dictation,
            sttBinding: 'same_as_local',
          },
        }}
        setVoice={setVoice}
        executionMachineId={null}
        localAvailability={localAvailability}
      />);
      registerStandardCleanupTarget(tree);
    });

    // Always-on card readiness: opening the page runs the passive check; there is no "Check setup" row.
    expect(tree.root.findAll((node) => node.props.testID === 'settings.voice.dictation.checkSetup')).toHaveLength(0);
    expect(metadataReads).toEqual(['file:///docs/happier/voice/modelPacks/selected-direct-pack/pack.json']);
    // A re-render while it is pending shares the check in flight.
    await act(async () => {
      tree.update(<DictationSettingsSection
        voice={{ ...voice, dictation: { ...voice.dictation, sttBinding: 'same_as_local' } }}
        setVoice={setVoice}
        executionMachineId={null}
        localAvailability={localAvailability}
      />);
    });
    expect(metadataReads).toEqual(['file:///docs/happier/voice/modelPacks/selected-direct-pack/pack.json']);

    await act(async () => {
      settleModelReadiness();
      await Promise.resolve();
    });

    expect(dictationCardReadiness(tree)?.status).toBe('ready');
    expect(setVoice).not.toHaveBeenCalled();
  });

  it('renders unsupported web Device Dictation as unavailable from passive support facts', async () => {
    const { DictationSettingsSection } = await import('./DictationSettingsSection');
    storageBoundary.platformOs = 'web';
    onTestFinished(() => {
      storageBoundary.platformOs = 'ios';
    });
    const voice = {
      ...voiceSettingsDefaults,
      dictation: {
        ...voiceSettingsDefaults.dictation,
        sttBinding: 'explicit' as const,
        stt: {
          ...voiceSettingsDefaults.dictation.stt,
          provider: 'device' as const,
        },
      },
    };
    const setVoice = vi.fn();
    const onRecoveryAction = vi.fn();
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<DictationSettingsSection
        voice={voice}
        setVoice={setVoice}
        executionMachineId={null}
        localAvailability={{
          ...localAvailability,
          browserSpeech: {
            support: 'unavailable',
            onDevice: 'unsupported',
          },
        }}
        onRecoveryAction={onRecoveryAction}
      />);
      registerStandardCleanupTarget(tree);
    });

    await act(async () => {
    });

    expect(dictationCardReadiness(tree)).toMatchObject({ reasonKey: 'voice.readiness.device_stt_unavailable', recoveryAction: 'switch_provider' });
    await act(async () => {
      dictationRecoverActions(tree)[0]!.props.onPress();
    });
    expect(onRecoveryAction).toHaveBeenCalledWith('switch_provider');
    expect(setVoice).not.toHaveBeenCalled();

    await act(async () => {
      tree.update(<DictationSettingsSection
        voice={voice}
        setVoice={setVoice}
        executionMachineId={null}
        localAvailability={{
          ...localAvailability,
          browserSpeech: {
            support: 'unavailable',
            onDevice: 'unsupported',
          },
        }}
      />);
    });
    expect(dictationRecoverActions(tree)).toHaveLength(0);
  });

  it('returns switch-provider recovery focus to the provider control on every activation', async () => {
    const { DictationSettingsSection } = await import('./DictationSettingsSection');
    storageBoundary.platformOs = 'web';
    providerFocus.mockClear();
    onTestFinished(() => {
      storageBoundary.platformOs = 'ios';
      providerFocus.mockClear();
    });
    const voice = {
      ...voiceSettingsDefaults,
      dictation: {
        ...voiceSettingsDefaults.dictation,
        sttBinding: 'explicit' as const,
        stt: {
          ...voiceSettingsDefaults.dictation.stt,
          provider: 'device' as const,
        },
      },
    };
    const onRecoveryAction = vi.fn();
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<DictationSettingsSection
        voice={voice}
        setVoice={vi.fn()}
        executionMachineId={null}
        localAvailability={{
          ...localAvailability,
          browserSpeech: {
            support: 'unavailable',
            onDevice: 'unsupported',
          },
        }}
        onRecoveryAction={onRecoveryAction}
      />, { createNodeMock: (node) => node.props && typeof node.props === 'object' && 'testID' in node.props
        && node.props.testID === 'settings.voice.dictation.engine.device'
        ? { focus: providerFocus } : null });
      registerStandardCleanupTarget(tree);
    });
    await act(async () => {
    });

    const recovery = dictationRecoverActions(tree)[0]!;
    await act(async () => {
      recovery.props.onPress();
      recovery.props.onPress();
    });

    expect(providerFocus).toHaveBeenCalledTimes(2);
    expect(onRecoveryAction).toHaveBeenNthCalledWith(1, 'switch_provider');
    expect(onRecoveryAction).toHaveBeenNthCalledWith(2, 'switch_provider');
  });

  it('explains when daemon-backed Dictation has no policy-allowed heavy-audio route', async () => {
    const { DictationSettingsSection } = await import('./DictationSettingsSection');
    storageBoundary.platformOs = 'web';
    onTestFinished(() => {
      storageBoundary.platformOs = 'ios';
    });
    const voice = {
      ...voiceSettingsDefaults,
      dictation: {
        ...voiceSettingsDefaults.dictation,
        sttBinding: 'explicit' as const,
        stt: {
          ...voiceSettingsDefaults.dictation.stt,
          provider: 'local_neural' as const,
          localNeural: {
            ...voiceSettingsDefaults.dictation.stt.localNeural,
            execution: 'daemon' as const,
          },
        },
      },
    };
    const setVoice = vi.fn();
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<DictationSettingsSection
        voice={voice}
        setVoice={setVoice}
        executionMachineId="machine-online"
        localAvailability={{
          ...localAvailability,
          daemon: {
            ...localAvailability.daemon,
            route: 'relay_disabled',
          },
        }}
      />);
      registerStandardCleanupTarget(tree);
    });

    await act(async () => {
    });

    expect(dictationCardReadiness(tree)).toMatchObject({ reasonKey: 'voice.readiness.daemon_relay_disabled', recoveryAction: 'switch_provider' });
    expect(setVoice).not.toHaveBeenCalled();
  });

  it('reprojects checked credential readiness after the selected secret is removed', async () => {
    const { DictationSettingsSection } = await import('./DictationSettingsSection');
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    const voice = {
      ...voiceSettingsDefaults,
      dictation: {
        ...voiceSettingsDefaults.dictation,
        sttBinding: 'explicit' as const,
        stt: {
          ...voiceSettingsDefaults.dictation.stt,
          provider: 'happier.voice.google/gemini-stt' as const,
        },
      },
    };
    const entry = createDefaultVoiceProviderRegistry()
      .get('happier.voice.google/gemini-stt');
    if (entry?.kind !== 'voice.speech-engine.v1' || entry.declaration?.kind !== 'speech') {
      throw new Error('Expected Gemini STT declaration');
    }
    const declaration = entry.declaration;
    const account = await createVoiceSettingsAccountTestHarness(settingsParse({ voice }));
    onTestFinished(account.dispose);
    const ready = await withVoiceSettingsCredentialResource(account, {
      settings: account.settings, declaration, pluginId: entry.pluginId,
      resourceId: 'google-stt-secret', machineId: 'machine-online',
    });
    account.replaceSettings(ready, { version: (storage.getState().settingsVersion ?? 0) + 1 });
    const subject = { kind: 'credential_access_disclosure', contribution: { pluginId: 'happier.voice.google', localId: 'gemini-stt' },
      credentialSlotId: 'api_key', purpose: declaration.credentials!.slot.purpose,
      accessDeclarationDigest: 'b'.repeat(64), selectedAuthorityDigest: 'c'.repeat(64), selectedRawAccessDigest: 'd'.repeat(64) };
    const authoritySource = { kind: 'machine_installation', machineId: 'machine-online', installationId: 'installation-1' };
    const inspection = DaemonVoiceClientRawCredentialAuthorizationInspectResponseV1Schema.parse({ ok: true,
      authorization: { pluginId: 'happier.voice.google', capability: 'credentials.materialize.raw', targetScope: { kind: 'account' }, grantRequirement: 'linked',
        subject, authoritySource, disclosures: [{ sourceClass: { kind: 'savedSecret', secretKinds: ['apiKey'] },
          realm: 'daemon', phase: 'speech', materialization: 'httpHeaders', origin: 'https://generativelanguage.googleapis.com', destination: 'x-goog-api-key' }] },
      review: { plugin: { id: 'happier.voice.google', name: 'Google', version: '1.0.0' }, package: { identity: 'happier.voice.google' },
        distribution: { kind: 'bundled' }, publisher: { status: 'bundled_first_party', identity: 'Happier' },
        contribution: { identity: subject.contribution, name: 'Gemini STT' },
        credentialSlot: { id: 'api_key', name: 'API key', purpose: declaration.credentials!.slot.purpose } },
    });
    if (!inspection.ok) throw new Error('Expected admitted raw credential inspection fixture');
    daemonResponse.mockImplementation(async (method, payload) => {
      if (method !== RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_AUTHORIZATION_INSPECT) throw new Error(`Unexpected Dictation RPC: ${method}`);
      const request = DaemonVoiceClientRawCredentialAuthorizationRequestV1Schema.parse(payload);
      expect(request.contribution).toEqual(subject.contribution);
      expect(request.rawGrant).toMatchObject({ realm: 'daemon', phase: 'speech' });
      return inspection;
    });
    const originalRequest = account.request.getMockImplementation()!;
    account.request.mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      const machine = { ...createPlainMachineRowFixture({ id: 'machine-online', accountId: account.scope.accountId }),
        installationId: 'installation-1' };
      if (path === '/v1/machines') return Response.json([machine]);
      if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
        id => id === machine.id ? machine : null);
      if (path === '/v1/machines/machine-online') return Response.json({ machine });
      return originalRequest(url, init);
    });
    storage.getState().applyMachines([createMachineFixture({ id: 'machine-online', activeAt: Date.now(),
      storageMode: 'plain', access: createPlainMachineRowFixture({ id: 'machine-online', accountId: account.scope.accountId }).access,
    })], true, { sourceServerId: account.scope.serverId });
    await refreshSavedSecretCatalog(account.scope);
    const setVoice = vi.fn();
    let commits = 0;
    const render = (nextVoice: typeof ready.voice) => <React.Profiler id="dictation" onRender={() => { commits += 1; }}><DictationSettingsSection
      voice={nextVoice}
      setVoice={setVoice}
      executionMachineId="machine-online"
      localAvailability={localAvailability}
    /></React.Profiler>;
    const screen = await renderScreen(render(account.settings.voice));
    const tree = screen.tree;
    await flushHookEffects();
    expect(storage.getState().settings.voiceSettingsV1.credentialBindings).toEqual(ready.voiceSettingsV1.credentialBindings);
    await waitForTestEvent(screen.subscribe, () => dictationCardReadiness(tree), readiness => readiness?.status === 'ready');
    expect(dictationCardReadiness(tree)?.status).toBe('ready');
    const initialCommits = commits;
    const initialInspections = daemonResponse.mock.calls.length;
    for (let index = 0; index < 20; index += 1) {
      await act(async () => { storage.setState(state => ({
        settings: { ...state.settings, analyticsOptOut: !state.settings.analyticsOptOut },
        settingsVersion: (state.settingsVersion ?? 0) + 1,
      })); });
    }
    expect(commits - initialCommits).toBe(0);
    expect(daemonResponse.mock.calls.length - initialInspections).toBe(0);
    expect(account.resources).toHaveLength(1);
    account.resources.splice(0);
    await act(async () => {
      await refreshSavedSecretCatalog(account.scope);
    });

    expect(dictationCardReadiness(tree)).toMatchObject({ reasonKey: 'voice.readiness.credential_missing', recoveryAction: 'configure_credential' });
    expect(setVoice).not.toHaveBeenCalled();
  });
});
