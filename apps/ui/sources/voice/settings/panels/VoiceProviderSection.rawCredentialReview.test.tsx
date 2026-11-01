import React from 'react';
import { act } from 'react-test-renderer';
import 'fake-indexeddb/auto';
import { PluginContributesV2Schema, createVoiceProviderRecipientContractFromCredentialsV1 } from '@happier-dev/protocol';
import { SavedSecretResourceMaterialV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { renderScreen as renderTestScreen, waitForTestEvent } from '@/dev/testkit';
import { refreshSavedSecretCatalog } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { createExternalVoiceProviderActivationScope } from '@/voice/registry/externalVoiceProviderActivation.testkit';
import { createBundledConversationRuntimeHostLease } from '@/voice/registry/bundledConversationRuntimeHost';
import { VoiceRawCredentialAccessReview } from '@/voice/credentials/VoiceRawCredentialAccessReview';
import { VoiceCredentialItem } from '@/voice/credentials/CredentialItem';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storageStore';
import { ModalProvider } from '@/modal/ModalProvider';
import { t } from '@/text';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createVoiceSettingsAccountTestHarness, withVoiceSettingsCredentialResource } from './voiceSettingsAccountTestHarness';

import { VoiceCredentialSourceField } from './realtime/VoiceCredentialSourceField';
import { VoiceServiceGallery } from './VoiceServiceGallery';
import { createAccountVoiceOperationService } from '@/voice/credentials/accountVoiceOperationService';
import { resolveAccountVoiceCredentialStatus } from '@/voice/credentials/accountVoiceCredential';
import { resolveSavedSecretReference } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

let account: Awaited<ReturnType<typeof createVoiceSettingsAccountTestHarness>>;
async function renderScreen(...input: Parameters<typeof renderTestScreen>) {
  await refreshSavedSecretCatalog(account.scope);
  return renderTestScreen(input[0], {
    ...input[1],
    wrapper: ({ children }) => <ModalProvider>{children}</ModalProvider>,
  });
}
const settingsBoundary = {
  get settings() { return storage.getState().settings; },
  set settings(value: Settings | null) { account.replaceSettings(value ?? settingsDefaults); },
};
vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
beforeEach(async () => {
  nativeAlert.mockClear();
  nativeAlert.mockImplementation(() => { for (const notify of nativeAlertListeners) notify(); });
  account = await createVoiceSettingsAccountTestHarness(settingsDefaults);
  onTestFinished(account.dispose);
});

const nativeAlert = vi.hoisted(() => vi.fn<typeof import('react-native').Alert.alert>());
const nativeAlertListeners = new Set<() => void>();
async function waitForNativeAlert(title: string) {
  await waitForTestEvent(notify => {
    nativeAlertListeners.add(notify);
    return () => { nativeAlertListeners.delete(notify); };
  }, () => nativeAlert.mock.calls.at(-1)?.[0], value => value === title);
  expect(nativeAlert.mock.calls.at(-1)?.[0]).toBe(title);
}
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock(
  { platformOS: 'ios' }, { Alert: { alert: nativeAlert },
    useWindowDimensions: () => ({ width: 1024, height: 768, scale: 1, fontScale: 1 }) },
));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));


type RawCredentialSourceFixture =
  | Readonly<{ kind: 'savedSecret'; access?: 'raw' | 'mediated' }>
  | Readonly<{ kind: 'connectedAccount'; access?: 'raw' | 'mediated' }>;

async function activateRawCredentialOnlyProvider(
  pluginId: string,
  sources: readonly RawCredentialSourceFixture[],
  packageLocator?: string,
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
        exportName: 'activate',
      },
    }],
  }).voiceProviders[0]!;
  if (declaration.kind !== 'conversation') throw new Error('expected conversation declaration');
  const recipientContract = packageLocator && declaration.credentials?.hostMediated
    ? createVoiceProviderRecipientContractFromCredentialsV1({
        package: { pluginId, source: { kind: 'package', locator: packageLocator } },
        publisher: { trust: 'verified', identity: 'package:acme.review-voice' },
        contribution: { pluginId, localId: declaration.id },
        credentials: { slot: declaration.credentials.slot, hostMediated: declaration.credentials.hostMediated },
      }) : null;

  const scope = createExternalVoiceProviderActivationScope({
    pluginId,
    occurrenceId: `${pluginId}-occurrence-1`,
    declarations: [declaration],
    hostPlatform: 'web',
    ...(recipientContract ? { recipientContractsByLocalId: { [declaration.id]: recipientContract } } : {}),
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
    recipientContract,
    contribution: Object.freeze({ pluginId, localId: declaration.id }),
    providerId: `${pluginId}/${declaration.id}`,
    async cleanup() {
      await scope.unwind();
      hostLease.revoke();
    },
  });
}

describe('VoiceProviderSection raw credential review reachability', () => {
  it.each(['owner', 'recipient'] as const)('keeps only the %s linked-secret review appropriate when inspect is unavailable', async (relationship) => {
    const pluginId = 'acme.linked-review-voice';
    const fixture = await activateRawCredentialOnlyProvider(pluginId, [{ kind: 'savedSecret' }]);
    onTestFinished(fixture.cleanup);
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    account.replaceSettings(await withVoiceSettingsCredentialResource(account, {
      settings: settingsParse({}), declaration: fixture.declaration, pluginId, resourceId: 'linked-review-secret',
    }));
    if (relationship === 'recipient') {
      const resource = account.resources[0]!;
      account.resources[0] = SavedSecretResourceMaterialV1Schema.parse({ ...resource, entry: { ...resource.entry, relationship: 'recipient',
        ownerAccountId: 'other-person', capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false } } });
    }
    const rawGrant = fixture.declaration.credentials!.sources.flatMap(source => source.rawGrants ?? [])[0]!;
    const { rawCredentialAuthorizationClient } = await import('@/voice/credentials/rawCredentialAuthorizationClient');
    await expect(rawCredentialAuthorizationClient.inspect(fixture.contribution, rawGrant)).rejects.toMatchObject({ code: 'machine_unavailable' });
    const screen = await renderScreen(<VoiceCredentialItem contribution={fixture.contribution}
      credentialSlotId={fixture.declaration.credentials!.slot.id}
      credentialSourcePurpose={fixture.declaration.credentials!.slot.purpose}
      credentialSourceDeclaration={fixture.declaration} rawCredentialReviewGrants={[rawGrant]}
      title="API key" promptTitle="API key" promptDescription="API key" disclosePlainStorage
      testID="linked-secret" />);
    if (relationship === 'owner') {
      expect(screen.findHostByTestId('linked-secret-raw-credential-access') === null).toBe(true);
    } else {
      await waitForTestEvent(screen.subscribe, () => screen.getTextContent(), text => text.includes(t('settingsVoice.externalCredentials.unavailable')));
      expect(screen.findHostByTestId('linked-secret-raw-credential-access') === null).toBe(false);
    }
  });

  it('retains the Account resource but requires review before an external package change can use its credential', async () => {
    const pluginId = 'acme.review-voice';
    const sources = [{ kind: 'savedSecret', access: 'mediated' }] as const;
    const original = await activateRawCredentialOnlyProvider(pluginId, sources, 'acme-review-voice@1.0.0');
    onTestFinished(original.cleanup);
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    account.replaceSettings(settingsParse({ voice: { providerId: original.providerId,
      providers: { [original.providerId]: { schemaVersion: 1, config: {} } } } }));
    const { VoiceProviderSection } = await import('./VoiceProviderSection');
    const section = () => <VoiceProviderSection voice={settingsParse(account.settings).voice}
      setVoice={account.replaceVoice} happierVoiceSupported platformOs="web" />;
    const screen = await renderScreen(section());
    const credential = screen.tree.findAllByType(VoiceCredentialItem)[0]!;
    const enter = credential.findAll(node => node.props.title === t('settingsVoice.externalCredentials.apiKeyTitle')
      && typeof node.props.onPress === 'function')[0]!;
    await act(async () => enter.props.onPress());
    await waitForTestEvent(screen.subscribe, () => expect(screen.findHostByTestId('web-prompt-input')).not.toBeNull());
    act(() => screen.changeTextByTestId('web-prompt-input', 'test-only-recipient-key'));
    await screen.pressByTestIdAsync('web-prompt-confirm');
    await waitForNativeAlert(t('settingsVoice.local.voiceCredential.plainStorageTitle'));
    await act(async () => nativeAlert.mock.calls.at(-1)?.[2]?.find(button => button.style !== 'cancel')?.onPress?.());
    await waitForNativeAlert(t('settingsVoice.externalCredentials.recipientApprovalTitle'));
    // The present user's reversible Action is direct by default. No resource
    // may be created before the actual recipient-consent tap.
    expect(account.resources).toHaveLength(0);
    expect(account.promotions).toHaveLength(0);
    await act(async () => nativeAlert.mock.calls.at(-1)?.[2]?.find(button => button.style !== 'cancel')?.onPress?.());
    await waitForTestEvent(account.subscribe, () => account.resources.length, count => count === 1);
    expect(account.resources, JSON.stringify({
      alerts: nativeAlert.mock.calls.map(([title, message]) => ({ title, message })),
      routes: account.request.mock.calls.map(([input]) => new URL(input instanceof Request ? input.url : String(input)).pathname),
    })).toHaveLength(1);
    await waitForTestEvent(screen.subscribe, screen.getTextContent,
      text => text.includes(t('settingsVoice.local.voiceCredential.setOnAccount')));
    expect(screen.getTextContent()).toContain(t('settingsVoice.local.voiceCredential.setOnAccount'));
    expect(account.promotions).toHaveLength(1);
    const retainedEntry = account.resources[0]!.entry;
    if (!('ref' in retainedEntry)) throw new Error('Expected acknowledged SavedSecret Resource');
    const retainedRef = retainedEntry.ref;
    expect(account.settings.voiceSettingsV1.credentialBindings).toHaveLength(1);
    const priorApproval = account.settings.voiceSettingsV1.credentialBindings[0]!.approvedRecipientContractDigest;
    expect(priorApproval).toEqual(expect.any(String));
    await act(async () => original.cleanup());
    const changed = await activateRawCredentialOnlyProvider(pluginId, sources, 'acme-review-voice@2.0.0');
    onTestFinished(changed.cleanup);
    await refreshSavedSecretCatalog(account.scope);
    await screen.update(section());
    const entry = createDefaultVoiceProviderRegistry().get(changed.providerId);
    expect(entry?.accountCredentialSlot?.recipientContract).toEqual(changed.recipientContract);
    expect(entry?.accountCredentialSlot?.recipientContractDigest).not.toBe(
      priorApproval,
    );
    expect(resolveAccountVoiceCredentialStatus({ settings: account.settings, contribution: changed.contribution,
      credentialSlotId: changed.declaration.credentials!.slot.id,
      requiredRecipientContractDigest: entry?.accountCredentialSlot?.recipientContractDigest,
      resolveSavedSecret: ref => resolveSavedSecretReference(account.scope, account.settings.secrets, ref),
    })).toMatchObject({ status: 'review_required', reference: { secretId: retainedRef } });
    const gallery = screen.tree.findAllByType(VoiceServiceGallery)[0]!;
    expect(gallery.props.tiles.find((tile: Readonly<{ id: string }>) => tile.id === changed.providerId)?.status)
      .toMatchObject({ tone: 'needs_you', detail: expect.stringContaining(t('settingsVoice.externalCredentials.reviewRequired')) });
    expect(screen.getTextContent()).toContain(t('settingsVoice.externalCredentials.reviewRequired'));
    expect(account.resources).toHaveLength(1);
    expect(account.resources[0]!.entry).toMatchObject({ ref: retainedRef });
    const vendorRequest = vi.fn<typeof globalThis.fetch>();
    if (!changed.recipientContract) throw new Error('expected verified external recipient contract');
    const controller = new AbortController();
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('expected the current Account lifetime');
    const operation = createAccountVoiceOperationService({ providerId: changed.providerId,
      contribution: changed.contribution, declaration: changed.declaration, phase: 'connection',
      recipientContract: changed.recipientContract, signal: controller.signal,
      isCurrent: lifetime.isCurrent, fetch: vendorRequest });
    await expect(operation.request({ operationId: 'client-auth', parameters: {}, signal: controller.signal })).rejects.toMatchObject({
      code: 'credential_access_review_required',
    });
    expect(vendorRequest).not.toHaveBeenCalled();
  }, 120_000);
  it.each([
    {
      label: 'raw-only SavedSecret',
      pluginId: 'acme.raw-secret-voice',
      sources: [{ kind: 'savedSecret' }] as const,
      selectedSource: 'savedSecret' as const,
      expectedSavedSecretRawReviewGrants: 1,
      expectedSourceSelectors: 0,
      expectedRawCredentialReviews: 1,
      expectedRawCopy: true,
    },
    {
      label: 'raw Connected Account-only',
      pluginId: 'acme.raw-account-voice',
      sources: [{ kind: 'connectedAccount' }] as const,
      selectedSource: 'connectedAccount' as const,
      expectedSavedSecretRawReviewGrants: 0,
      expectedSourceSelectors: 1,
      expectedRawCredentialReviews: 1,
      expectedRawCopy: true,
    },
    {
      label: 'multiple raw sources',
      pluginId: 'acme.raw-multiple-voice',
      sources: [{ kind: 'savedSecret' }, { kind: 'connectedAccount' }] as const,
      selectedSource: 'savedSecret' as const,
      expectedSavedSecretRawReviewGrants: 1,
      expectedSourceSelectors: 1,
      expectedRawCredentialReviews: 1,
      expectedRawCopy: true,
    },
    {
      label: 'host-mediated SavedSecret',
      pluginId: 'acme.mediated-secret-voice',
      sources: [{ kind: 'savedSecret', access: 'mediated' }] as const,
      selectedSource: 'savedSecret' as const,
      expectedSavedSecretRawReviewGrants: 0,
      expectedSourceSelectors: 0,
      expectedRawCredentialReviews: 0,
      expectedRawCopy: false,
    },
    {
      label: 'mediated SavedSecret selected beside a raw Connected Account',
      pluginId: 'acme.mixed-access-voice',
      sources: [
        { kind: 'savedSecret', access: 'mediated' },
        { kind: 'connectedAccount' },
      ] as const,
      selectedSource: 'savedSecret' as const,
      expectedSavedSecretRawReviewGrants: 0,
      expectedSourceSelectors: 1,
      expectedRawCredentialReviews: 0,
      expectedRawCopy: false,
    },
  ])('only renders the generic review control for a selected $label source without a mediated account slot', async ({
    pluginId,
    sources,
    selectedSource,
    expectedSavedSecretRawReviewGrants,
    expectedSourceSelectors,
    expectedRawCredentialReviews,
    expectedRawCopy,
  }) => {
    const fixture = await activateRawCredentialOnlyProvider(pluginId, sources);
    onTestFinished(fixture.cleanup);
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    const {
      applyAccountVoiceCredentialSourceSelection,
    } = await import('@/voice/credentials/accountVoiceCredential');
    const selected = selectedSource === 'savedSecret'
      ? { settings: await withVoiceSettingsCredentialResource(account, {
          settings: settingsParse({}),
          declaration: fixture.declaration,
          pluginId,
          resourceId: `${pluginId}-secret`,
        }) }
      : applyAccountVoiceCredentialSourceSelection({
          settings: settingsParse({}),
          connectedPurposes: account.purposes.value,
          mutation: {
            contribution: fixture.contribution,
            credentialSlotId: fixture.declaration.credentials!.slot.id,
            selection: {
              kind: 'connectedAccount',
              target: {
                kind: 'account',
                account: {
                  service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                  accountId: 'account-a',
                },
              },
            },
            expectedSettingsVersion: 0,
          },
          currentDeclaration: fixture.declaration,
        });
    if ('connectedPurposes' in selected) await account.replaceConnectedPurposes(selected.connectedPurposes);
    settingsBoundary.settings = selected.settings;
    onTestFinished(() => { settingsBoundary.settings = null; });

    const entry = createDefaultVoiceProviderRegistry().get(fixture.providerId);
    if (entry?.kind !== 'voice.conversation-provider.v1') {
      throw new Error('expected external conversation provider entry');
    }
    expect(entry.declaration?.credentials?.sources).toEqual(fixture.declaration.credentials?.sources);
    expect(entry?.accountCredentialSlot).toBeUndefined();

    const { VoiceProviderSection } = await import('./VoiceProviderSection');
    const { tree } = await renderScreen(<VoiceProviderSection
      voice={settingsParse({ voice: {
        providerId: fixture.providerId,
        providers: {
          [fixture.providerId]: { schemaVersion: 1, config: {} },
        },
      } }).voice}
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
    const savedSecretEntries = tree.findAllByType(VoiceCredentialItem).filter(
      (item) => item.props.testID === savedSecretTestId,
    );
    const sourceSelectors = tree.findAllByType(VoiceCredentialSourceField);
    expect(savedSecretEntries).toHaveLength(selectedSource === 'savedSecret' ? 1 : 0);
    expect(savedSecretEntries[0]?.props.rawCredentialReviewGrants ?? []).toHaveLength(
      expectedSavedSecretRawReviewGrants,
    );
    expect(sourceSelectors).toHaveLength(expectedSourceSelectors);
    if (expectedSourceSelectors > 0) {
      expect(sourceSelectors[0]?.props.declaration).toStrictEqual(fixture.declaration);
    }
    const externalCredentialGroups = tree.findAllByType(ItemGroup).filter((group) => (
      group.props.description === t('settingsVoice.externalCredentials.rawFooter')
      || group.props.description === t('settingsVoice.externalCredentials.footer')
    ));
    expect(externalCredentialGroups).toHaveLength(1);
    expect(externalCredentialGroups[0]?.props.description).toBe(
      expectedRawCopy
        ? t('settingsVoice.externalCredentials.rawFooter')
        : t('settingsVoice.externalCredentials.footer'),
    );
    if (selectedSource === 'savedSecret') {
      expect(savedSecretEntries[0]?.props.promptDescription).toBe(
        expectedRawCopy
          ? t('settingsVoice.externalCredentials.rawPromptDescription')
          : t('settingsVoice.externalCredentials.promptDescription'),
      );
    }
  }, 120_000);
});
