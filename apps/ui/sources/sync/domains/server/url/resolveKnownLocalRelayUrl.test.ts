import { describe, expect, it } from 'vitest';

import { resolveKnownLocalRelayUrl } from './resolveKnownLocalRelayUrl';

describe('resolveKnownLocalRelayUrl', () => {
    it('prefers the active local relay url when it is localish', () => {
        expect(resolveKnownLocalRelayUrl({
            activeServerUrl: 'http://happier-repo-dev-a1cc5e0671.localhost:19364',
            activeLocalRelayUrl: 'http://happier-repo-dev-a1cc5e0671.localhost:53288',
        })).toBe('http://happier-repo-dev-a1cc5e0671.localhost:53288');
    });

    it('returns null when the active server url is Happier Cloud (even if a local relay url is set)', () => {
        expect(resolveKnownLocalRelayUrl({
            activeServerUrl: 'https://api.happier.dev',
            activeLocalRelayUrl: 'http://localhost:1234',
        })).toBe(null);
    });
});
