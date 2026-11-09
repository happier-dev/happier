import { afterEach, describe, expect, it } from 'vitest';

import {
  commitExternalVoiceProviderRegistration,
  getExternalVoiceProviderRegistrationsRevision,
  replaceExternalVoiceProviderProjectionAuthority,
  resetExternalVoiceProviderRegistrationsForTests,
  subscribeExternalVoiceProviderRegistrations,
} from './externalVoiceProviderRegistrations';

afterEach(resetExternalVoiceProviderRegistrationsForTests);

describe('external Voice registration publication costs', () => {
  it('does not republish an already admitted registration', () => {
    const registration = Object.freeze({ token: {}, pluginId: 'acme.voice', localId: 'speech',
      providerId: 'acme.voice/speech', occurrenceId: 'occurrence-1', descriptor: null, adapter: null });
    commitExternalVoiceProviderRegistration(registration);
    let notifications = 0;
    const revision = getExternalVoiceProviderRegistrationsRevision();
    const stop = subscribeExternalVoiceProviderRegistrations(() => { notifications++; });
    try {
      commitExternalVoiceProviderRegistration(registration);
      expect({ notifications, revisionDelta: getExternalVoiceProviderRegistrationsRevision() - revision })
        .toEqual({ notifications: 0, revisionDelta: 0 });
      commitExternalVoiceProviderRegistration({ ...registration, occurrenceId: 'occurrence-2' });
      expect({ notifications, revisionDelta: getExternalVoiceProviderRegistrationsRevision() - revision })
        .toEqual({ notifications: 1, revisionDelta: 1 });
    } finally { stop(); }
  });

  it('does not republish equal authority and still publishes an occurrence revocation', () => {
    const token = {};
    const providers = new Map([['acme.voice/speech', 'occurrence-1']]);
    replaceExternalVoiceProviderProjectionAuthority(null, token, providers);
    let notifications = 0;
    const revision = getExternalVoiceProviderRegistrationsRevision();
    const stop = subscribeExternalVoiceProviderRegistrations(() => { notifications++; });
    try {
      replaceExternalVoiceProviderProjectionAuthority(token, token, new Map(providers));
      expect({ notifications, revisionDelta: getExternalVoiceProviderRegistrationsRevision() - revision })
        .toEqual({ notifications: 0, revisionDelta: 0 });
      replaceExternalVoiceProviderProjectionAuthority(token, token, new Map());
      expect({ notifications, revisionDelta: getExternalVoiceProviderRegistrationsRevision() - revision })
        .toEqual({ notifications: 1, revisionDelta: 1 });
    } finally { stop(); }
  });
});
