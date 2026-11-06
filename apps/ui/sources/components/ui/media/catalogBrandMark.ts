import type { HostCatalogMark } from './HappierBrandMark';

type CatalogMarkInput = Readonly<{
    displayName: string;
    iconUrl?: string | null;
    iconDarkUrl?: string | null;
}>;

function imageSource(uri: string | null | undefined) {
    if (!uri) return undefined;
    // Catalog metadata grants neither local-file access nor URL credentials.
    // Image acquisition/decoding stays entirely with the existing platform host.
    try {
        const url = new URL(uri);
        return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
            ? Object.freeze({ uri: url.href }) : undefined;
    } catch {
        return undefined;
    }
}

/** Admission projection only: no probes, downloads, SVG work or retained cache. */
export function admitCatalogBrandMark(input: CatalogMarkInput, previous?: HostCatalogMark): HostCatalogMark {
    const light = imageSource(input.iconUrl);
    const dark = imageSource(input.iconDarkUrl);
    const sameSource = (left: typeof light, right: HostCatalogMark['light']) => left?.uri === (
        right && typeof right === 'object' && !Array.isArray(right) && 'uri' in right ? right.uri : undefined
    );
    if (previous && previous.displayName === input.displayName && !previous.bytes && !previous.monochrome
        && sameSource(light, previous.light) && sameSource(dark, previous.dark)) return previous;
    return Object.freeze({ displayName: input.displayName, ...(light ? { light } : {}), ...(dark ? { dark } : {}) });
}
