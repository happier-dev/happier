import React from 'react';
import { PluginContributesV2Schema } from '@happier-dev/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { createExternalVoiceProviderActivationScope } from '@/voice/registry/externalVoiceProviderActivation.testkit';
import { createBundledConversationRuntimeHostLease } from '@/voice/registry/bundledConversationRuntimeHost';
import { VoiceRawCredentialAccessReview } from '@/voice/credentials/VoiceRawCredentialAccessReview';

import { installVoiceSettingsPanelCommonModuleMocks } from './voiceSettingsPanelTestHelpers';
import { VoiceCredentialSourceField } from './realtime/VoiceCredentialSourceField';

installVoiceSettingsPanelCommonModuleMocks();

vi.mock('@/components/ui/lists/ItemGroup', () => ({
  ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
  DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

type RawCredentialSourceFixture =
  | Readonly<{ kind: 'savedSecret'; access?: 'raw' | 'mediated' }>
  | Readonly<{ kind: 'connectedAccount'; access?: 'raw' | 'mediated' }>;

async function activateRawCredentialOnlyProvider(
  pluginId: string,
  sources: readonly RawCredentialSourceFixture[],
) {
  const declaration = PluginContributesV2Schema.parse({
    voiceProviders: [{
      id: 'conversation',
      title: 'Raw Credential Voice',
      kind: 'conversation',
      roles: ['realtime_conversation'],
      platforms: ['web'],
      capabilities: {
        turn: { cancelResponse: false, bargeIn: false },
      },
      credentials: {
        slot: {
          id: 'voice_auth',
          purpose: 'voice.client-auth',
          title: 'Voice credential',
        },
        requirement: { kind: 'always' },
        sources: sources.map((source) => {
          const raw = source.access !== 'mediated';
          return source.kind === 'savedSecret'
            ? ({
              kind: 'savedSecret',
              secretKinds: ['apiKey'],
              ...(raw ? { rawGrants: [{
                realm: 'web',
                phase: 'connection',
                request: {
                  kind: 'httpHeaders',
                  origin: 'https://voice.example.test',
                  headerNames: ['authorization'],
                },
              }] } : {
                operationProjections: [{
                  kind: 'recipientCredential',
                  operation: 'client-auth',
                  phase: 'connection',
                  format: 'bearer',
                }],
              }),
            })
          : ({
              kind: 'connectedAccount',
              service: {
                pluginId: 'happier.agent.codex',
                localId: 'openai-codex',
              },
              ...(raw ? { rawGrants: [{
                realm: 'web',
                phase: 'connection',
                request: {
                  kind: 'httpHeaders',
                  origin: 'https://voice.example.test',
                  headerNames: ['x-account-token'],
                },
              }] } : {
                operationProjections: [{
                  kind: 'materializedHttpHeaders',
                  operation: 'client-auth',
                  phase: 'connection',
                  request: {
                    kind: 'httpHeaders',
                    origin: 'https://voice.example.test',
                    headerNames: ['x-account-token'],
                  },
                  requiredHeaderNames: ['x-account-token'],
                  allowedHeaderNames: ['x-account-token'],
                }],
              }),
            });
        }),
        ...(sources.some((source) => source.access === 'mediated') ? {
          hostMediated: {
            operations: [{
              id: 'client-auth',
              purpose: 'voice.client-auth',
              credentialSlotId: 'voice_auth',
              effect: 'read',
              request: {
                origin: 'https://voice.example.test',
                pathTemplate: '/v1/session',
                queryTemplate: [],
                headerTemplate: [],
                bodyTemplate: { kind: 'none' },
                method: 'POST',
                credential: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
                redirect: 'error',
                maxBodyBytes: 0,
                contentTypes: [],
              },
              parameters: {
                schema: { type: 'object', properties: {}, additionalProperties: false },
                mapping: [],
              },
              response: { maxBytes: 64 * 1024, contentTypes: ['application/json'] },
            }],
          },
        } : {}),
      },
      client: {
        artifactId: 'voice-runtime-web',
        modulePath: './voiceRuntime',
        exportName: 'activate',
      },
    }],
  }).voiceProviders[0]!;
  if (declaration.kind !== 'conversation') throw new Error('expected conversation declaration');

  const scope = createExternalVoiceProviderActivationScope({
    pluginId,
    declarations: [declaration],
    hostPlatform: 'web',
  });
  const hostLease = createBundledConversationRuntimeHostLease();
  scope.api.voiceProviders.register('conversation', {
    kind: 'conversation',
    protocol: {
      async prepare() {
        return { kind: 'prepared', session: { config: {}, safeMetadata: null } };
      },
      decodeControl: () => [],
      encodeTurnControl: () => null,
    },
    async createConnection() {
      return {
        kind: 'sdk_handle',
        async connect() {},
        async sendControl() {},
        controlEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
        transportEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
        async close() {},
        state: () => 'closed',
        currentProviderSessionId: () => null,
        playbackCursorMs: () => null,
        beginOutputInterruptionCandidate: () => 'unsupported',
        resolveOutputInterruptionCandidate() {},
      };
    },
    encodeToolResults: () => [],
    encodeToolContinuation: () => null,
    encodeContextUpdate: () => [],
    encodeTextTurn: () => [],
    microphoneMode: 'provider_managed',
    setInputMuted: () => {},
  });
  await scope.commit();

  return Object.freeze({
    declaration,
    contribution: Object.freeze({ pluginId, localId: declaration.id }),
    providerId: `${pluginId}/${declaration.id}`,
    async cleanup() {
      await scope.unwind();
      hostLease.revoke();
    },
  });
}

describe('VoiceProviderSection raw credential review reachability', () => {
  it.each([
    {
      label: 'raw-only SavedSecret',
      pluginId: 'acme.raw-secret-voice',
      sources: [{ kind: 'savedSecret' }] as const,
      expectedSavedSecretEntries: 1,
      expectedSourceSelectors: 0,
      expectedRawCredentialReviews: 1,
      expectedRawCopy: true,
    },
    {
      label: 'raw Connected Account-only',
      pluginId: 'acme.raw-account-voice',
      sources: [{ kind: 'connectedAccount' }] as const,
      expectedSavedSecretEntries: 0,
      expectedSourceSelectors: 1,
      expectedRawCredentialReviews: 1,
      expectedRawCopy: true,
    },
    {
      label: 'multiple raw sources',
      pluginId: 'acme.raw-multiple-voice',
      sources: [{ kind: 'savedSecret' }, { kind: 'connectedAccount' }] as const,
      expectedSavedSecretEntries: 1,
      expectedSourceSelectors: 1,
      expectedRawCredentialReviews: 1,
      expectedRawCopy: true,
    },
    {
      label: 'host-mediated SavedSecret',
      pluginId: 'acme.mediated-secret-voice',
      sources: [{ kind: 'savedSecret', access: 'mediated' }] as const,
      expectedSavedSecretEntries: 1,
      expectedSourceSelectors: 0,
      expectedRawCredentialReviews: 0,
      expectedRawCopy: false,
    },
  ])('keeps the generic review control reachable for a $label declaration without a mediated account slot', async ({
    pluginId,
    sources,
    expectedSavedSecretEntries,
    expectedSourceSelectors,
    expectedRawCredentialReviews,
    expectedRawCopy,
  }) => {
    const fixture = await activateRawCredentialOnlyProvider(pluginId, sources);
    onTestFinished(fixture.cleanup);

    const entry = createDefaultVoiceProviderRegistry().get(fixture.providerId);
    if (entry?.kind !== 'voice.conversation-provider.v1') {
      throw new Error('expected external conversation provider entry');
    }
    expect(entry.declaration?.credentials?.sources).toEqual(fixture.declaration.credentials?.sources);
    expect(entry?.accountCredentialSlot).toBeUndefined();

    const { VoiceProviderSection } = await import('./VoiceProviderSection');
    const { tree } = await renderScreen(<VoiceProviderSection
      voice={{
        providerId: fixture.providerId,
        providers: {
          [fixture.providerId]: { schemaVersion: 1, config: {} },
        },
      } as any}
      setVoice={vi.fn()}
      happierVoiceSupported={true}
      platformOs="web"
    />);

    const reviews = tree.findAllByType(VoiceRawCredentialAccessReview);
    expect(reviews).toHaveLength(expectedRawCredentialReviews);
    if (expectedRawCredentialReviews > 0) {
      expect(reviews[0]?.props.contribution).toEqual(fixture.contribution);
    }

    const savedSecretTestId = `settings.voice.externalCredential.${encodeURIComponent(fixture.providerId)}.${fixture.declaration.credentials?.slot.id}`;
    const savedSecretEntries = tree.findAllByType('Item' as any).filter(
      (item) => item.props.testID === savedSecretTestId,
    );
    const sourceSelectors = tree.findAllByType(VoiceCredentialSourceField);
    expect(savedSecretEntries).toHaveLength(expectedSavedSecretEntries);
    expect(sourceSelectors).toHaveLength(expectedSourceSelectors);
    if (expectedSourceSelectors > 0) {
      expect(sourceSelectors[0]?.props.declaration).toStrictEqual(fixture.declaration);
    }
    const externalCredentialGroups = tree.findAllByType('ItemGroup' as any).filter((group) => (
      group.props.footer === 'settingsVoice.externalCredentials.rawFooter'
      || group.props.footer === 'settingsVoice.externalCredentials.footer'
    ));
    expect(externalCredentialGroups).toHaveLength(1);
    expect(externalCredentialGroups[0]?.props.footer).toBe(
      expectedRawCopy
        ? 'settingsVoice.externalCredentials.rawFooter'
        : 'settingsVoice.externalCredentials.footer',
    );
    const savedCredentialItems = tree.findAll((item) => (
      item.props.testID === savedSecretTestId
      && typeof item.props.promptDescription === 'string'
    ));
    expect(savedCredentialItems).toHaveLength(expectedSavedSecretEntries);
    if (expectedSavedSecretEntries > 0) {
      expect(savedCredentialItems[0]?.props.promptDescription).toBe(
        expectedRawCopy
          ? 'settingsVoice.externalCredentials.rawPromptDescription'
          : 'settingsVoice.externalCredentials.promptDescription',
      );
    }
  }, 120_000);
});
