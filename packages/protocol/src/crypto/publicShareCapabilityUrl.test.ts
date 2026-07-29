import { describe, expect, it } from 'vitest';

import { redactPublicShareCapabilityUrl } from './publicShareCapabilityUrl.js';

describe('redactPublicShareCapabilityUrl', () => {
  it('templates only the public-share bearer capability segment', () => {
    const secret = 'SENTINEL_PUBLIC_SHARE_CAPABILITY';
    expect(redactPublicShareCapabilityUrl(`/v1/public-share/${secret}`)).toBe('/v1/public-share/:token');
    expect(redactPublicShareCapabilityUrl(`/v1/public-share/${secret}/messages?consent=true`)).toBe(
      '/v1/public-share/:token/messages?consent=true',
    );
    expect(redactPublicShareCapabilityUrl(`https://api.example.test/v1/public-share/${secret}/messages`)).toBe(
      'https://api.example.test/v1/public-share/:token/messages',
    );
    expect(redactPublicShareCapabilityUrl(`/share/${secret}?consent=true`)).toBe(
      '/share/:token?consent=true',
    );
    expect(redactPublicShareCapabilityUrl(`https://app.example.test/share/${secret}`)).toBe(
      'https://app.example.test/share/:token',
    );
    expect(redactPublicShareCapabilityUrl('/v1/sessions/session-1/public-share')).toBe(
      '/v1/sessions/session-1/public-share',
    );
  });
});
