import { readStoredContentPublicShareSecretV1 } from '@happier-dev/protocol/sharing/storedContentPublicShareV1';

/** The opening surface owns this single-use fragment; no Account or device store receives it. */
export function captureArtifactSignedInLinkSecret(input: Readonly<{
    lookupId: string;
    url: string;
    replaceUrl(path: string): void;
}>) {
    const { lookupId: addressedLookupId } = input;
    const url = new URL(input.url);
    input.replaceUrl(`${url.pathname}${url.search}`);
    let secret = readStoredContentPublicShareSecretV1(url.hash);
    return {
        consumeSecret: async (lookupId: string) => {
            if (lookupId !== addressedLookupId) return null;
            const captured = secret;
            secret = null;
            return captured;
        },
        dispose: () => { secret = null; },
    };
}

type CapturedSecret = ReturnType<typeof captureArtifactSignedInLinkSecret>;
let nativeOpening: Readonly<{ lookupId: string; captured: CapturedSecret }> | null = null;

/** The native URI codec strips fragments before routing; custody lasts only until that surface takes it. */
export function captureNativeArtifactSignedInLinkSecret(url: string, href: string): void {
    const path = new URL(href, 'https://native.invalid').pathname;
    const match = /\/share\/artifact\/([^/]+)\/?$/.exec(path);
    if (!match) return;
    let lookupId: string;
    try { lookupId = decodeURIComponent(match[1]!); } catch { return; }
    nativeOpening?.captured.dispose();
    nativeOpening = { lookupId, captured: captureArtifactSignedInLinkSecret({ lookupId, url, replaceUrl: () => {} }) };
}

export function takeNativeArtifactSignedInLinkSecret(lookupId: string): CapturedSecret | null {
    if (nativeOpening?.lookupId !== lookupId) return null;
    const captured = nativeOpening.captured;
    nativeOpening = null;
    return captured;
}
