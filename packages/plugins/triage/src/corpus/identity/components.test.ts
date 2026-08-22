import { describe, expect, it } from 'vitest';

import { renderSourceQualifiedId, sameTriageSourceIdentity } from './components.js';

/**
 * The source-agreement gate refuses an entry whose source is not the configured
 * instance's source, and one plugin may contribute more than one source: a forge could
 * publish pull requests and code issues as two local ids under one plugin id. Comparing
 * only the plugin id would let one of those act through the other's configured instance
 * — and every consumer suite that relies on this predicate stayed green when the local
 * id half was removed, so the half is proven here rather than incidentally.
 */
describe('sameTriageSourceIdentity', () => {
    const source = { pluginId: 'happier.scm.forge.github', localId: 'pull-requests' } as const;

    it('agrees only when both components agree', () => {
        expect(sameTriageSourceIdentity(source, { ...source })).toBe(true);
        expect(sameTriageSourceIdentity(source, { ...source, localId: 'code-issues' }))
            .toBe(false);
        expect(sameTriageSourceIdentity(source, { ...source, pluginId: 'happier.sentry' }))
            .toBe(false);
    });

    it('answers what the durable rendering answers', () => {
        // The rendering keys durable rows while the predicate gates access; two sources
        // this predicate calls equal must never render to two different row addresses,
        // and two it calls different must never render to one.
        const other = { ...source, localId: 'code-issues' } as const;
        expect(renderSourceQualifiedId(source)).toBe(renderSourceQualifiedId({ ...source }));
        expect(renderSourceQualifiedId(source)).not.toBe(renderSourceQualifiedId(other));
    });
});
