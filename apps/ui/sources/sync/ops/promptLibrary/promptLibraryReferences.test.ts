import { describe, expect, it } from 'vitest';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { isPromptLibraryReferenceInHome } from './promptLibraryReferences';

describe('prompt library qualified reference identity', () => {
    it('matches omitted and equivalent local Home references without matching another Home or document', async () => {
        const alpha = await createPlainArtifactHomeFixture('https://prompt-reference-alpha.test');
        const { upsertServerProfileOnly } = await import('@/sync/domains/server/serverRuntime');
        const bravo = await upsertServerProfileOnly({ serverUrl: 'https://prompt-reference-bravo.test', name: 'Bravo' });
        try {
            const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
            const identity = 'srv_prompt_reference_alpha';
            expect(await setServerProfileIdentityForUrl(alpha.home.serverUrl, identity)).not.toBeNull();
            const references = [
                { artifactId: 'same-id' },
                { artifactId: 'same-id', serverId: alpha.home.id },
                { artifactId: 'same-id', serverId: identity },
                { artifactId: 'same-id', serverId: alpha.home.serverUrl },
                { artifactId: 'same-id', serverId: bravo.id },
                { artifactId: 'other-id' },
            ];
            expect(references.map(reference => isPromptLibraryReferenceInHome(reference, 'same-id', alpha.home.id)))
                .toEqual([true, true, true, false, false, false]);
            expect(isPromptLibraryReferenceInHome({ artifactId: 'same-id', serverId: alpha.home.id }, 'same-id'))
                .toBe(false);
        } finally { alpha.dispose(); }
    });
});
