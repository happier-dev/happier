import { describe, expect, it, vi } from 'vitest';
import { captureArtifactSignedInLinkSecret } from '@/utils/url/artifactSignedInLinkSecret';
import { resolveNativeAppLinkHref } from '@/utils/url/nativeAppLink';
import { takeNativeArtifactSignedInLinkSecret } from '@/utils/url/artifactSignedInLinkSecret';
import { redirectSystemPath } from '@/app/+native-intent';

describe('signed-in Artifact link fragment custody', () => {
    it.each([
        'happier://share/artifact/intent-invite',
        'happier:///share/artifact/intent-invite',
        'https://home.test/share/artifact/intent-invite',
        '/share/artifact/intent-invite',
        'share/artifact/intent-invite',
    ].flatMap(path => [true, false].map(initial => ({ path, initial }))))(
        'keeps the key out of the routed URL for $path with initial=$initial', async ({ path, initial }) => {
            const secret = 'f'.repeat(43);
            const routed = redirectSystemPath({ path: `${path}?server=https%3A%2F%2Fhome.test#k=${secret}`, initial });
            expect(routed).toBe('/share/artifact/intent-invite?server=https%3A%2F%2Fhome.test');
            expect(routed).not.toContain(secret);
            expect(routed).not.toContain('#');
            const captured = takeNativeArtifactSignedInLinkSecret('intent-invite');
            expect(await captured?.consumeSecret('intent-invite')).toBe(secret);
            expect(takeNativeArtifactSignedInLinkSecret('intent-invite')).toBeNull();
            expect(await captured?.consumeSecret('intent-invite')).toBeNull();
        });
    it('strips an initial fragment even when its lookup id is malformed', () => {
        expect(redirectSystemPath({ path: `happier://share/artifact/%invalid#k=${'g'.repeat(43)}`, initial: true }))
            .toBe('/share/artifact/%invalid');
        expect(takeNativeArtifactSignedInLinkSecret('%invalid')).toBeNull();
    });
    it.each(['happier://share/artifact/native-invite', '/share/artifact/native-invite', 'share/artifact/native-invite'])(
        'hands %s to the addressed native opening once without putting the key in its route', async path => {
        const secret = 'b'.repeat(43);
        expect(resolveNativeAppLinkHref(`${path}?server=https%3A%2F%2Fhome.test#k=${secret}`))
            .toBe('/share/artifact/native-invite?server=https%3A%2F%2Fhome.test');
        expect(await takeNativeArtifactSignedInLinkSecret('other')?.consumeSecret('other')).toBeUndefined();
        const captured = takeNativeArtifactSignedInLinkSecret('native-invite');
        expect(await captured?.consumeSecret('native-invite')).toBe(secret);
        expect(takeNativeArtifactSignedInLinkSecret('native-invite')).toBeNull();
        expect(await captured?.consumeSecret('native-invite')).toBeNull();
    });

    it('removes the fragment synchronously and supplies it only once to the addressed join', async () => {
        const replaceUrl = vi.fn();
        const secret = 'a'.repeat(43);
        const captured = captureArtifactSignedInLinkSecret({ lookupId: 'invite',
            url: `https://home.test/share/artifact/invite#k=${secret}`, replaceUrl });
        expect(replaceUrl).toHaveBeenCalledWith('/share/artifact/invite');
        expect(await captured.consumeSecret('another-link')).toBeNull();
        expect(await captured.consumeSecret('invite')).toBe(secret);
        expect(await captured.consumeSecret('invite')).toBeNull();
    });

    it('clears unusable fragments and discards an unconsumed secret when the surface closes', async () => {
        const replaceUrl = vi.fn();
        const invalid = captureArtifactSignedInLinkSecret({ lookupId: 'invite',
            url: 'https://home.test/share/artifact/invite#k=bad', replaceUrl });
        expect(await invalid.consumeSecret('invite')).toBeNull();
        const captured = captureArtifactSignedInLinkSecret({ lookupId: 'invite',
            url: `https://home.test/share/artifact/invite#k=${'a'.repeat(43)}`, replaceUrl });
        captured.dispose();
        expect(await captured.consumeSecret('invite')).toBeNull();
    });
});
