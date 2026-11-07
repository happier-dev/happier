import { describe, expect, it } from 'vitest';
import { hasRemoteImageConsent, RemoteImageConsentV1Schema } from './remoteImageConsent';

describe('document remote-image consent', () => {
    it('tolerates damaged entries and round-trips only explicit workspace/file choices', () => {
        const stored = [['workspace-a', 'README.md'], ['workspace-a', 'README.md'], ['workspace-b', 'README.md'], null, ['', 'README.md']];
        expect(RemoteImageConsentV1Schema.parse(stored)).toEqual([['workspace-a', 'README.md'], ['workspace-b', 'README.md']]);
        expect(RemoteImageConsentV1Schema.parse('damaged')).toEqual([]);
        const next = RemoteImageConsentV1Schema.parse([['workspace-a', 'README.md']]);
        expect(hasRemoteImageConsent(RemoteImageConsentV1Schema.parse(next), 'workspace-a', 'README.md')).toBe(true);
        expect(hasRemoteImageConsent(next, 'workspace-b', 'README.md')).toBe(false);
        expect(hasRemoteImageConsent(next, 'workspace-a', 'docs/README.md')).toBe(false);
    });
});
