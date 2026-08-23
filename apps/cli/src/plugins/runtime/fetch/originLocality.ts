import { lookup } from 'node:dns/promises';

import {
    assessEndpointHostLocality,
    normalizeProviderEndpointUrlSyntax,
} from '@happier-dev/protocol';

/** DNS is a genuine system boundary; every caller may substitute it. */
export type PluginNetworkAddressResolver = (hostname: string) => Promise<readonly string[]>;

export const resolvePluginNetworkAddresses: PluginNetworkAddressResolver = async (hostname) => (
    (await lookup(hostname, { all: true, verbatim: true })).map((answer) => answer.address)
);

export type PluginNetworkOriginLocality = 'public' | 'private';

/**
 * The one private-network decision for a plugin network origin. It delegates to
 * the endpoint-locality owner in Protocol, so a literal address and a hostname's
 * resolved A/AAAA answers reach exactly the same classification: a name that
 * resolves inside a private, loopback or otherwise non-public range can never be
 * admitted as public. This is credential-routing correctness — a Connected
 * Account credential must not leave for a private destination under a grant that
 * never declared one — not a judgement about the plugin holding it.
 *
 * Every outcome the locality owner refuses to classify — an unresolvable name, a
 * cloud-metadata destination, an unsafe or malformed address — is `private`, so
 * an origin only ever escapes the private-network requirement on positive
 * evidence that it is public.
 */
export async function assessPluginNetworkOriginLocality(
    origin: string,
    options: Readonly<{ resolveAddresses?: PluginNetworkAddressResolver }> = {},
): Promise<PluginNetworkOriginLocality> {
    let syntax: ReturnType<typeof normalizeProviderEndpointUrlSyntax>;
    try {
        syntax = normalizeProviderEndpointUrlSyntax(origin);
    } catch {
        return 'private';
    }
    try {
        const resolvedAddresses = syntax.literalAddress
            ? undefined
            : await (options.resolveAddresses ?? resolvePluginNetworkAddresses)(syntax.hostname);
        const assessed = assessEndpointHostLocality({
            hostname: syntax.hostname,
            literalAddress: syntax.literalAddress,
            ...(resolvedAddresses ? { resolvedAddresses } : {}),
        });
        return assessed.locality === 'public' ? 'public' : 'private';
    } catch {
        return 'private';
    }
}

/**
 * Classifies a set of origins in one pass. Duplicates resolve once because a
 * scope and its fixed targets routinely name the same origin.
 */
export async function assessPluginNetworkOriginLocalities(
    origins: Iterable<string>,
    options: Readonly<{ resolveAddresses?: PluginNetworkAddressResolver }> = {},
): Promise<ReadonlyMap<string, PluginNetworkOriginLocality>> {
    const unique = [...new Set(origins)];
    const localities = await Promise.all(
        unique.map(async (origin) => await assessPluginNetworkOriginLocality(origin, options)),
    );
    return new Map(unique.map((origin, index) => [origin, localities[index] ?? 'private']));
}
