import { describe, expect, it } from 'vitest';

import {
    canSafelyAutoAdoptCanonicalServerUrl,
    isInsecureRemoteHttpServerUrl,
    isLocalishHostname,
    isLocalishServerUrl,
    isLoopbackHostname,
} from './serverUrlClassification';

describe('serverUrlClassification', () => {
    it('detects local-ish hostnames', () => {
        expect(isLocalishHostname('localhost')).toBe(true);
        expect(isLocalishHostname('127.0.0.1')).toBe(true);
        expect(isLocalishHostname('192.168.1.2')).toBe(true);
        expect(isLocalishHostname('100.64.0.1')).toBe(true);
        expect(isLocalishHostname('my-nas')).toBe(true);
        expect(isLocalishHostname('api.happier.dev')).toBe(false);
    });

    it('detects local-ish server URLs by hostname', () => {
        expect(isLocalishServerUrl('http://127.0.0.1:3005')).toBe(true);
        expect(isLocalishServerUrl('http://192.168.0.2:3005')).toBe(true);
        expect(isLocalishServerUrl('https://api.happier.dev')).toBe(false);
    });

    it('detects insecure remote http URLs', () => {
        expect(isInsecureRemoteHttpServerUrl('http://api.happier.dev')).toBe(true);
        expect(isInsecureRemoteHttpServerUrl('http://127.0.0.1:3005')).toBe(false);
    });

    it('auto-adopts only for safe upgrades', () => {
        expect(canSafelyAutoAdoptCanonicalServerUrl({
            currentUrl: 'http://127.0.0.1:3005',
            advertisedUrl: 'https://canonical.example.test',
        })).toBe(true);

        expect(canSafelyAutoAdoptCanonicalServerUrl({
            currentUrl: 'http://public.example.test',
            advertisedUrl: 'https://public.example.test',
        })).toBe(true);

        expect(canSafelyAutoAdoptCanonicalServerUrl({
            currentUrl: 'http://public.example.test',
            advertisedUrl: 'https://canonical.example.test',
        })).toBe(false);

        expect(canSafelyAutoAdoptCanonicalServerUrl({
            currentUrl: 'https://public.example.test',
            advertisedUrl: 'http://public.example.test',
        })).toBe(false);
    });
});

describe('isLoopbackHostname (reachability)', () => {
    // This predicate answers "can another device reach this URL?", so it must be
    // accurate about networking. It is NOT the same question as "is this the same
    // server?" — that one belongs to createServerUrlComparableKey, which is
    // deliberately narrower. See packages/protocol/src/serverUrls/.
    it('covers the whole 127.0.0.0/8 loopback range, not just 127.0.0.1', () => {
        expect(isLoopbackHostname('127.0.0.1')).toBe(true);
        expect(isLoopbackHostname('127.0.0.2')).toBe(true);
        expect(isLoopbackHostname('127.255.255.254')).toBe(true);
        expect(isLoopbackHostname('128.0.0.1')).toBe(false);
    });

    it('treats a fully qualified trailing dot as the same host', () => {
        expect(isLoopbackHostname('localhost.')).toBe(true);
        expect(isLoopbackHostname('relay.localhost.')).toBe(true);
        expect(isLoopbackHostname('127.0.0.1.')).toBe(true);
    });

    it('keeps the reserved .localhost TLD and bracketed IPv6 loopback', () => {
        expect(isLoopbackHostname('localhost')).toBe(true);
        expect(isLoopbackHostname('relay.localhost')).toBe(true);
        expect(isLoopbackHostname('::1')).toBe(true);
        expect(isLoopbackHostname('[::1]')).toBe(true);
    });

    it('still reports an all-interfaces bind as unusable from another device', () => {
        // 0.0.0.0 is not loopback in the networking sense, but a URL carrying it
        // is just as useless to a phone, and every consumer of this predicate is
        // asking the reachability question.
        expect(isLoopbackHostname('0.0.0.0')).toBe(true);
    });

    it('does not classify routable or LAN addresses as loopback', () => {
        expect(isLoopbackHostname('192.168.1.9')).toBe(false);
        expect(isLoopbackHostname('100.84.140.109')).toBe(false);
        expect(isLoopbackHostname('relay.example.com')).toBe(false);
        expect(isLoopbackHostname('notlocalhost')).toBe(false);
        expect(isLoopbackHostname('')).toBe(false);
    });
});
