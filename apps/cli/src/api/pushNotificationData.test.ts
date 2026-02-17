import { describe, expect, it } from 'vitest';

import { withServerUrlInPushData } from './pushNotificationData';

describe('withServerUrlInPushData', () => {
  it('injects normalized serverUrl when missing', () => {
    expect(withServerUrlInPushData({ baseUrl: 'https://api.example.test/', data: undefined })).toEqual({
      serverUrl: 'https://api.example.test',
    });
  });

  it('overwrites mismatched serverUrl to avoid routing inconsistencies', () => {
    expect(withServerUrlInPushData({
      baseUrl: 'https://api.example.test/',
      data: { serverUrl: 'https://other.example.test', sessionId: 's1' },
    })).toEqual({
      serverUrl: 'https://api.example.test',
      sessionId: 's1',
    });
  });

  it('preserves matching serverUrl (normalizes trailing slashes)', () => {
    expect(withServerUrlInPushData({
      baseUrl: 'https://api.example.test/',
      data: { serverUrl: 'https://api.example.test', foo: 1 },
    })).toEqual({
      serverUrl: 'https://api.example.test',
      foo: 1,
    });
  });
});

