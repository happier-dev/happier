import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../../../..');

function source(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

function sourceFilesUnder(path: string): readonly string[] {
  return readdirSync(resolve(repoRoot, path), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => relative(repoRoot, resolve(entry.parentPath, entry.name)))
    .sort();
}

describe('bundled voice runtime contract ownership', () => {
  it('keeps the UI host and public leaves on UI-owned or public SDK contracts', () => {
    const hostBridge = source('apps/ui/sources/voice/registry/createBundledRealtimeProviderRuntime.ts');
    const elevenLabsRuntime = source('packages/plugins/elevenlabs/src/ui/voice/runtime.ts');
    const openAiRuntime = source('packages/plugins/openai/src/ui/voice/runtime.ts');
    const xaiRuntime = source('packages/plugins/xai/src/ui/voice/runtime.ts');
    const codexRuntime = source('packages/plugins/codex/src/ui/voice/runtime.ts');
    const elevenLabsPackage = source('packages/plugins/elevenlabs/package.json');
    const uiPackage = source('apps/ui/package.json');

    expect(hostBridge).not.toContain("from '@happier-dev/bundled-voice-runtime-contract'");
    expect(hostBridge).toContain("from '@happier-dev/plugin-sdk/voice/client'");
    expect(elevenLabsRuntime).toContain("from '@happier-dev/plugin-sdk/voice/client'");
    expect(openAiRuntime).toContain("from '@happier-dev/plugin-sdk/voice/client'");
    expect(openAiRuntime).not.toContain("from '@happier-dev/bundled-voice-runtime-contract'");
    expect(xaiRuntime).toContain("from '@happier-dev/plugin-sdk/voice/client'");
    expect(xaiRuntime).not.toContain("from '@happier-dev/bundled-voice-runtime-contract'");
    expect(codexRuntime).toContain("from '@happier-dev/plugin-sdk/voice/client'");
    expect(codexRuntime).not.toContain("from '@happier-dev/bundled-voice-runtime-contract'");
    expect(elevenLabsPackage).toContain('"@happier-dev/plugin-sdk": "0.0.0"');
    expect(uiPackage).not.toContain('"@happier-dev/bundled-voice-runtime-contract"');
  });

  it('keeps ActionSpec input-schema projection at the UI host-owned Protocol boundary', () => {
    const runtimeHost = source(
      'apps/ui/sources/voice/registry/bundledConversationRuntimeHost.ts',
    );

    expect(runtimeHost).toContain('zodSchemaToJsonSchemaObject');
    expect(runtimeHost).toContain(
      'inputSchema: Parameters<typeof zodSchemaToJsonSchemaObject>[0]',
    );
    expect(runtimeHost).toContain(
      'VoiceRealtimeJsonValueSchema.parse(zodSchemaToJsonSchemaObject(inputSchema))',
    );
    expect(runtimeHost).not.toContain("import { defineSchema } from '@happier-dev/plugin-sdk';");
    expect(runtimeHost).not.toContain('defineSchema(inputSchema)');
  });

  it('keeps provider production leaves independent from host presentation and diagnostic envelopes', () => {
    const providerIds = [
      'codex',
      'elevenlabs',
      'google',
      'openai',
      'openai-compat',
      'xai',
    ] as const;

    for (const providerId of providerIds) {
      const productionFiles = sourceFilesUnder(
        `packages/plugins/${providerId}/src`,
      );
      for (const productionFile of productionFiles) {
        expect(source(productionFile), productionFile).not.toContain(
          "from '@happier-dev/bundled-voice-runtime-contract'",
        );
      }
      expect(source(`packages/plugins/${providerId}/package.json`)).not.toContain(
        '"@happier-dev/bundled-voice-runtime-contract"',
      );
    }
  });

  it('does not widen controller input or retain the ElevenLabs duplicate owner', () => {
    const hostBridge = source('apps/ui/sources/voice/registry/createBundledRealtimeProviderRuntime.ts');
    const elevenLabsRuntime = source('packages/plugins/elevenlabs/src/ui/voice/runtime.ts');
    const elevenLabsTypes = resolve(
      repoRoot,
      'packages/plugins/elevenlabs/src/ui/voice/runtime/types.ts',
    );
    const elevenLabsPrivateRuntime = resolve(
      repoRoot,
      'packages/plugins/elevenlabs/src/ui/voice/runtime/realtimeElevenLabsRuntime.ts',
    );

    expect(hostBridge).not.toContain('Readonly<Record<string, unknown>>');
    expect(elevenLabsRuntime).not.toContain('createConversationController');
    expect(elevenLabsRuntime).not.toContain('createStorageMirror');
    expect(elevenLabsRuntime).not.toContain('BundledVoiceRuntimeMachinePort');
    expect(() => readFileSync(elevenLabsTypes, 'utf8')).toThrow();
    expect(() => readFileSync(elevenLabsPrivateRuntime, 'utf8')).toThrow();
  });

  it('keeps generated conversation composition on public activation without a private adapter factory', () => {
    const contract = source('apps/ui/sources/voice/registry/bundledConversationRuntimeContract.ts');
    const generatedEntries = source(
      'apps/ui/sources/voice/registry/generatedBundledVoiceRuntimeEntries.ts',
    );
    const composition = source('apps/ui/sources/voice/registry/bundledConversationRuntimes.ts');

    expect(generatedEntries).toContain('BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES');
    expect(generatedEntries).toContain('BundledConversationRuntimeEntry');
    expect(generatedEntries).not.toContain('BundledConversationRuntimeHost');
    expect(composition).toContain('BundledVoiceRuntimeContribution');
    expect(contract).not.toContain('BundledVoiceConversationRuntimeEntry');
    expect(contract).not.toContain('CreateBundledVoiceConversationRuntime');
    expect(composition).not.toContain('BundledVoiceConversationRuntimeEntry');
    expect(composition).not.toContain('entry.internal.createAdapter');
    expect(generatedEntries).not.toContain('BUNDLED_VOICE_CONVERSATION_RUNTIME_ENTRIES');
    expect(composition).not.toContain('type BundledConversationRuntime =');
    expect(composition).not.toContain('bundledEntries: readonly unknown[]');
    expect(composition).not.toContain('raw.internal.createAdapter as');
    expect(composition).not.toContain('runtime as BundledConversationRuntime');
  });

  it('keeps first-party and packed conversation providers on the one public activation route', () => {
    const hostContract = source('apps/ui/sources/voice/registry/bundledConversationRuntimeContract.ts');
    const runtimeHost = source(
      'apps/ui/sources/voice/registry/bundledConversationRuntimeHost.ts',
    );
    const openAiVoice = [
      source('packages/plugins/openai/src/ui/voice/index.ts'),
      source('packages/plugins/openai/src/ui/voice/entries.ts'),
    ].join('\n');
    const elevenLabsVoice = source('packages/plugins/elevenlabs/src/ui/voice/index.ts');
    const xaiVoice = [
      source('packages/plugins/xai/src/ui/voice/index.ts'),
      source('packages/plugins/xai/src/ui/voice/entries.ts'),
    ].join('\n');
    const codexVoice = [
      source('packages/plugins/codex/src/ui/voice/index.ts'),
      source('packages/plugins/codex/src/ui/voice/entries.ts'),
    ].join('\n');
    const openAiClient = resolve(repoRoot, 'packages/plugins/openai/src/ui/voice/client.ts');
    const generatedEntries = source(
      'apps/ui/sources/voice/registry/generatedBundledVoiceRuntimeEntries.ts',
    );
    const composition = source('apps/ui/sources/voice/registry/bundledConversationRuntimes.ts');
    const installedActivation = source(
      'apps/ui/sources/voice/registry/projectedExternalVoiceProviderActivation.ts',
    );
    const publicActivationScope = source(
      'apps/ui/sources/voice/registry/externalVoiceProviderActivation.ts',
    );
    const generator = source('scripts/migrations/extensions/generateBundledPluginEntries.ts');

    for (const providerLeaf of [openAiVoice, elevenLabsVoice, xaiVoice, codexVoice]) {
      expect(providerLeaf).toMatch(/export\s*\{\s*activate/);
      expect(providerLeaf).not.toContain('BUNDLED_VOICE_PROVIDER_ACTIVATION_ENTRIES');
      expect(providerLeaf).not.toContain('BUNDLED_VOICE_CONVERSATION_RUNTIME_ENTRIES');
    }
    for (const genericHost of [composition, installedActivation, publicActivationScope]) {
      expect(genericHost).not.toMatch(
        /happier\.voice\.(?:elevenlabs|openai|xai)|happier\.agent\.codex|realtime[_-](?:elevenlabs|openai|xai|codex|grok)/,
      );
    }
    expect(openAiVoice).not.toContain('BUNDLED_VOICE_CONVERSATION_RUNTIME_ENTRIES');
    expect(openAiVoice).not.toContain("from './client.js'");
    expect(openAiVoice).not.toContain('createClient:');
    expect(openAiVoice).not.toContain("export * from './client.js'");
    expect(hostContract).not.toContain('mintWebRtcAuth');
    expect(hostContract).not.toContain('@happier-dev/bundled-voice-runtime-contract');
    expect(() => readFileSync(openAiClient, 'utf8')).toThrow();
    expect(generatedEntries).not.toContain('BUNDLED_VOICE_PROVIDER_ACTIVATION_ENTRIES');
    expect(composition).not.toContain('activateBundledVoiceProviderLeaf');
    expect(composition).not.toContain('resolveAccountOperationRoute');
    expect(composition).not.toContain('hostedConversationAuthorized');
    expect(generator).not.toContain('usesPublicVoiceProviderActivation');
    expect(installedActivation).toContain('createExternalVoiceProviderActivationScope');
    expect(installedActivation).toContain('executableHost.activate');
    expect(runtimeHost).not.toContain('createRealtimeProviderRuntime');
  });

  it('separates inert metadata from platform-applicable executable activation roots', () => {
    const metadataEntries = source(
      'apps/ui/sources/voice/registry/generatedBundledVoiceEntries.ts',
    );
    const webRuntimeEntries = source(
      'apps/ui/sources/voice/registry/generatedBundledVoiceRuntimeEntries.ts',
    );
    const nativeRuntimeEntries = [
      source('apps/ui/sources/voice/registry/generatedBundledVoiceRuntimeEntries.ios.ts'),
      source('apps/ui/sources/voice/registry/generatedBundledVoiceRuntimeEntries.android.ts'),
    ];
    const registration = source(
      'apps/ui/sources/voice/adapters/registerBuiltinVoiceAdapters.ts',
    );
    const nativeMetadataLeaves = [
      ['codex', source('packages/plugins/codex/package.json')],
      ['elevenlabs', source('packages/plugins/elevenlabs/package.json')],
      ['openai', source('packages/plugins/openai/package.json')],
      ['xai', source('packages/plugins/xai/package.json')],
    ] as const;

    expect(metadataEntries).toContain('BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS');
    expect(metadataEntries).toContain('BUNDLED_FIRST_PARTY_VOICE_PRESENTATIONS');
    expect(metadataEntries).not.toContain('activate as');
    expect(metadataEntries).not.toContain('BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES');
    expect(webRuntimeEntries).toContain('activate as OPENAI_BUNDLED_VOICE_ACTIVATE');
    expect(webRuntimeEntries).toContain('activate as ELEVENLABS_BUNDLED_VOICE_ACTIVATE');
    expect(webRuntimeEntries).toContain('activate as XAI_BUNDLED_VOICE_ACTIVATE');
    expect(webRuntimeEntries).toContain('activate as CODEX_BUNDLED_VOICE_ACTIVATE');
    for (const nativeRuntimeEntry of nativeRuntimeEntries) {
      expect(nativeRuntimeEntry).toContain('activate as OPENAI_BUNDLED_VOICE_ACTIVATE');
      expect(nativeRuntimeEntry).toContain('activate as CODEX_BUNDLED_VOICE_ACTIVATE');
      expect(nativeRuntimeEntry).toContain('activate as ELEVENLABS_BUNDLED_VOICE_ACTIVATE');
      expect(nativeRuntimeEntry).toContain('activate as XAI_BUNDLED_VOICE_ACTIVATE');
    }
    expect(registration).toContain(
      "from '@/voice/registry/generatedBundledVoiceRuntimeEntries'",
    );
    for (const [packageId, packageJson] of nativeMetadataLeaves) {
      expect(packageJson).toContain(
        '"react-native": "./dist/ui/voice/index.native.js"',
      );
      const nativeLeaf = source(
        `packages/plugins/${packageId}/src/ui/voice/index.native.ts`,
      );
      expect(nativeLeaf).toContain('VOICE_PROVIDER_PRESENTATIONS');
      expect(nativeLeaf).toContain('activate');
      expect(nativeLeaf).not.toContain('createRuntimeContribution');
    }
  });

  it('projects ElevenLabs through the public Voice leaf without retaining its private adapter callback', () => {
    const elevenLabsVoice = source('packages/plugins/elevenlabs/src/ui/voice/index.ts');
    const generatedEntries = source('apps/ui/sources/voice/registry/generatedBundledVoiceEntries.ts');
    const runtimeHost = source('apps/ui/sources/voice/registry/bundledConversationRuntimeHost.ts');
    const runtimeContract = source('apps/ui/sources/voice/registry/bundledConversationRuntimeContract.ts');
    const voiceQaStore = source('apps/ui/sources/voice/qa/voiceQaStore.ts');
    const elevenLabsDiagnostics = resolve(
      repoRoot,
      'packages/plugins/elevenlabs/src/ui/voice/runtime/elevenLabsDiagnostics.ts',
    );

    expect(elevenLabsVoice).not.toContain('BUNDLED_VOICE_PROVIDER_ACTIVATION_ENTRIES');
    expect(elevenLabsVoice).not.toContain('BUNDLED_VOICE_CONVERSATION_RUNTIME_ENTRIES');
    expect(elevenLabsVoice).not.toContain('createAdapter: createElevenLabsRuntimeContribution');
    expect(elevenLabsVoice).not.toContain('createAccountOperationClient');
    expect(elevenLabsVoice).not.toContain('createAutoprovision');
    expect(elevenLabsVoice).not.toContain('createClient: createElevenLabsVoiceUiClient');
    expect(runtimeHost).not.toContain('createProviderClient');
    expect(generatedEntries).not.toContain('ELEVENLABS_BUNDLED_VOICE_PROVIDER_ACTIVATION_ENTRIES');
    expect(generatedEntries).not.toContain('ELEVENLABS_BUNDLED_VOICE_CONVERSATION_RUNTIME_ENTRIES');
    expect(runtimeContract).not.toContain('BundledVoiceProviderDiagnosticEvent');
    expect(runtimeContract).not.toContain('CreateBundledRealtimeProviderRuntimeContribution');
    expect(runtimeContract).not.toContain('appendProviderEvent');
    expect(runtimeHost).not.toContain('appendRealtimeProviderEvent');
    expect(voiceQaStore).not.toContain('provider.event');
    expect(elevenLabsVoice).not.toContain('createElevenLabsProviderDiagnosticEvent');
    expect(() => readFileSync(elevenLabsDiagnostics, 'utf8')).toThrow();
  });

  it('projects xAI through the public Voice leaf activation without retaining its private adapter callback', () => {
    const xaiVoice = [
      source('packages/plugins/xai/src/ui/voice/index.ts'),
      source('packages/plugins/xai/src/ui/voice/entries.ts'),
    ].join('\n');
    const conversationClient = source('apps/ui/sources/voice/credentials/bundledConversationClient.ts');
    const hostContract = source('apps/ui/sources/voice/registry/bundledConversationRuntimeContract.ts');
    const generatedEntries = source('apps/ui/sources/voice/registry/generatedBundledVoiceEntries.ts');
    const composition = source('apps/ui/sources/voice/registry/bundledConversationRuntimes.ts');

    expect(xaiVoice).not.toContain('BUNDLED_VOICE_PROVIDER_ACTIVATION_ENTRIES');
    expect(xaiVoice).not.toContain('createAccountOperationClient');
    expect(xaiVoice).not.toContain('createClient:');
    expect(xaiVoice).not.toContain('BUNDLED_VOICE_CONVERSATION_RUNTIME_ENTRIES');
    expect(xaiVoice).not.toContain('createAdapter: createXaiRealtimeRuntimeContribution');
    expect(xaiVoice).not.toContain('XaiRealtimeRuntimeHost');
    expect(conversationClient).not.toContain('materializeAccountVoiceCredential');
    expect(conversationClient).not.toContain('internal.createClient');
    expect(hostContract).not.toContain('materializeSecret');
    expect(generatedEntries).not.toContain('XAI_BUNDLED_VOICE_PROVIDER_ACTIVATION_ENTRIES');
    expect(generatedEntries).not.toContain('XAI_BUNDLED_VOICE_CONVERSATION_RUNTIME_ENTRIES');
    expect(composition).not.toContain('activateBundledVoiceProviderLeaf');
  });

  it('projects Codex through the public Voice leaf with declaration-derived Agent-session execution', () => {
    const codexVoice = [
      source('packages/plugins/codex/src/ui/voice/index.ts'),
      source('packages/plugins/codex/src/ui/voice/entries.ts'),
    ].join('\n');
    const generatedEntries = source('apps/ui/sources/voice/registry/generatedBundledVoiceEntries.ts');
    const runtimeHost = source('apps/ui/sources/voice/registry/bundledConversationRuntimeHost.ts');
    const runtimeHostContract = source(
      'apps/ui/sources/voice/registry/bundledConversationRuntimeContract.ts',
    );
    const boundService = source(
      'apps/ui/sources/voice/runtime/agentRealtime/createAgentSessionRealtimeService.ts',
    );
    const externalActivation = source('apps/ui/sources/voice/registry/externalVoiceProviderActivation.ts');

    expect(codexVoice).not.toContain('BUNDLED_VOICE_PROVIDER_ACTIVATION_ENTRIES');
    expect(codexVoice).toContain('VOICE_PROVIDER_PRESENTATIONS');
    expect(codexVoice).not.toContain('declaration:');
    expect(generatedEntries).toContain('projectBundledVoiceManifestContributions(CODEX_PLUGIN_MANIFEST)');
    expect(codexVoice).not.toContain('providerSettings');
    expect(codexVoice).not.toContain('projectSettings');
    expect(codexVoice).not.toContain(
      'createCodexRealtimeVoiceProviderRuntimeRegistration',
    );
    expect(externalActivation).toContain("execution?.kind === 'experimental_agent_session_realtime'");
    expect(externalActivation).toContain('resolveAgentRealtimeVoiceConversationBinding');
    expect(generatedEntries).not.toContain('CODEX_BUNDLED_VOICE_PROVIDER_ACTIVATION_ENTRIES');
    expect(runtimeHost).toContain('createAgentSessionRealtimeService');
    expect(runtimeHostContract).toContain('PluginVoiceAgentSessionRealtimeService');
    expect(runtimeHostContract).not.toContain('AgentSessionRealtimeConversation');
    expect(boundService).toContain('PluginVoiceAgentSessionRealtimeService');
    expect(boundService).not.toContain('AgentSessionRealtimeConversation');
    expect(runtimeHost).not.toContain('createCodexAgentRealtimeVoiceHost');
    expect(codexVoice).not.toContain('CodexVoiceBundledRuntimeHost');
    expect(runtimeHost).not.toContain("pluginId: 'happier.agent.codex'");
  });

  it('projects manifest semantics separately from qualified presentation without a private aggregate', () => {
    const generator = source('scripts/migrations/extensions/generateBundledPluginEntries.ts');
    const generatedEntries = source('apps/ui/sources/voice/registry/generatedBundledVoiceEntries.ts');
    const internalContributions = source('apps/ui/sources/voice/registry/internalContributions.ts');
    const conversationClient = source('apps/ui/sources/voice/credentials/bundledConversationClient.ts');
    const speechClient = source('apps/ui/sources/voice/credentials/bundledSpeechClient.ts');
    const speechDescriptor = source('apps/ui/sources/voice/settings/panels/bundledSpeech/descriptor.ts');

    expect(generator).not.toContain('BundledVoiceUiEntry');
    expect(generator).not.toContain('BUNDLED_FIRST_PARTY_VOICE_UI_ENTRIES');
    expect(generatedEntries).toContain('BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS');
    expect(generatedEntries).toContain('BUNDLED_FIRST_PARTY_VOICE_PRESENTATIONS');
    expect(generatedEntries).not.toContain('BundledVoiceUiEntry');
    expect(generatedEntries).not.toContain('BUNDLED_FIRST_PARTY_VOICE_UI_ENTRIES');
    expect(internalContributions).not.toContain('readonly unknown[]');
    expect(internalContributions).not.toContain('Record<string, unknown>');
    expect(conversationClient).not.toContain('as BundledConversationProviderClient');
    expect(speechClient).not.toContain('as unknown as BundledSpeechUiInternal');
    expect(speechDescriptor).not.toContain('internal: unknown');
    expect(speechDescriptor).not.toContain('Record<string, unknown>');
    expect(speechDescriptor).not.toContain('as unknown as BundledSpeechSettingsDescriptor');

    const providerPresentationLeaves = [
      source('packages/plugins/codex/src/ui/voice/entries.ts'),
      source('packages/plugins/elevenlabs/src/ui/voice/index.ts'),
      source('packages/plugins/google/src/ui/voice/index.ts'),
      source('packages/plugins/openai/src/ui/voice/entries.ts'),
      source('packages/plugins/openai-compat/src/ui/voice/index.ts'),
      source('packages/plugins/xai/src/ui/voice/entries.ts'),
    ];
    for (const presentationLeaf of providerPresentationLeaves) {
      expect(presentationLeaf).toContain('VOICE_PROVIDER_PRESENTATIONS');
      expect(presentationLeaf).not.toContain('BUNDLED_VOICE_UI_ENTRIES');
      expect(presentationLeaf).not.toContain('declaration:');
    }
  });

  it('keeps bundled speech UI projection on one host invocation seam without Google-owned RPC selection', () => {
    const contract = source('apps/ui/sources/voice/registry/bundledConversationRuntimeContract.ts');
    const googleVoice = source('packages/plugins/google/src/ui/voice/index.ts');
    const speechClient = source('apps/ui/sources/voice/credentials/bundledSpeechClient.ts');
    const speechRpc = source('apps/cli/src/api/machine/rpcHandlers.voiceSpeech.ts');

    expect(contract).not.toContain('speechTarget');
    expect(contract).not.toContain('BundledVoiceSpeechRpcMethod');
    expect(googleVoice).toContain("providerId: 'happier.voice.google/gemini-stt'");
    expect(googleVoice).toContain("providerId: 'happier.voice.google/google-cloud-tts'");
    expect(googleVoice).not.toContain('declaration:');
    expect(googleVoice).not.toContain('speechTarget');
    expect(googleVoice).not.toContain('RPC_METHODS');
    expect(googleVoice).not.toContain('methods:');
    expect(speechClient).toContain('DAEMON_VOICE_SPEECH_CATALOG');
    expect(speechClient).toContain('localId: entry.declaration.id');
    expect(speechClient).not.toContain('DAEMON_VOICE_GOOGLE_');
    expect(speechRpc).not.toContain('GOOGLE_SPEECH_CONTRIBUTION');
    expect(speechRpc).toContain('voiceSpeechProviders?.read(target)');
  });

  it('keeps OpenAI-compatible speech owned by package declarations without a predecessor host entry', () => {
    const openAiCompatVoice = source('packages/plugins/openai-compat/src/ui/voice/index.ts');
    const builtInEntries = source('apps/ui/sources/voice/registry/builtInEntries.ts');
    const credentialReadiness = source('apps/ui/sources/voice/registry/speechCredentialReadiness.ts');

    expect(openAiCompatVoice).toContain("providerId: 'happier.voice.openai-compat/stt'");
    expect(openAiCompatVoice).toContain("providerId: 'happier.voice.openai-compat/tts'");
    expect(openAiCompatVoice).not.toContain('declaration:');
    expect(openAiCompatVoice).not.toContain('localId:');
    expect(openAiCompatVoice).not.toContain('roles:');
    expect(openAiCompatVoice).not.toContain('requirements:');
    expect(openAiCompatVoice).not.toContain('activate');
    expect(builtInEntries).not.toContain("providerId: 'openai_compat'");
    expect(credentialReadiness).not.toContain("entry.providerId === 'openai_compat'");
    expect(credentialReadiness).not.toContain("entry.providerId !== 'openai_compat'");
    expect(credentialReadiness).not.toContain("pluginId: 'happier.voice.openai-compat'");
  });
});
