import { describe, expect, it, vi } from 'vitest';
import { captureArtifactSignedInLinkSecret } from '@/utils/url/artifactSignedInLinkSecret';
import { resolveNativeAppLinkHref } from '@/utils/url/nativeAppLink';
import { takeNativeArtifactSignedInLinkSecret } from '@/utils/url/artifactSignedInLinkSecret';
import { redirectSystemPath } from '@/app/+native-intent';

describe('signed-in Artifact link fragment custody', () => {
    it('strips the initial Expo intent fragment before the native router receives it', async () => {
        const secret = 'd'.repeat(43);
        expect(redirectSystemPath({ path: `happier://share/artifact/initial-invite#k=${secret}`, initial: true }))
            .toBe('/share/artifact/initial-invite');
        expect(await takeNativeArtifactSignedInLinkSecret('initial-invite')?.consumeSecret('initial-invite')).toBe(secret);
    });
    it('hands a native fragment to the addressed opening surface once without putting it in its route', async () => {
        const secret = 'b'.repeat(43);
        expect(resolveNativeAppLinkHref(`happier://share/artifact/native-invite?server=https%3A%2F%2Fhome.test#k=${secret}`))
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
