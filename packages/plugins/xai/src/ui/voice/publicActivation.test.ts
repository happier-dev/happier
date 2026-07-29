import {
  createVoiceProviderRecipientContractV1,
  ingestPluginManifestV2,
  materializeRecipientOperationRequestV1,
  PluginVoiceProviderContributionV1Schema,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { PLUGIN_MANIFEST } from '../../manifest.js';
import { activate } from './createRuntimeContribution.js';
import { BUNDLED_VOICE_UI_ENTRIES } from './index.js';

describe('xAI Realtime public Voice activation', () => {
  it('registers a schema-valid manifest-local id while preserving the stable host provider identity', () => {
    const ingested = ingestPluginManifestV2(PLUGIN_MANIFEST);
    expect(ingested.ok).toBe(true);
    expect(PLUGIN_MANIFEST.contributes.voiceProviders[0]?.id).toBe('realtime-grok');

    const register = vi.fn();
    activate({ voiceProviders: { register } });

    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]?.[0]).toBe('realtime-grok');
  });

  it('projects host-owned SavedSecret readiness without materializing it', () => {
    const projector = BUNDLED_VOICE_UI_ENTRIES[0]?.internal.projectCredentialReadiness;
    expect(projector?.({}, {
      accountProfile: {},
      savedSecret: { status: 'ready' },
    })).toMatchObject({ status: 'ready' });
    expect(projector?.({}, {
      accountProfile: {},
      savedSecret: { status: 'missing' },
    })).toMatchObject({ status: 'missing' });
  });

  it('declares one exact bounded xAI voices operation and fails closed on operation drift', () => {
    const declaration = PluginVoiceProviderContributionV1Schema.parse(
      PLUGIN_MANIFEST.contributes.voiceProviders[0],
    );
    if (declaration.kind !== 'conversation' || !declaration.accountMediation) {
      throw new Error('xai_voice_account_mediation_missing');
    }
    const contract = createVoiceProviderRecipientContractV1({
      package: {
        pluginId: PLUGIN_MANIFEST.id,
        source: { kind: 'bundled', locator: PLUGIN_MANIFEST.id },
      },
      publisher: {
        trust: 'bundled',
        identity: 'happier.dev:first-party-bundle',
      },
      contribution: {
        pluginId: PLUGIN_MANIFEST.id,
        localId: declaration.id,
      },
      accountMediation: declaration.accountMediation,
    });

    expect(materializeRecipientOperationRequestV1({
      contract,
      operationId: 'voices',
      parameters: {},
    })).toMatchObject({
      method: 'GET',
      url: 'https://api.x.ai/v1/tts/voices',
      body: null,
      redirect: 'error',
    });
    expect(() => materializeRecipientOperationRequestV1({
      contract,
      operationId: 'voices-list',
      parameters: {},
    })).toThrow('Unknown recipient operation');
    expect(() => materializeRecipientOperationRequestV1({
      contract,
      operationId: 'voices',
      parameters: { path: '/v1/realtime/client_secrets' },
    })).toThrow('Invalid recipient operation parameters');
  });
});
