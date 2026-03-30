import { describe, expect, it } from 'vitest';

import {
  isInsecureRemoteHttpServerUrl,
  isLocalishHostname,
  isLocalishServerUrl,
  isLoopbackHttpServerUrl,
} from '@/server/serverUrlClassification';

describe('serverUrlClassification', () => {
  it('treats loopback and private hosts as local-ish', () => {
    expect(isLocalishHostname('localhost')).toBe(true);
    expect(isLocalishHostname('127.0.0.1')).toBe(true);
    expect(isLocalishHostname('192.168.1.20')).toBe(true);
    expect(isLocalishHostname('10.0.0.5')).toBe(true);
    expect(isLocalishHostname('172.16.0.1')).toBe(true);
    expect(isLocalishHostname('169.254.10.20')).toBe(true);
    expect(isLocalishHostname('100.64.0.10')).toBe(true);
    expect(isLocalishHostname('mybox')).toBe(true);
    expect(isLocalishHostname('happier-qa.localhost')).toBe(true);
    expect(isLocalishHostname('printer.local')).toBe(true);
    expect(isLocalishHostname('::1')).toBe(true);
  });

  it('does not treat public hostnames as local-ish', () => {
    expect(isLocalishHostname('api.happier.dev')).toBe(false);
    expect(isLocalishHostname('example.com')).toBe(false);
  });

  it('detects loopback http URLs', () => {
    expect(isLoopbackHttpServerUrl('http://127.0.0.1:3005')).toBe(true);
    expect(isLoopbackHttpServerUrl('http://localhost:3005')).toBe(true);
    expect(isLoopbackHttpServerUrl('http://happier-qa.localhost:3005')).toBe(true);
    expect(isLoopbackHttpServerUrl('http://happier-qa.localhost.:3005')).toBe(true);
    expect(isLoopbackHttpServerUrl('https://localhost:3005')).toBe(false);
  });

  it('classifies server URLs by host, not by http scheme alone', () => {
    expect(isLocalishServerUrl('http://127.0.0.1:3005')).toBe(true);
    expect(isLocalishServerUrl('https://192.168.1.20:3005')).toBe(true);
    expect(isLocalishServerUrl('http://example.com:3005')).toBe(false);

    expect(isInsecureRemoteHttpServerUrl('http://example.com:3005')).toBe(true);
    expect(isInsecureRemoteHttpServerUrl('http://127.0.0.1:3005')).toBe(false);
    expect(isInsecureRemoteHttpServerUrl('https://example.com:3005')).toBe(false);
  });
});
