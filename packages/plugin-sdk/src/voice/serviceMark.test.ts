import { describe, expect, it } from 'vitest';
import { VoiceProviderContributionSchema } from './index.public.js';

describe('public Voice service identity', () => {
  const declaration = {
    id: 'conversation', title: 'External Voice', kind: 'conversation',
    roles: ['realtime_conversation'], platforms: ['web'],
    capabilities: { turn: { cancelResponse: true, bargeIn: true }, tools: { effectCalls: 'none' } },
    client: { artifactId: 'voice', exportName: 'activate' },
  };

  it.each([
    { kind: 'connected_service', serviceId: 'openai' },
    { kind: 'agent', agentId: 'plugin:acme.agent/custom' },
    { kind: 'icon', name: 'waveform' },
    { kind: 'icon', name: 'desktop' },
  ])('preserves external authors’ service mark through the public declaration parser: $kind', (mark) => {
    expect(VoiceProviderContributionSchema.parse({ ...declaration, mark })).toMatchObject({ mark });
  });

  it('keeps declarations without art valid and rejects unknown mark fields', () => {
    expect(VoiceProviderContributionSchema.safeParse(declaration).success).toBe(true);
    expect(VoiceProviderContributionSchema.safeParse({
      ...declaration, mark: { kind: 'icon', name: 'waveform', execute: 'start' },
    }).success).toBe(false);
  });

  it('uses the same identity grammar on an independently selected Dictation speech service', () => {
    const mark = { kind: 'icon', name: 'waveform' };
    expect(VoiceProviderContributionSchema.parse({
      id: 'speech', title: 'Installed speech', kind: 'speech', roles: ['dictation_stt'], platforms: ['web'],
      mark, settings: { schemaVersion: 1, fields: [{
        id: 'model', title: 'Model', schema: { type: 'string', minLength: 1, maxLength: 128 },
        default: 'speech-model', presentation: { control: 'text' },
      }] },
    })).toMatchObject({ mark });
  });
});
