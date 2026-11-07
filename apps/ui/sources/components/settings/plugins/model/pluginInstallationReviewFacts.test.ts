import { describe, expect, it } from 'vitest';

import { createPluginInstallationReviewFixture } from '@happier-dev/protocol/testing/pluginInstallationReviewFixture';

import { describePluginInstallConsent } from './pluginInstallationReviewFacts';

const review = createPluginInstallationReviewFixture({
  displayName: 'Speech',
  version: '2.0.0',
  publisherIdentity: { status: 'unverified', id: 'acme', displayName: 'Acme' },
  requiredHostAccess: [
    {
      id: 'network',
      capability: 'network',
      reason: 'Call the service.',
      authorizationClass: 'cooperativeDisclosure',
      normalizedScope: {
        methods: ['POST'],
        targets: [{ kind: 'fixedOrigin', origin: 'https://speech.example' }],
      },
    },
    {
      id: 'accounts',
      capability: 'connectedAccounts',
      reason: 'Use your account.',
      authorizationClass: 'hostResourceSelection',
      normalizedScope: { serviceRefs: ['oauth'], operations: ['use'] },
    },
  ],
  requestInterceptors: [
    { id: 'auth', origins: ['https://api.example'], priority: 0 },
  ],
  rawCredentialAccess: [
    {
      accessMode: 'raw',
      contribution: { pluginId: 'acme.example', localId: 'speech' },
      credentialSlot: {
        id: 'api_key',
        title: 'API key',
        purpose: 'voice.speech',
      },
      sourceClass: { kind: 'savedSecret', secretKinds: ['apiKey'] },
      realm: 'daemon',
      phase: 'speech',
      request: { kind: 'environment', keys: ['VOICE_TOKEN'] },
    },
  ],
});

describe('describePluginInstallConsent', () => {
  it.each([
    { requiredHostAccess: [] },
    { requiredHostAccess: review.requiredHostAccess },
  ])('lists a daemon-reported Agent account purpose expansion once (%j)', ({ requiredHostAccess }) => {
    const consent = describePluginInstallConsent({
      kind: 'reviewRequired',
      reviewKind: 'installation',
      pendingChangeId: 'agent-purpose-update',
      reason: 'authorityExpansion',
      currentVersion: '1.0.0',
      authorityExpansion: ['connectedAccountPurpose'],
      review: { ...review, requiredHostAccess, contributions: [{ family: 'agents', count: 1 }] },
    });
    expect(consent.uses).toEqual([
      { scope: 'connectedAccountPurpose', label: 'Connected accounts' },
    ]);
  });

  it('summarizes a first install as the plugin, its publisher and everything it uses', () => {
    expect(
      describePluginInstallConsent({
        kind: 'reviewRequired',
        reviewKind: 'installation',
        pendingChangeId: 'p1',
        reason: 'firstInstall',
        currentVersion: null,
        authorityExpansion: [],
        review,
      }),
    ).toEqual({
      kind: 'firstInstall',
      pluginId: 'acme.example',
      pluginName: 'Speech',
      version: '2.0.0',
      currentVersion: null,
      publisher: { id: 'acme', displayName: 'Acme' },
      uses: [
        { scope: 'requiredHostAccess', label: 'Network' },
        { scope: 'connectedAccountPurpose', label: 'Connected accounts' },
        { scope: 'requestInterceptor', label: 'https://api.example' },
        { scope: 'rawCredentialAccess', label: 'API key' },
      ],
    });
  });

  it('lists only what an update newly asks for, with the version it replaces', () => {
    const consent = describePluginInstallConsent({
      kind: 'reviewRequired',
      reviewKind: 'installation',
      pendingChangeId: 'p2',
      reason: 'authorityExpansion',
      currentVersion: '1.0.0',
      authorityExpansion: ['rawCredentialAccess'],
      review: { ...review, publisherIdentity: { status: 'unavailable' } },
    });
    expect(consent).toMatchObject({
      kind: 'newScope',
      currentVersion: '1.0.0',
      version: '2.0.0',
      publisher: null,
    });
    expect(consent.uses).toEqual([
      { scope: 'rawCredentialAccess', label: 'API key' },
    ]);
  });
});
