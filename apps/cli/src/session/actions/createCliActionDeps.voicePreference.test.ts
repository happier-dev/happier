import { describe, expect, it } from 'vitest';
import { VoiceProviderContributionSchema } from '@happier-dev/protocol/plugins/contributions/voice';
import { createCliActionDeps } from './createCliActionDeps';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';

describe('CLI Session voice preference declaration admission', () => {
  it('recognizes local model voice choices while refusing model/speed or custom-shape overrides at that same declared owner', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const deps = createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId: 'session', mode: 'plain', ctx: null,
      serverId: 'home', serverHttpBaseUrl: 'https://local-voice-preference-cli.test' });
    for (const settingFieldPath of ['model', 'speed']) {
      expect(await deps.sessionStateFieldSet?.({ context: { surface: 'cli' }, actionId: 'session.voice.preference.set',
        sessionId: 'session', serverId: 'home', expectedMetadataRevision: 1, fieldId: 'intent.voicePreference',
        value: { providerContributionId: 'happier.voice.builtin/local-neural', settingFieldPath, value: 'other' },
      })).toMatchObject({ ok: false, errorCode: 'voice_missing' });
    }
    expect(await deps.sessionStateFieldSet?.({ context: { surface: 'cli' }, actionId: 'session.voice.preference.set',
      sessionId: 'session', serverId: 'home', expectedMetadataRevision: 1, fieldId: 'intent.voicePreference',
      value: { providerContributionId: 'happier.voice.builtin/local-neural', settingFieldPath: 'voiceId', value: { kind: 'custom', id: 'arbitrary' } },
    })).toMatchObject({ ok: false, errorCode: 'invalid_value' });
  });
  it('admits standalone declaration validation without activating a daemon or requiring a live registry lease', async () => {
    const registry = await resolveMergedContributionRegistry();
    const entry = registry.voiceProviders.find(entry => entry.identity.pluginId === 'happier.voice.openai' && entry.definition.kind === 'conversation');
    if (!entry) throw new Error('Missing current OpenAI declaration');
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const deps = createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId: 'session', mode: 'plain', ctx: null,
      serverId: 'home', serverHttpBaseUrl: 'https://voice-preference-cli.test' });
    expect(await deps.sessionStateFieldSet?.({ context: { surface: 'cli' }, actionId: 'session.voice.preference.set',
      sessionId: 'session', serverId: 'home', expectedMetadataRevision: 1, fieldId: 'intent.voicePreference',
      value: { providerContributionId: `${entry.identity.pluginId}/${entry.identity.localId}`, settingFieldPath: 'model', value: 'other' },
    })).toMatchObject({ ok: false, errorCode: 'voice_missing' });
  });
  it('rejects nonvoice writes before metadata transport through the current admitted declaration input', async () => {
    const declaration = VoiceProviderContributionSchema.parse({ id: 'conversation', kind: 'conversation', title: 'Voice',
      roles: ['conversation_stt', 'conversation_tts', 'realtime_conversation', 'turn_control'], platforms: ['web'],
      capabilities: { turn: { cancelResponse: false, bargeIn: false } },
      client: { artifactId: 'client', exportName: 'activate' },
      settings: { schemaVersion: 2, fields: [{ id: 'voice', title: 'Voice', default: 'calm',
        schema: { type: 'string', maxLength: 256 }, presentation: { control: 'text' } }],
        presentation: { kind: 'voice.provider-settings.v1', modes: ['byo'], credential: { kind: 'none', catalog: null }, links: {},
          fields: [{ kind: 'voice_catalog', path: 'voice', valueShape: 'string', customIdAllowed: true }] } },
    });
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const params = { token, credentials: { token, encryption: null }, sessionId: 'session', mode: 'plain' as const, ctx: null,
      serverId: 'home', serverHttpBaseUrl: 'https://voice-preference-cli.test',
      readPluginVoiceProviders: () => [{ identity: { pluginId: 'acme.voice', localId: 'conversation' }, definition: declaration }],
    };
    const deps = createCliActionDeps(params);
    const result = await deps.sessionStateFieldSet?.({ context: { surface: 'cli' }, actionId: 'session.voice.preference.set',
      sessionId: 'session', serverId: 'home', expectedMetadataRevision: 1, fieldId: 'intent.voicePreference',
      value: { providerContributionId: 'acme.voice/conversation', settingFieldPath: 'model', value: 'other' },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'voice_missing' });
  });
});
