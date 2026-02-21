import { describe, it, expect } from 'vitest';
import { isLoopbackHostname } from './urlSafety';

describe('isLoopbackHostname', () => {
    it('treats localhost as loopback', () => {
        expect(isLoopbackHostname('localhost')).toBe(true);
        expect(isLoopbackHostname('LOCALHOST')).toBe(true);
        expect(isLoopbackHostname('localhost.')).toBe(true);
    });

    it('treats *.localhost as loopback', () => {
        expect(isLoopbackHostname('happier.localhost')).toBe(true);
        expect(isLoopbackHostname('happier.localhost.')).toBe(true);
        expect(isLoopbackHostname('a.b.c.localhost')).toBe(true);
        expect(isLoopbackHostname('HAPPIER.LOCALHOST')).toBe(true);
    });

    it('treats 127.0.0.0/8 as loopback', () => {
        expect(isLoopbackHostname('127.0.0.1')).toBe(true);
        expect(isLoopbackHostname('127.0.0.2')).toBe(true);
        expect(isLoopbackHostname('127.255.255.255')).toBe(true);
        expect(isLoopbackHostname('128.0.0.1')).toBe(false);
    });

    it('treats IPv6 loopback forms as loopback', () => {
        expect(isLoopbackHostname('::1')).toBe(true);
        expect(isLoopbackHostname('0:0:0:0:0:0:0:1')).toBe(true);
        expect(isLoopbackHostname('0000:0000:0000:0000:0000:0000:0000:0001')).toBe(true);
        expect(isLoopbackHostname('[::1]')).toBe(true);
        expect(isLoopbackHostname('::1%lo0')).toBe(true);

        expect(isLoopbackHostname('::2')).toBe(false);
        expect(isLoopbackHostname('::')).toBe(false);
    });

    it('treats IPv4-mapped IPv6 loopback as loopback', () => {
        expect(isLoopbackHostname('::ffff:127.0.0.1')).toBe(true);
        expect(isLoopbackHostname('::ffff:127.255.255.255')).toBe(true);
        expect(isLoopbackHostname('::ffff:128.0.0.1')).toBe(false);

        // Hex-encoded IPv4-mapped form (equivalent to 127.0.0.1).
        expect(isLoopbackHostname('::ffff:7f00:1')).toBe(true);
        expect(isLoopbackHostname('::ffff:7f00:0001')).toBe(true);
        expect(isLoopbackHostname('::ffff:8000:0001')).toBe(false);
    });

    it('handles trimming, bracket forms, and malformed loopback-like inputs', () => {
        expect(isLoopbackHostname(' localhost ')).toBe(true);
        expect(isLoopbackHostname('127.0.0.1\t')).toBe(true);
        expect(isLoopbackHostname('[::ffff:127.0.0.1]')).toBe(true);

        expect(isLoopbackHostname('[::1')).toBe(false);
        expect(isLoopbackHostname('::1]')).toBe(false);
        expect(isLoopbackHostname('[::1]%lo0')).toBe(false);
        expect(isLoopbackHostname('::ffff:127.0.0.1.1')).toBe(false);
        expect(isLoopbackHostname('%5B::1%5D')).toBe(false);
    });

    it('treats decimal and dotted-octal IPv4 loopback forms as loopback', () => {
        expect(isLoopbackHostname('2130706433')).toBe(true);
        expect(isLoopbackHostname('0177.0.0.1')).toBe(true);

        expect(isLoopbackHostname('2147483649')).toBe(false);
        expect(isLoopbackHostname('0300.0.0.1')).toBe(false);
    });
});
