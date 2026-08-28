import {
  derivePluginDaemonContributionRegistrationRights,
  ingestPluginManifestV2,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

describe('OpenAI Voice plugin manifest', () => {
  it('owns the standard OpenAI API-key Connected Account selected by qualified consumers', () => {
    expect(ingestPluginManifestV2(PLUGIN_MANIFEST)).toMatchObject({ ok: true });
    expect(PLUGIN_MANIFEST.contributes.connectedAccountDescriptors).toEqual([{
      id: 'openai',
      title: 'OpenAI API key',
      authentication: {
        defaultModeId: 'api-key',
        modes: [{
          id: 'api-key',
          kind: 'manual',
          outcomeReconciliation: 'none',
          fields: [{
            id: 'token',
            title: 'OpenAI API key',
            schema: { type: 'string', minLength: 1 },
            secret: true,
          }],
        }],
      },
    }]);
  });

  it('publishes its API-key descriptor for daemon runtime activation', () => {
    expect(derivePluginDaemonContributionRegistrationRights(
      PLUGIN_MANIFEST.contributes,
    )).toContainEqual(expect.objectContaining({
      family: 'connectedAccountDescriptors',
      localId: 'openai',
    }));
  });

  it('owns client-auth mediation in the Voice declaration without a private action route', () => {
    expect(PLUGIN_MANIFEST).not.toHaveProperty('hostAccess');
    expect(PLUGIN_MANIFEST.contributes).not.toHaveProperty('actions');
    expect(PLUGIN_MANIFEST.contributes.voiceProviders[0]?.credentials).toMatchObject({
      slot: { id: 'api_key', purpose: 'voice.client-auth' },
      hostMediated: {
        operations: [expect.objectContaining({
          id: 'client-auth',
          purpose: 'voice.client-auth',
          credentialSlotId: 'api_key',
        })],
      },
    });
  });

  it('advertises the shared realtime provider on every Voice client platform', () => {
    expect(PLUGIN_MANIFEST.contributes.voiceProviders[0]?.platforms).toEqual([
      'web',
      'ios',
      'android',
    ]);
  });

  it('declares the selected-account processing disclosure without promising provider deletion', () => {
    const disclosure = PLUGIN_MANIFEST.contributes.voiceProviders[0]?.settings?.privacyDisclosure;
    expect(disclosure).toMatchObject({
      key: 'settingsVoice.realtimeProviders.openai.privacyDisclosure',
    });
    const fallback = typeof disclosure === 'string' ? disclosure : disclosure?.fallback ?? '';
    expect(fallback).toMatch(/audio/iu);
    expect(fallback).toMatch(/conversation/iu);
    expect(fallback).toMatch(/OpenAI/iu);
    expect(fallback).toMatch(/selected .*account|Saved Voice API key/iu);
    expect(fallback).toMatch(/may retain/iu);
    expect(fallback).not.toMatch(/delete.*OpenAI|OpenAI.*delet/iu);
  });

  it('declares one canonical prepare-phase credential slot for all OpenAI auth sources', () => {
    const contribution = PLUGIN_MANIFEST.contributes.voiceProviders[0];

    expect(contribution).not.toHaveProperty('accountMediation');
    expect(contribution).toMatchObject({
      id: 'realtime-openai',
      kind: 'conversation',
      capabilities: {
        turn: { cancelResponse: true, bargeIn: true },
        tools: { effectCalls: 'stable_ids' },
      },
      credentials: {
        slot: {
          id: 'api_key',
          purpose: 'voice.client-auth',
        },
        requirement: { kind: 'always' },
        sources: [
          {
            kind: 'savedSecret',
            operationProjections: [{
              kind: 'recipientCredential',
              operation: 'client-auth',
              phase: 'prepare',
              format: 'bearer',
            }],
          },
          {
            kind: 'connectedAccount',
            service: { pluginId: 'happier.voice.openai', localId: 'openai' },
            operationProjections: [{
              kind: 'materializedHttpHeaders',
              operation: 'client-auth',
              phase: 'prepare',
              request: {
                kind: 'httpHeaders',
                origin: 'https://api.openai.com',
                headerNames: ['authorization'],
              },
              requiredHeaderNames: ['authorization'],
              allowedHeaderNames: ['authorization'],
            }],
          },
          {
            kind: 'connectedAccount',
            service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
            operationProjections: [{
              kind: 'materializedHttpHeaders',
              operation: 'client-auth',
              phase: 'prepare',
              request: {
                kind: 'httpHeaders',
                origin: 'https://api.openai.com',
                headerNames: ['authorization', 'chatgpt-account-id'],
              },
              requiredHeaderNames: ['authorization'],
              allowedHeaderNames: ['authorization', 'chatgpt-account-id'],
            }],
          },
        ],
      },
    });
  });
});
