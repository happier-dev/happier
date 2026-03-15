import { describe, expect, it } from 'vitest';

import {
    canSafelyAutoAdoptCanonicalServerUrl,
    isInsecureRemoteHttpServerUrl,
    isLocalishHostname,
    isLocalishServerUrl,
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

