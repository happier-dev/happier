import { describe, expect, it } from 'vitest';

import {
    encodeCompareRef,
    parseScmRemoteUrl,
    stripTrailingSlash,
    type ScmTransportIdentityV1,
} from './remoteUrl.js';

describe('parseScmRemoteUrl', () => {
    describe('accepts canonical remotes', () => {
        it('parses https remote', () => {
            expect(parseScmRemoteUrl('https://github.com/happier-dev/happier.git')).toEqual({
                syntax: 'url',
                protocol: 'https:',
                host: 'github.com',
                port: null,
                path: 'happier-dev/happier',
            });
        });

        it('parses ssh remote with username', () => {
            expect(parseScmRemoteUrl('ssh://git@github.com/happier-dev/happier.git')).toEqual({
                syntax: 'url',
                protocol: 'ssh:',
                host: 'github.com',
                port: null,
                username: 'git',
                path: 'happier-dev/happier',
            });
        });

        it('parses scp-like remote', () => {
            expect(parseScmRemoteUrl('git@github.com:happier-dev/happier.git')).toEqual({
                syntax: 'scp',
                host: 'github.com',
                username: 'git',
                path: 'happier-dev/happier',
            });
        });

        it('lowercases host', () => {
            expect(parseScmRemoteUrl('https://GitHub.COM/Happier-Dev/Happier')).toEqual({
                syntax: 'url',
                protocol: 'https:',
                host: 'github.com',
                port: null,
                path: 'Happier-Dev/Happier',
            });
        });
    });

    describe('retains the endpoint facts a comparison needs', () => {
        it('keeps a non-default https port in its own field instead of rejecting the remote', () => {
            expect(parseScmRemoteUrl('https://gitlab.example.test:8443/acme/repo.git')).toEqual({
                syntax: 'url',
                protocol: 'https:',
                host: 'gitlab.example.test',
                port: 8443,
                path: 'acme/repo',
            });
        });

        it('coalesces an explicit https default port with an unnamed port', () => {
            expect(parseScmRemoteUrl('https://gitlab.example.test:443/acme/repo')).toEqual({
                syntax: 'url',
                protocol: 'https:',
                host: 'gitlab.example.test',
                port: null,
                path: 'acme/repo',
            });
            expect(parseScmRemoteUrl('https://gitlab.example.test/acme/repo')).toMatchObject({
                port: null,
            });
        });

        it('keeps an explicit ssh default port, which ssh URLs do not erase', () => {
            expect(parseScmRemoteUrl('ssh://git@gitlab.example.test:22/team/repo')).toMatchObject({
                port: 22,
            });
        });

        it('keeps a non-default ssh port', () => {
            expect(parseScmRemoteUrl('ssh://git@gitlab.example.test:2222/team/repo.git')).toEqual({
                syntax: 'url',
                protocol: 'ssh:',
                host: 'gitlab.example.test',
                port: 2222,
                username: 'git',
                path: 'team/repo',
            });
        });

        it('keeps a configured deployment path prefix in the path', () => {
            expect(parseScmRemoteUrl('https://code.internal.test/gitlab/platform/app.git')).toMatchObject({
                host: 'code.internal.test',
                path: 'gitlab/platform/app',
            });
        });

        it('rejects a port outside 1..65535', () => {
            expect(parseScmRemoteUrl('https://gitlab.example.test:0/acme/repo')).toBeNull();
            expect(parseScmRemoteUrl('https://gitlab.example.test:99999/acme/repo')).toBeNull();
        });

        it('does not fall back to scp parsing when a ported URL fails policy', () => {
            // Guard G1: `https://host:8443` must never become `scp(host='https')`.
            expect(parseScmRemoteUrl('https://user:secret@gitlab.example.test:8443/acme/repo')).toBeNull();
        });
    });

    describe('rejects untrusted/non-canonical shapes', () => {
        it('rejects empty input', () => {
            expect(parseScmRemoteUrl('')).toBeNull();
            expect(parseScmRemoteUrl('   ')).toBeNull();
        });

        it('rejects unknown scheme', () => {
            expect(parseScmRemoteUrl('http://github.com/owner/repo')).toBeNull();
            expect(parseScmRemoteUrl('ftp://github.com/owner/repo')).toBeNull();
            expect(parseScmRemoteUrl('file:///etc/passwd')).toBeNull();
        });

        it('rejects search params', () => {
            expect(parseScmRemoteUrl('https://github.com/owner/repo?token=abc')).toBeNull();
        });

        it('rejects hash fragment', () => {
            expect(parseScmRemoteUrl('https://github.com/owner/repo#main')).toBeNull();
        });

        it('rejects embedded password', () => {
            expect(parseScmRemoteUrl('https://user:secret@github.com/owner/repo')).toBeNull();
            expect(parseScmRemoteUrl('ssh://user:secret@github.com/owner/repo')).toBeNull();
        });

        it('rejects username on https (must come from descriptor materializer)', () => {
            expect(parseScmRemoteUrl('https://leeroy@github.com/owner/repo')).toBeNull();
        });

        it('rejects Windows drive letters as scp-style', () => {
            expect(parseScmRemoteUrl('C:/Users/me/repo')).toBeNull();
            expect(parseScmRemoteUrl('D:\\repos\\thing')).toBeNull();
        });

        it('rejects empty path after normalization', () => {
            expect(parseScmRemoteUrl('https://github.com/')).toBeNull();
            expect(parseScmRemoteUrl('https://github.com')).toBeNull();
        });

        // A malformed escape is non-canonical input, so it returns null like every other
        // ambiguous remote — it must neither throw out of the parser nor fall through to the
        // scp branch, which would read this remote as `scp(host='https')`. That is guard G1.
        it('rejects a malformed percent-escape instead of throwing or falling back to scp', () => {
            expect(parseScmRemoteUrl('https://gitlab.example.test/team/bad%zz.git')).toBeNull();
            expect(parseScmRemoteUrl('ssh://git@gitlab.example.test/team/bad%e0%a4%a.git')).toBeNull();
        });
    });

    describe('path normalization', () => {
        it('trims leading and trailing slashes', () => {
            const parsed = parseScmRemoteUrl('https://github.com//owner/repo//');
            expect(parsed?.path).toBe('owner/repo');
        });

        it('decodes percent-encoded path segments', () => {
            const parsed = parseScmRemoteUrl('https://github.com/owner/my%20repo');
            expect(parsed?.path).toBe('owner/my repo');
        });
    });

    describe('makes the invalid transport shapes unrepresentable', () => {
        it('has no port on the scp arm and no username on the https arm', () => {
            const scp: ScmTransportIdentityV1 = {
                syntax: 'scp',
                host: 'github.com',
                username: 'git',
                path: 'owner/repo',
                // @ts-expect-error scp syntax carries no port semantics.
                port: 22,
            };
            const https: ScmTransportIdentityV1 = {
                syntax: 'url',
                protocol: 'https:',
                host: 'github.com',
                port: null,
                path: 'owner/repo',
                // @ts-expect-error an https remote never carries an embedded username.
                username: 'leeroy',
            };
            expect(scp.host).toBe('github.com');
            expect(https.host).toBe('github.com');
        });
    });
});

describe('encodeCompareRef', () => {
    it('percent-encodes refs with slashes', () => {
        expect(encodeCompareRef('feat/my-branch')).toBe('feat%2Fmy-branch');
    });

    it('preserves plain refs', () => {
        expect(encodeCompareRef('main')).toBe('main');
    });
});

describe('stripTrailingSlash', () => {
    it('strips one trailing slash', () => {
        expect(stripTrailingSlash('https://github.com/')).toBe('https://github.com');
    });

    it('strips multiple trailing slashes', () => {
        expect(stripTrailingSlash('https://github.com///')).toBe('https://github.com');
    });

    it('preserves no-slash strings', () => {
        expect(stripTrailingSlash('https://github.com')).toBe('https://github.com');
    });
});
