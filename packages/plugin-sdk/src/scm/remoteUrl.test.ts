import { describe, expect, it } from 'vitest';

import { encodeCompareRef, parseScmRemoteUrl, stripTrailingSlash } from './remoteUrl.js';

describe('parseScmRemoteUrl', () => {
    describe('accepts canonical remotes', () => {
        it('parses https remote', () => {
            expect(parseScmRemoteUrl('https://github.com/happier-dev/happier.git')).toEqual({
                scheme: 'https:',
                host: 'github.com',
                path: 'happier-dev/happier',
            });
        });

        it('parses ssh remote with username', () => {
            expect(parseScmRemoteUrl('ssh://git@github.com/happier-dev/happier.git')).toEqual({
                scheme: 'ssh:',
                host: 'github.com',
                path: 'happier-dev/happier',
            });
        });

        it('parses scp-like remote', () => {
            expect(parseScmRemoteUrl('git@github.com:happier-dev/happier.git')).toEqual({
                scheme: 'scp:',
                host: 'github.com',
                path: 'happier-dev/happier',
            });
        });

        it('lowercases host', () => {
            expect(parseScmRemoteUrl('https://GitHub.COM/Happier-Dev/Happier')).toEqual({
                scheme: 'https:',
                host: 'github.com',
                path: 'Happier-Dev/Happier',
            });
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

        it('rejects embedded port', () => {
            expect(parseScmRemoteUrl('https://github.com:8443/owner/repo')).toBeNull();
            expect(parseScmRemoteUrl('https://attacker.example:80/owner/repo')).toBeNull();
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
    });

    describe('path normalization', () => {
        it('strips trailing .git suffix', () => {
            const parsed = parseScmRemoteUrl('https://github.com/owner/repo.git');
            expect(parsed?.path).toBe('owner/repo');
        });

        it('trims leading and trailing slashes', () => {
            const parsed = parseScmRemoteUrl('https://github.com//owner/repo//');
            expect(parsed?.path).toBe('owner/repo');
        });

        it('decodes percent-encoded path segments', () => {
            const parsed = parseScmRemoteUrl('https://github.com/owner/my%20repo');
            expect(parsed?.path).toBe('owner/my repo');
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
