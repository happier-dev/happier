import { describe, expect, it } from 'vitest';

import { describeRelayBindSignupExposure } from './hostBindSignupNotice';

describe('describeRelayBindSignupExposure', () => {
  it('says nothing for the loopback default', () => {
    // No bind flag: the relay keeps its own 127.0.0.1 default, so nothing off
    // this computer can reach it and the note would be pure noise.
    expect(describeRelayBindSignupExposure(null)).toBeNull();
    expect(describeRelayBindSignupExposure('')).toBeNull();
    expect(describeRelayBindSignupExposure('  ')).toBeNull();
  });

  it('says nothing for a loopback bind asked for explicitly', () => {
    // `--host 127.0.0.1` / `--host localhost` reach exactly as far as the
    // default does.
    expect(describeRelayBindSignupExposure('127.0.0.1')).toBeNull();
    expect(describeRelayBindSignupExposure('127.0.0.2')).toBeNull();
    expect(describeRelayBindSignupExposure('localhost')).toBeNull();
    expect(describeRelayBindSignupExposure('::1')).toBeNull();
    expect(describeRelayBindSignupExposure('[::1]')).toBeNull();
  });

  it('notices --expose, which is every interface', () => {
    // 0.0.0.0 is not a loopback address: it is the one bind that reaches as far
    // as the machine's networks do.
    const notice = describeRelayBindSignupExposure('0.0.0.0');
    expect(notice?.headline).toContain('0.0.0.0');
    expect([notice?.headline, ...(notice?.details ?? [])].join(' ')).toContain('create an account');
  });

  it('notices a LAN or tailnet bind and links the auth docs', () => {
    for (const host of ['192.168.1.24', '100.84.140.109', '10.0.0.5']) {
      const notice = describeRelayBindSignupExposure(host);
      expect(notice?.headline).toContain(host);
      expect(notice?.details.join(' ')).toContain('https://docs.happier.dev/self-hosting/auth');
    }
  });

  it('keeps the note to three lines', () => {
    const notice = describeRelayBindSignupExposure('0.0.0.0');
    expect(notice?.details.length).toBe(2);
  });
});
