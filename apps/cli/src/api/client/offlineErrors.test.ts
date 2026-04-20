import { afterEach, describe, expect, it } from 'vitest';

import { connectionState } from '@/api/offline/serverConnectionErrors';

import {
  shouldTreatGetOrCreateMachineErrorAsOffline,
  shouldTreatGetOrCreateSessionErrorAsOffline,
} from './offlineErrors';

describe('offlineErrors', () => {
  afterEach(() => {
    connectionState.reset();
  });

  it('treats normalized network error codes as offline bootstrap failures', () => {
    expect(
      shouldTreatGetOrCreateSessionErrorAsOffline(
        { code: ' etimedout ' },
        { url: 'https://example.test/v1/sessions' },
      ),
    ).toBe(true);

    expect(connectionState.isOffline()).toBe(true);
  });

  it('keeps machine registration conflict responses out of offline handling', () => {
    expect(
      shouldTreatGetOrCreateMachineErrorAsOffline(
        { response: { status: 409 } },
        { url: 'https://example.test/v1/machines' },
      ),
    ).toBe(false);

    expect(connectionState.isOffline()).toBe(false);
  });

  it('treats 5xx machine registration failures as offline', () => {
    expect(
      shouldTreatGetOrCreateMachineErrorAsOffline(
        { response: { status: 503 } },
        { url: 'https://example.test/v1/machines' },
      ),
    ).toBe(true);

    expect(connectionState.isOffline()).toBe(true);
  });
});
