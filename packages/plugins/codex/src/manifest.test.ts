import {
  derivePluginDaemonContributionRegistrationRights,
  ingestPluginManifestV2,
  resolvePluginManifestSetReferencesV2,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';
import { PLUGIN_MANIFEST as OPENAI_PLUGIN_MANIFEST } from '../../openai/src/manifest.js';
import { CODEX_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('Codex plugin manifest', () => {
  it('is canonical data and preserves declared runtime prerequisites', () => {
    const result = ingestPluginManifestV2(PLUGIN_MANIFEST);
    if (!result.ok) {
      throw new Error(`Expected the Codex plugin manifest to ingest: ${JSON.stringify(result.diagnostics)}`);
    }
    expect(result).toMatchObject({ ok: true });
    const openAiResult = ingestPluginManifestV2(OPENAI_PLUGIN_MANIFEST);
    if (!openAiResult.ok) {
      throw new Error(`Expected the OpenAI plugin manifest to ingest: ${JSON.stringify(openAiResult.diagnostics)}`);
    }
    expect(resolvePluginManifestSetReferencesV2([
      result.manifest,
      openAiResult.manifest,
    ])).toEqual({ ok: true });
    expect(ingestPluginManifestV2(JSON.stringify(PLUGIN_MANIFEST))).toEqual(result);
    const missingAgentResult = ingestPluginManifestV2({
      ...PLUGIN_MANIFEST,
      contributes: {
        ...PLUGIN_MANIFEST.contributes,
        agents: [],
      },
    });
    expect(missingAgentResult).toEqual({
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: 'plugin_manifest_dangling_reference',
          path: ['contributes', 'settings', 0, 'target', 'agent'],
        }),
        expect.objectContaining({
          code: 'plugin_manifest_dangling_reference',
          path: ['contributes', 'voiceProviders', 0, 'execution', 'agent'],
        }),
      ],
    });
    expect(PLUGIN_MANIFEST.contributes.settings).toEqual([
      CODEX_AGENT_SETTINGS_CONTRIBUTION,
    ]);
    expect(PLUGIN_MANIFEST.contributes.connectedAccountDescriptors).toEqual([{
      id: 'openai-codex',
      title: 'Codex',
      authentication: {
        defaultModeId: 'oauth',
        modes: [{
          id: 'oauth',
          kind: 'oauthAuthorizationCode',
          scopes: ['openid', 'profile', 'email', 'offline_access'],
          pkce: 'required',
          outcomeReconciliation: 'none',
        }, {
          id: 'device',
          kind: 'oauthDeviceCode',
          scopes: ['openid', 'profile', 'email', 'offline_access'],
          outcomeReconciliation: 'none',
        }],
      },
    }]);
    expect(derivePluginDaemonContributionRegistrationRights(
      result.manifest.contributes,
    )).toContainEqual(expect.objectContaining({
      family: 'connectedAccountDescriptors',
      localId: 'openai-codex',
    }));
    expect(PLUGIN_MANIFEST.hostAccess.required).toContainEqual(expect.objectContaining({
      id: 'openai-codex-oauth',
      capability: 'network',
      scope: {
        targets: [
          { kind: 'fixedOrigin', origin: 'https://auth.openai.com' },
          { kind: 'connectedAccountOrigin', service: 'openai-codex' },
        ],
        methods: ['POST'],
      },
    }));
    expect(PLUGIN_MANIFEST.contributes.managedDependencies).toEqual([
      expect.objectContaining({ id: 'codex-acp', executable: 'codex-acp' }),
    ]);
    expect(PLUGIN_MANIFEST.hostAccess.required.find(
      (request) => request.id === 'codex-process',
    )?.scope).toMatchObject({
      envKeys: ['CODEX_HOME'],
    });
    expect(PLUGIN_MANIFEST.contributes.hooks?.map((hook) => hook.on)).toEqual([
      'agent.resolvePrerequisites', 'agent.spawnEnv.augment',
    ]);
    expect(result.manifest.contributes.agents[0]?.connectedAccounts).toEqual([{
      purpose: 'primary',
      service: 'openai-codex',
      required: false,
      materializationKinds: ['files'],
    }]);
    expect(result.manifest.contributes.agents[0]?.capabilities.sessions.startupInstructions).toEqual({
      versions: [1],
    });
    expect(PLUGIN_MANIFEST.contributes.voiceProviders).toEqual([{
      id: 'realtime-codex',
      title: 'Codex Realtime Voice — Experimental',
      kind: 'conversation',
      roles: [
        'conversation_stt',
        'conversation_tts',
        'realtime_conversation',
        'turn_control',
      ],
      platforms: ['web', 'ios', 'android'],
      capabilities: {
        turn: { cancelResponse: false, bargeIn: false },
      },
      execution: {
        kind: 'experimental_agent_session_realtime',
        agent: 'codex',
        supportedRuntimeVersions: ['0.145.0', '0.146.0'],
      },
      settings: {
        schemaVersion: 2,
        fields: [],
        privacyDisclosure: {
          key: 'settingsVoice.realtimeProviders.codex.privacyDisclosure',
          fallback: 'Audio and the Codex Live conversation are sent from this device to OpenAI using WebRTC. The selected Codex session and Connected Services account run through the selected machine. OpenAI may receive bounded startup and session context and delegated Codex results so the conversation can continue and responses can be spoken. Happier’s server and relay do not carry Codex Live audio; the Happier daemon/app-server still carries signaling, session lifecycle, delegation, tools, and permission control. Provider-operated network relays may participate. Codex or OpenAI may retain developer instructions, realtime conversation material, and related diagnostics in provider-native runtime storage according to the selected account and provider policies; Happier does not delete or rewrite that provider-native data.',
        },
        connectedServicesBinding: {
          id: 'globalConnectedServices',
          title: 'Codex account',
          description: 'Connected Service account used by global Codex Voice sessions.',
          agent: 'codex',
          serviceIds: ['openai-codex'],
        },
      },
      client: {
        artifactId: 'voice-runtime-web',
        modulePath: './ui/voice',
        exportName: 'activate',
      },
    }]);
    const disclosure = PLUGIN_MANIFEST.contributes.voiceProviders[0]?.settings?.privacyDisclosure;
    const fallback = typeof disclosure === 'string' ? disclosure : disclosure?.fallback ?? '';
    expect(fallback).toMatch(/selected .*account/iu);
    expect(fallback).toMatch(/provider-native runtime storage/iu);
    expect(fallback).toMatch(/may retain/iu);
    expect(fallback).toMatch(/does not delete or rewrite/iu);
  });
});
